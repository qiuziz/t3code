import type { AntigravitySettings, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

const SUMMARY_WINDOW_MINS = new Map([
  ["5h", 5 * 60],
  ["weekly", 7 * 24 * 60],
]);
const AUTO_CACHE_TTL_MS = 5 * 60 * 1000;
const FAIL_COOLDOWN_MS = 60 * 1000;
const MAX_CLI_OUTPUT_BYTES = 1024 * 1024;
const utf8Encoder = new TextEncoder();

// Strip ambient Google credentials and T3 launcher internals before spawning the official CLI.
const BLOCKED_CLI_ENV_KEYS = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "AGY_ADC_AUTH",
  "GEMINI_HOME",
  "SSH_CONNECTION",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "AGY_CLI_FORCE_FILE_TOKEN_STORAGE",
  "ELECTRON_RUN_AS_NODE",
  "CHROME_CRASHPAD_PIPE_NAME",
]);

const Quota = Schema.Struct({
  remainingFraction: Schema.optional(Schema.Number),
  resetTime: Schema.optional(Schema.String),
});
const AntigravityCliUsageErrorReason = Schema.Literals([
  "timed_out",
  "resolve_executable",
  "spawn_failed",
  "output_limit_exceeded",
  "invalid_output",
]);

export class AntigravityCliUsageError extends Schema.TaggedError<AntigravityCliUsageError>()(
  "AntigravityCliUsageError",
  {
    reason: AntigravityCliUsageErrorReason,
    executablePath: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "timed_out":
        return "The official Antigravity CLI did not answer in time.";
      case "resolve_executable":
        return "Could not resolve the configured Antigravity CLI executable.";
      case "spawn_failed":
        return "Could not launch the official Antigravity CLI.";
      case "output_limit_exceeded":
        return "Official Antigravity CLI output exceeded the safe buffer limit.";
      case "invalid_output":
        return "Official Antigravity CLI did not return a parseable /usage summary.";
    }
  }
}

function iso(value: string | undefined): string | undefined {
  const parsed = value ? DateTime.make(value) : Option.none();
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function quotaWindow(
  id: string,
  label: string,
  quota: typeof Quota.Type,
  kind: ServerProviderUsageWindow["kind"] = "other",
  windowDurationMins?: number,
): ServerProviderUsageWindow | undefined {
  if (quota.remainingFraction === undefined || !Number.isFinite(quota.remainingFraction)) {
    return undefined;
  }
  const resetsAt = iso(quota.resetTime);
  return {
    id,
    label,
    kind,
    usedPercent: (1 - Math.max(0, Math.min(1, quota.remainingFraction))) * 100,
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  };
}

const sha256 = Effect.fnUntraced(function* (text: string) {
  const digest = yield* (yield* Digest.Digest).digest(Digest.sha256, utf8Encoder.encode(text));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

/** Shared versioned email fingerprint so local CLI and hub readings pool into one account key. */
export const antigravityEmailFingerprint = (email: string) =>
  sha256(`google-account-email-v1\0${email.trim().toLowerCase()}`);

/** Reads the signed-in account from the profile's own token file (never from the shared keyring). */
export function antigravityTokenEmail(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const email = (parsed as { id_token_email?: unknown }).id_token_email;
    return typeof email === "string" && email.trim() ? email.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses `agy -p /usage --output-format json` into T3 usage windows. The official CLI owns the
 * sign-in and the request; T3 only reads its report and never touches OAuth tokens or Google's
 * internal endpoints.
 */
const CliUsageBucket = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
  remaining_fraction: Schema.optional(Schema.Number),
  reset_time: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
});
const CliUsageGroup = Schema.Struct({
  name: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  buckets: Schema.optional(Schema.Array(CliUsageBucket)),
});
const CliUsageReport = Schema.Struct({
  status: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  command: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      data: Schema.optional(
        Schema.Struct({
          groups: Schema.optional(Schema.Array(CliUsageGroup)),
          buckets: Schema.optional(Schema.Array(CliUsageBucket)),
        }),
      ),
    }),
  ),
});
const decodeCliUsageReport = Schema.decodeUnknownOption(Schema.fromJsonString(CliUsageReport));

export interface ParsedAntigravityCliUsage {
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly accountEmail?: string;
}

const CLI_WINDOW_KINDS = new Map<string, ServerProviderUsageWindow["kind"]>([
  ["weekly", "weekly"],
  ["5h", "session"],
]);

function cliQuotaFamily(id: string, fallback: string): string {
  if (id.startsWith("gemini-argon")) return "Gemini Argon";
  if (id.startsWith("gemini-carbon")) return "Gemini Carbon";
  if (id.startsWith("gemini-")) return "Gemini";
  if (id.startsWith("3p-")) return "Claude & GPT (shared)";
  return fallback;
}

export function parseAntigravityCliUsageOutput(
  rawOutput: string,
): ParsedAntigravityCliUsage | undefined {
  const decoded = decodeCliUsageReport(rawOutput);
  if (Option.isNone(decoded)) return undefined;
  const report = decoded.value;
  if (report.status?.trim().toUpperCase() === "ERROR") return undefined;
  const data = report.command?.data;
  const groups = data?.groups?.length ? data.groups : [{ buckets: data?.buckets }];
  const windows: ServerProviderUsageWindow[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const bucket of group.buckets ?? []) {
      if (bucket.disabled || seen.has(bucket.id)) continue;
      seen.add(bucket.id);
      const family = cliQuotaFamily(
        bucket.id,
        group.displayName?.trim() || group.name?.trim() || bucket.name?.trim() || bucket.id,
      );
      const window = quotaWindow(
        bucket.id,
        `${family} · ${bucket.window === "weekly" ? "Weekly" : bucket.window === "5h" ? "5-hour" : bucket.name?.trim() || "Quota"}`,
        { remainingFraction: bucket.remaining_fraction, resetTime: bucket.reset_time },
        CLI_WINDOW_KINDS.get(bucket.window ?? "") ?? "other",
        SUMMARY_WINDOW_MINS.get(bucket.window ?? ""),
      );
      if (window) windows.push(window);
    }
  }
  if (windows.length === 0) return undefined;
  const kindOrder: Record<ServerProviderUsageWindow["kind"], number> = {
    session: 0,
    weekly: 1,
    monthly: 2,
    other: 3,
  };
  const groupOrder = (id: string) => (id.startsWith("gemini-") ? 0 : id.startsWith("3p-") ? 1 : 2);
  windows.sort((left, right) => {
    const groupDiff = groupOrder(left.id) - groupOrder(right.id);
    if (groupDiff !== 0) return groupDiff;
    return (kindOrder[left.kind] ?? 9) - (kindOrder[right.kind] ?? 9);
  });
  return { windows };
}

export interface AntigravityCliUsageRunInput {
  readonly executablePath: string;
  readonly args?: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

export function buildAntigravityCliUsageEnv(
  baseEnv: NodeJS.ProcessEnv,
  options?: {
    readonly isolatedHome?: string;
    readonly isolatedGeminiHome?: string;
    readonly gcpProject?: string;
    readonly gcpLocation?: string;
  },
): NodeJS.ProcessEnv {
  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    // Windows treats environment variable names as case-insensitive.
    if (BLOCKED_CLI_ENV_KEYS.has(key.toUpperCase())) continue;
    cleanEnv[key] = value;
  }
  if (options?.isolatedHome !== undefined) {
    cleanEnv.HOME = options.isolatedHome;
    cleanEnv.USERPROFILE = options.isolatedHome;
  }
  // Keep GEMINI_HOME pointed strictly at the isolated empty config root so neither global nor
  // profile MCP servers or hooks can load during background usage reads.
  if (options?.isolatedGeminiHome !== undefined) {
    cleanEnv.GEMINI_HOME = options.isolatedGeminiHome;
  }
  if (options?.gcpProject) {
    cleanEnv.GOOGLE_CLOUD_PROJECT = options.gcpProject;
  }
  if (options?.gcpLocation) {
    cleanEnv.GOOGLE_CLOUD_LOCATION = options.gcpLocation;
  }
  cleanEnv.TERM = cleanEnv.TERM || "xterm-256color";
  return cleanEnv;
}

const IsolatedCliSettings = Schema.Struct({
  trustedWorkspaces: Schema.Array(Schema.String),
  onboardingComplete: Schema.Boolean,
  colorScheme: Schema.String,
});
const encodeIsolatedCliSettings = Schema.encodeSync(Schema.fromJsonString(IsolatedCliSettings));

/**
 * Creates a scoped, empty home directory with minimal onboarding state and empty MCP/hook configs
 * so background `/usage` probes never spawn configured global or profile MCP servers or hooks.
 */
const makeIsolatedCliHome = Effect.fn("AntigravityUsageProbe.makeIsolatedCliHome")(function* (
  executablePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.gen(function* () {
    const isolatedHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-usage-" });
    const isolatedGeminiHome = path.join(isolatedHome, ".gemini");
    const cliDir = path.join(isolatedGeminiHome, "antigravity-cli");
    const cfgDir = path.join(isolatedGeminiHome, "config");
    yield* fs.makeDirectory(cliDir, { recursive: true });
    yield* fs.makeDirectory(cfgDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(cliDir, "settings.json"),
      encodeIsolatedCliSettings({
        trustedWorkspaces: [isolatedHome],
        onboardingComplete: true,
        colorScheme: "terminal",
      }),
    );
    yield* fs.writeFileString(
      path.join(cliDir, "onboarding.json"),
      '{"onboardingComplete":true,"completed":true}',
    );
    yield* fs.writeFileString(path.join(cfgDir, "mcp_config.json"), '{"mcpServers":{}}');
    yield* fs.writeFileString(path.join(cfgDir, "hooks.json"), "{}");
    return { isolatedHome, isolatedGeminiHome, cliDir };
  }).pipe(
    Effect.mapError(
      (cause) =>
        new AntigravityCliUsageError({
          reason: "spawn_failed",
          executablePath,
          cause,
        }),
    ),
  );
});

const runOfficialAgyUsagePrint = Effect.fn("AntigravityUsageProbe.runOfficialAgyUsagePrint")(
  function* (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    input: AntigravityCliUsageRunInput,
  ) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.env)) {
      if (value !== undefined) env[key] = value;
    }
    const child = yield* spawner
      .spawn(
        ChildProcess.make(input.executablePath, [...(input.args ?? [])], {
          cwd: input.cwd,
          env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          // A CLI that ignores the timeout would otherwise hold the probe's scope open.
          forceKillAfter: "2 seconds",
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new AntigravityCliUsageError({
              reason: "spawn_failed",
              executablePath: input.executablePath,
              cause,
            }),
        ),
      );

    const collected = yield* Effect.all(
      [
        Stream.runFold(
          Stream.decodeText(child.stdout),
          () => ({ text: "", overflow: false }),
          (accumulator, chunk) =>
            accumulator.overflow || accumulator.text.length + chunk.length > MAX_CLI_OUTPUT_BYTES
              ? { text: accumulator.text, overflow: true }
              : { text: accumulator.text + chunk, overflow: false },
        ),
        child.exitCode,
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.timeoutOption("25 seconds"),
      Effect.mapError(
        (cause) =>
          new AntigravityCliUsageError({
            reason: "spawn_failed",
            executablePath: input.executablePath,
            cause,
          }),
      ),
    );
    if (Option.isNone(collected)) {
      return yield* new AntigravityCliUsageError({
        reason: "timed_out",
        executablePath: input.executablePath,
      });
    }
    const [{ text, overflow }, exitCode] = collected.value;
    if (overflow) {
      return yield* new AntigravityCliUsageError({
        reason: "output_limit_exceeded",
        executablePath: input.executablePath,
      });
    }
    if (exitCode !== 0) {
      return yield* new AntigravityCliUsageError({
        reason: "invalid_output",
        executablePath: input.executablePath,
      });
    }
    return text;
  },
);

export const makeAntigravityUsageProbe = Effect.fn("makeAntigravityUsageProbe")(function* (input: {
  readonly profileDirectory: string;
  readonly authMethod: AntigravitySettings["authMethod"];
  readonly gcpProject?: string;
  readonly gcpLocation?: string;
  readonly resolveExecutable?: Effect.Effect<string, AntigravityCliUsageError, Scope.Scope>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runCliUsage?: (
    args: AntigravityCliUsageRunInput,
  ) => Effect.Effect<string, AntigravityCliUsageError>;
  readonly spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Digest.Digest;
  const probeGate = yield* Semaphore.make(1);
  const cliTokenPath = path.join(
    input.profileDirectory,
    "antigravity-acp",
    "antigravity-oauth-token",
  );
  const spawner = input.spawner;
  const runCliUsage =
    input.runCliUsage ??
    ((args: AntigravityCliUsageRunInput) =>
      spawner === undefined
        ? Effect.fail(new AntigravityCliUsageError({ reason: "spawn_failed" }))
        : runOfficialAgyUsagePrint(spawner, args));

  let cached:
    | {
        readonly checkedAt: string;
        readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
        readonly credentialFingerprint?: string;
        readonly cachedAtMs: number;
      }
    | undefined;
  let lastAttemptAtMs = 0;
  let generation = 0;

  const formatCached = (entry: NonNullable<typeof cached>) => ({
    ...makeUsageLimits({ checkedAt: entry.checkedAt, windows: [...entry.windows] }),
    ...(entry.credentialFingerprint ? { credentialFingerprint: entry.credentialFingerprint } : {}),
  });

  const read = Effect.gen(function* () {
    const startedGeneration = generation;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (input.authMethod !== "oauth-personal" && input.authMethod !== "oauth-business") {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }

    const nowMs = yield* Clock.currentTimeMillis;

    // 1. Fresh cache hit: preserve the original checkedAt timestamp.
    if (cached !== undefined && nowMs - cached.cachedAtMs < AUTO_CACHE_TTL_MS) {
      return formatCached(cached);
    }

    // 2. Cooldown after a recent failed attempt (prevents rapid-fire CLI relaunches on error).
    if (lastAttemptAtMs > 0 && nowMs - lastAttemptAtMs < FAIL_COOLDOWN_MS) {
      if (cached !== undefined) {
        return formatCached(cached);
      }
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Could not read Antigravity limits. Refresh provider status to retry.",
      });
    }

    // Personal OAuth profiles isolate sign-ins per profile directory via file token storage;
    // do not fall through to a standalone host sign-in when the profile is unsigned-in.
    // Enterprise (`oauth-business`) instances do not force file storage and may keep credentials
    // exclusively in the OS keyring, so allow them to probe with their configured project.
    if (input.authMethod === "oauth-personal") {
      const hasProfileToken = yield* fs
        .exists(cliTokenPath)
        .pipe(Effect.orElseSucceed(() => false));
      if (!hasProfileToken) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "Sign in with Google to see Antigravity limits.",
        });
      }
    }

    const cliResult = yield* Effect.scoped(
      Effect.gen(function* () {
        // Hold any installation lease and isolated home through CLI exit.
        const executablePath = input.resolveExecutable ? yield* input.resolveExecutable : "agy";
        const { isolatedHome, isolatedGeminiHome, cliDir } =
          yield* makeIsolatedCliHome(executablePath);
        // The CLI reads credentials from $HOME/.gemini/<app-data-dir>/antigravity-oauth-token and
        // prefers the OS keyring unless file storage is forced. Copying the profile's own token
        // keeps each instance on its own account and never writes the shared keyring.
        const isolatedTokenPath = path.join(cliDir, "antigravity-oauth-token");
        const profileToken =
          input.authMethod === "oauth-personal"
            ? yield* fs.readFileString(cliTokenPath).pipe(Effect.orElseSucceed(() => undefined))
            : undefined;
        if (profileToken !== undefined) {
          yield* fs.writeFileString(isolatedTokenPath, profileToken);
        }
        const cleanEnv = buildAntigravityCliUsageEnv(input.environment ?? process.env, {
          isolatedHome,
          isolatedGeminiHome,
          ...(input.authMethod === "oauth-business" && input.gcpProject
            ? { gcpProject: input.gcpProject }
            : {}),
          ...(input.authMethod === "oauth-business" && input.gcpLocation
            ? { gcpLocation: input.gcpLocation }
            : {}),
        });
        if (input.authMethod === "oauth-personal") {
          cleanEnv.AGY_CLI_FORCE_FILE_TOKEN_STORAGE = "1";
        }
        // agy's troubleshooting docs specify "true"; the interactive CLI keeps self-updating with "1".
        cleanEnv.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
        const cliArgs = [
          "-p",
          "/usage",
          "--output-format",
          "json",
          ...(input.authMethod === "oauth-business" && input.gcpProject
            ? ["--project", input.gcpProject]
            : []),
        ];
        const output = yield* runCliUsage({
          executablePath,
          args: cliArgs,
          env: cleanEnv,
          cwd: isolatedHome,
        });
        // The CLI refreshes expired tokens in place; carry that back so the profile stays signed in.
        const refreshedToken =
          profileToken === undefined
            ? undefined
            : yield* fs
                .readFileString(isolatedTokenPath)
                .pipe(Effect.orElseSucceed(() => undefined));
        if (refreshedToken !== undefined && refreshedToken !== profileToken) {
          yield* fs
            .writeFileString(cliTokenPath, refreshedToken)
            .pipe(Effect.orElseSucceed(() => undefined));
        }
        return { output, refreshedToken };
      }),
    ).pipe(
      Effect.tapError(() =>
        Effect.gen(function* () {
          if (generation === startedGeneration) {
            lastAttemptAtMs = yield* Clock.currentTimeMillis;
          }
        }),
      ),
    );

    const parsedAtMs = yield* Clock.currentTimeMillis;
    const observedAt = DateTime.formatIso(DateTime.makeUnsafe(parsedAtMs));
    const parsed = parseAntigravityCliUsageOutput(cliResult.output);
    if (!parsed || parsed.windows.length === 0) {
      if (generation === startedGeneration) {
        lastAttemptAtMs = parsedAtMs;
      }
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Official Antigravity CLI did not return usable quota information.",
      });
    }

    const accountEmail = antigravityTokenEmail(cliResult.refreshedToken);
    const credentialFingerprint = accountEmail
      ? yield* antigravityEmailFingerprint(accountEmail)
      : undefined;

    if (generation === startedGeneration) {
      cached = {
        checkedAt: observedAt,
        windows: parsed.windows,
        ...(credentialFingerprint ? { credentialFingerprint } : {}),
        cachedAtMs: parsedAtMs,
      };
      lastAttemptAtMs = 0;
    }

    return {
      ...makeUsageLimits({ checkedAt: observedAt, windows: [...parsed.windows] }),
      ...(credentialFingerprint ? { credentialFingerprint } : {}),
    };
  });

  const probe = probeGate
    .withPermits(1)(read)
    .pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Digest.Digest, crypto),
      Effect.timeout("30 seconds"),
      Effect.catch(() =>
        Effect.gen(function* () {
          if (cached !== undefined) {
            return formatCached(cached);
          }
          return makeUnavailableUsageLimits({
            checkedAt: DateTime.formatIso(yield* DateTime.now),
            reason: "probeFailed",
            message: "Could not read Antigravity limits. Refresh provider status to retry.",
          });
        }),
      ),
    );

  return {
    probe,
    clear: Effect.sync(() => {
      generation++;
      cached = undefined;
      lastAttemptAtMs = 0;
    }),
  };
});
