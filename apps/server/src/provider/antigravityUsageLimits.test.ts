import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import {
  AntigravityCliUsageError,
  antigravityEmailFingerprint,
  antigravityTokenEmail,
  buildAntigravityCliUsageEnv,
  makeAntigravityUsageProbe,
  parseAntigravityCliUsageOutput,
  type AntigravityCliUsageRunInput,
} from "./antigravityUsageLimits.ts";

const SAMPLE_CLI_JSON = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t91.26%\t2026-11-30T15:19:00Z",
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.9126,
              reset_time: "2026-11-30T15:19:00Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.9589,
              reset_time: "2026-11-24T21:17:00Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "2026-11-29T12:54:00Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "2026-11-24T22:00:00Z",
            },
          ],
        },
      ],
    },
  },
});

const SECOND_ACCOUNT_CLI_JSON = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "",
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.5,
              reset_time: "2026-11-24T19:00:00Z",
            },
          ],
        },
      ],
    },
  },
});

const isoAt = (epochMs: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMs));

const tokenFile = (email: string) =>
  JSON.stringify({
    token: {
      access_token: "access",
      token_type: "Bearer",
      refresh_token: "refresh",
      expiry: "2026-11-24T18:00:00+08:00",
      expires_in: 3599,
    },
    auth_method: "consumer",
    id_token_email: email,
  });

const createProfileWithCliToken = Effect.fn("AntigravityUsageTest.createProfileWithCliToken")(
  function* (email = "user@example.com") {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const profileDirectory = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(profileDirectory, "antigravity-acp"));
    yield* fs.writeFileString(
      path.join(profileDirectory, "antigravity-acp", "antigravity-oauth-token"),
      tokenFile(email),
    );
    return profileDirectory;
  },
);

const profileTokenPath = (path: Path.Path, profileDirectory: string) =>
  path.join(profileDirectory, "antigravity-acp", "antigravity-oauth-token");

describe("parseAntigravityCliUsageOutput", () => {
  it("parses official JSON groups, ordering 5-hour before Weekly and mapping remaining fractions", () => {
    const parsed = parseAntigravityCliUsageOutput(SAMPLE_CLI_JSON);
    expect(parsed).toBeDefined();
    expect(parsed?.windows).toEqual([
      {
        id: "gemini-5h",
        label: "Gemini · 5-hour",
        kind: "session",
        usedPercent: (1 - 0.9589) * 100,
        windowDurationMins: 300,
        resetsAt: "2026-11-24T21:17:00.000Z",
      },
      {
        id: "gemini-weekly",
        label: "Gemini · Weekly",
        kind: "weekly",
        usedPercent: (1 - 0.9126) * 100,
        windowDurationMins: 10080,
        resetsAt: "2026-11-30T15:19:00.000Z",
      },
      {
        id: "3p-5h",
        label: "Claude & GPT (shared) · 5-hour",
        kind: "session",
        usedPercent: 0,
        windowDurationMins: 300,
        resetsAt: "2026-11-24T22:00:00.000Z",
      },
      {
        id: "3p-weekly",
        label: "Claude & GPT (shared) · Weekly",
        kind: "weekly",
        usedPercent: 0,
        windowDurationMins: 10080,
        resetsAt: "2026-11-29T12:54:00.000Z",
      },
    ]);
  });

  it("skips disabled and duplicate buckets", () => {
    const parsed = parseAntigravityCliUsageOutput(
      JSON.stringify({
        status: "SUCCESS",
        command: {
          data: {
            groups: [
              {
                buckets: [
                  { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.5 },
                  { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.1 },
                  { id: "gemini-5h", window: "5h", remaining_fraction: 0.2, disabled: true },
                ],
              },
            ],
          },
        },
      }),
    );
    expect(parsed?.windows).toEqual([
      {
        id: "gemini-weekly",
        label: "Gemini · Weekly",
        kind: "weekly",
        usedPercent: 50,
        windowDurationMins: 10080,
      },
    ]);
  });

  it("returns undefined for error statuses, unparseable output, and empty reports", () => {
    expect(
      parseAntigravityCliUsageOutput(
        JSON.stringify({ status: "ERROR", error: "authentication failed or timed out" }),
      ),
    ).toBeUndefined();
    expect(parseAntigravityCliUsageOutput("Antigravity CLI 1.5.17")).toBeUndefined();
    expect(
      parseAntigravityCliUsageOutput(JSON.stringify({ status: "SUCCESS", command: { data: {} } })),
    ).toBeUndefined();
  });
});

describe("antigravityEmailFingerprint / antigravityTokenEmail", () => {
  it.effect("normalizes email casing and whitespace into a stable fingerprint", () =>
    Effect.gen(function* () {
      const fingerprint = yield* antigravityEmailFingerprint(" User@Example.com ");
      const same = yield* antigravityEmailFingerprint("user@example.com");
      expect(fingerprint).toBe(same);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it("reads the signed-in account from the profile token file without touching the keyring", () => {
    expect(antigravityTokenEmail(tokenFile("user@example.com"))).toBe("user@example.com");
    expect(antigravityTokenEmail("not json")).toBeUndefined();
    expect(antigravityTokenEmail(undefined)).toBeUndefined();
    expect(antigravityTokenEmail(JSON.stringify({ token: {} }))).toBeUndefined();
  });
});

describe("buildAntigravityCliUsageEnv", () => {
  it("strips ambient Google/ADC credentials and launcher internals case-insensitively", () => {
    const cleaned = buildAntigravityCliUsageEnv(
      {
        PATH: "/usr/local/bin",
        GEMINI_API_KEY: "ambient-gemini-key",
        google_api_key: "ambient-google-key",
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/creds.json",
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        GOOGLE_CLOUD_PROJECT: "ambient-project",
        AGY_ADC_AUTH: "true",
        agy_adc_auth: "1",
        GEMINI_HOME: "/persistent/profile",
        SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0",
        AGY_ACP_FORCE_FILE_STORAGE: "1",
        AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1",
        ELECTRON_RUN_AS_NODE: "1",
      },
      {
        isolatedHome: "/tmp/iso-home",
        isolatedGeminiHome: "/tmp/iso-home/.gemini",
        gcpProject: "configured-project",
        gcpLocation: "us-central1",
      },
    );
    expect(cleaned).toEqual({
      PATH: "/usr/local/bin",
      HOME: "/tmp/iso-home",
      USERPROFILE: "/tmp/iso-home",
      GEMINI_HOME: "/tmp/iso-home/.gemini",
      GOOGLE_CLOUD_PROJECT: "configured-project",
      GOOGLE_CLOUD_LOCATION: "us-central1",
      TERM: "xterm-256color",
    });
  });
});

describe("makeAntigravityUsageProbe (official CLI)", () => {
  it.effect(
    "caches for 5m while preserving checkedAt, isolates HOME with empty MCP/hooks, forces file token storage, and holds the executable lease",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const startMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T17:00:00Z"));
        yield* TestClock.setTime(startMs);
        const profileDirectory = yield* createProfileWithCliToken();
        const invocations: AntigravityCliUsageRunInput[] = [];
        let leaseReleasedDuringRun = false;
        let leaseReleasedAfterRun = false;

        const usage = yield* makeAntigravityUsageProbe({
          profileDirectory,
          authMethod: "oauth-personal",
          platform: "linux",
          resolveExecutable: Effect.acquireRelease(Effect.succeed("/usr/local/bin/agy"), () =>
            Effect.sync(() => {
              leaseReleasedAfterRun = true;
            }),
          ),
          environment: {
            PATH: "/usr/local/bin",
            ELECTRON_RUN_AS_NODE: "1",
            GEMINI_API_KEY: "must-be-stripped",
            AGY_ADC_AUTH: "true",
          },
          runCliUsage: (args) =>
            Effect.gen(function* () {
              invocations.push(args);
              leaseReleasedDuringRun = leaseReleasedAfterRun;
              const isolatedGemini = args.env.GEMINI_HOME ?? "";
              expect(isolatedGemini).toBe(path.join(args.cwd, ".gemini"));
              const mcpConfig = yield* fs
                .readFileString(path.join(isolatedGemini, "config", "mcp_config.json"))
                .pipe(Effect.orElseSucceed(() => ""));
              const hooksConfig = yield* fs
                .readFileString(path.join(isolatedGemini, "config", "hooks.json"))
                .pipe(Effect.orElseSucceed(() => ""));
              expect(mcpConfig).toBe('{"mcpServers":{}}');
              expect(hooksConfig).toBe("{}");
              // The profile's own token is copied into the isolated home; the keyring is untouched.
              const isolatedToken = yield* fs
                .readFileString(
                  path.join(isolatedGemini, "antigravity-cli", "antigravity-oauth-token"),
                )
                .pipe(Effect.orElseSucceed(() => ""));
              expect(antigravityTokenEmail(isolatedToken)).toBe("user@example.com");
              return SAMPLE_CLI_JSON;
            }),
        });

        const first = yield* usage.probe;
        const expectedFingerprint = yield* antigravityEmailFingerprint("user@example.com");
        expect(invocations).toHaveLength(1);
        expect(leaseReleasedDuringRun).toBe(false);
        expect(leaseReleasedAfterRun).toBe(true);
        expect(invocations[0]?.executablePath).toBe("/usr/local/bin/agy");
        expect(invocations[0]?.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
        expect(invocations[0]?.env.GEMINI_API_KEY).toBeUndefined();
        expect(invocations[0]?.env.AGY_ADC_AUTH).toBeUndefined();
        expect(invocations[0]?.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe("1");
        expect(invocations[0]?.env.HOME).toBe(invocations[0]?.cwd);
        expect(invocations[0]?.env.GEMINI_HOME).not.toBe(profileDirectory);
        expect(invocations[0]?.args).toEqual(["-p", "/usage", "--output-format", "json"]);
        expect(first.unavailable).toBeUndefined();
        expect(first.windows).toHaveLength(4);
        expect(first.credentialFingerprint).toBe(expectedFingerprint);
        expect(first.checkedAt).toBe(isoAt(startMs));

        // Within 5 minutes: served from cache with original checkedAt preserved.
        yield* TestClock.adjust("2 minutes");
        const cached = yield* usage.probe;
        expect(invocations).toHaveLength(1);
        expect(cached.checkedAt).toBe(first.checkedAt);

        // After 5 minutes: cache expires and probes fresh data.
        yield* TestClock.adjust("4 minutes");
        const refreshed = yield* usage.probe;
        expect(invocations).toHaveLength(2);
        expect(refreshed.checkedAt).toBe(isoAt(startMs + 6 * 60_000));
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect(
    "isolates HOME on macOS for oauth-personal so agy -p /usage reads the profile file token",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profileDirectory = yield* createProfileWithCliToken("personal@example.com");
        const invocations: AntigravityCliUsageRunInput[] = [];

        const usage = yield* makeAntigravityUsageProbe({
          profileDirectory,
          authMethod: "oauth-personal",
          platform: "darwin",
          environment: { PATH: "/usr/local/bin", HOME: "/Users/example" },
          resolveExecutable: Effect.succeed("/usr/local/bin/agy"),
          runCliUsage: (args) =>
            Effect.gen(function* () {
              invocations.push(args);
              const isolatedToken = yield* fs
                .readFileString(
                  path.join(
                    args.env.HOME ?? "",
                    ".gemini",
                    "antigravity-cli",
                    "antigravity-oauth-token",
                  ),
                )
                .pipe(Effect.orElseSucceed(() => ""));
              expect(antigravityTokenEmail(isolatedToken)).toBe("personal@example.com");
              return SAMPLE_CLI_JSON;
            }),
        });

        yield* usage.probe;
        expect(invocations).toHaveLength(1);
        expect(invocations[0]?.env.HOME).toBe(invocations[0]?.cwd);
        expect(invocations[0]?.env.HOME).not.toBe("/Users/example");
        expect(invocations[0]?.env.GEMINI_HOME).toBe(path.join(invocations[0]!.cwd, ".gemini"));
        expect(invocations[0]?.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe("1");
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("keeps the real home on macOS for oauth-business so the login keychain resolves", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      const invocations: AntigravityCliUsageRunInput[] = [];

      const usage = yield* makeAntigravityUsageProbe({
        profileDirectory,
        authMethod: "oauth-business",
        platform: "darwin",
        gcpProject: "enterprise-proj",
        environment: { PATH: "/usr/local/bin", HOME: "/Users/example" },
        resolveExecutable: Effect.succeed("/usr/local/bin/agy"),
        runCliUsage: (args) =>
          Effect.sync(() => {
            invocations.push(args);
            return SAMPLE_CLI_JSON;
          }),
      });

      yield* usage.probe;
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.env.HOME).toBe("/Users/example");
      expect(invocations[0]?.env.GEMINI_HOME).not.toBe(profileDirectory);
      expect(invocations[0]?.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect(
    "invalidateCache bypasses the 5m TTL while keeping the last good reading on transient failure",
    () =>
      Effect.gen(function* () {
        const startMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T17:00:00Z"));
        yield* TestClock.setTime(startMs);
        const profileDirectory = yield* createProfileWithCliToken();
        let calls = 0;
        let mode: "first" | "second" | "fail" = "first";

        const usage = yield* makeAntigravityUsageProbe({
          profileDirectory,
          authMethod: "oauth-personal",
          runCliUsage: () => {
            calls++;
            if (mode === "fail") {
              return Effect.fail(new AntigravityCliUsageError({ reason: "timed_out" }));
            }
            return Effect.succeed(mode === "first" ? SAMPLE_CLI_JSON : SECOND_ACCOUNT_CLI_JSON);
          },
        });

        const initial = yield* usage.probe;
        expect(calls).toBe(1);
        expect(initial.windows).toHaveLength(4);

        yield* TestClock.adjust("10 seconds");
        mode = "second";
        yield* usage.invalidateCache;
        const refreshed = yield* usage.probe;
        expect(calls).toBe(2);
        expect(refreshed.windows[0]?.usedPercent).toBe(50);

        yield* TestClock.adjust("10 seconds");
        mode = "fail";
        yield* usage.invalidateCache;
        const fallback = yield* usage.probe;
        expect(calls).toBe(3);
        expect(fallback.unavailable).toBeUndefined();
        expect(fallback.windows[0]?.usedPercent).toBe(50);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("writes a token refreshed by the CLI back to the profile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profileDirectory = yield* createProfileWithCliToken("before@example.com");
      let ran = 0;

      const usage = yield* makeAntigravityUsageProbe({
        profileDirectory,
        authMethod: "oauth-personal",
        runCliUsage: (args) =>
          Effect.gen(function* () {
            ran++;
            const tokenPath = path.join(
              args.cwd,
              ".gemini",
              "antigravity-cli",
              "antigravity-oauth-token",
            );
            yield* fs.writeFileString(tokenPath, tokenFile("after@example.com")).pipe(Effect.orDie);
            return SAMPLE_CLI_JSON;
          }),
      });

      const limits = yield* usage.probe;
      expect(ran).toBe(1);
      const stored = yield* fs.readFileString(profileTokenPath(path, profileDirectory));
      expect(antigravityTokenEmail(stored)).toBe("after@example.com");
      expect(limits.credentialFingerprint).toBe(
        yield* antigravityEmailFingerprint("after@example.com"),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("deduplicates concurrent probe calls so only one CLI process runs", () =>
    Effect.gen(function* () {
      const startMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T17:00:00Z"));
      yield* TestClock.setTime(startMs);
      const profileDirectory = yield* createProfileWithCliToken();
      const gate = yield* Deferred.make<void>();
      let calls = 0;

      const usage = yield* makeAntigravityUsageProbe({
        profileDirectory,
        authMethod: "oauth-personal",
        runCliUsage: () =>
          Effect.gen(function* () {
            calls++;
            yield* Deferred.await(gate);
            return SAMPLE_CLI_JSON;
          }),
      });

      const firstFiber = yield* Effect.forkChild(usage.probe);
      const secondFiber = yield* Effect.forkChild(usage.probe);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);

      const [first, second] = yield* Effect.all([Fiber.join(firstFiber), Fiber.join(secondFiber)]);
      expect(calls).toBe(1);
      expect(first.unavailable).toBeUndefined();
      expect(second.unavailable).toBeUndefined();
      expect(second.checkedAt).toBe(first.checkedAt);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect(
    "allows keyring-only oauth-business instances (without plaintext token file) and forwards GCP project/location",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profileDirectory = yield* fs.makeTempDirectoryScoped();
        const invocations: AntigravityCliUsageRunInput[] = [];

        const usage = yield* makeAntigravityUsageProbe({
          profileDirectory,
          authMethod: "oauth-business",
          gcpProject: "enterprise-proj",
          gcpLocation: "us-central1",
          runCliUsage: (args) => {
            invocations.push(args);
            return Effect.succeed(SAMPLE_CLI_JSON);
          },
        });

        const limits = yield* usage.probe;
        expect(limits.unavailable).toBeUndefined();
        expect(invocations).toHaveLength(1);
        expect(invocations[0]?.args).toEqual([
          "-p",
          "/usage",
          "--output-format",
          "json",
          "--project",
          "enterprise-proj",
        ]);
        expect(invocations[0]?.env.GOOGLE_CLOUD_PROJECT).toBe("enterprise-proj");
        expect(invocations[0]?.env.GOOGLE_CLOUD_LOCATION).toBe("us-central1");
        // Enterprise accounts keep OS-keyring sign-ins, so file storage is not forced there.
        expect(invocations[0]?.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBeUndefined();
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("discards cached quota immediately on clear() when switching accounts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const startMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T17:00:00Z"));
      yield* TestClock.setTime(startMs);
      const profileDirectory = yield* createProfileWithCliToken("first@example.com");
      let currentOutput = SAMPLE_CLI_JSON;
      let calls = 0;

      const usage = yield* makeAntigravityUsageProbe({
        profileDirectory,
        authMethod: "oauth-personal",
        runCliUsage: () => {
          calls++;
          return Effect.succeed(currentOutput);
        },
      });

      const accountA = yield* usage.probe;
      expect(calls).toBe(1);

      yield* TestClock.adjust("20 seconds");
      currentOutput = SECOND_ACCOUNT_CLI_JSON;
      yield* fs.writeFileString(
        profileTokenPath(path, profileDirectory),
        tokenFile("second@example.com"),
      );
      yield* usage.clear;

      const accountB = yield* usage.probe;
      expect(calls).toBe(2);
      expect(accountB.credentialFingerprint).not.toBe(accountA.credentialFingerprint);
      expect(accountB.windows[0]?.usedPercent).toBe(50);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("applies a 60s cooldown floor after failed attempts without re-spawning the CLI", () =>
    Effect.gen(function* () {
      const startMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T17:00:00Z"));
      yield* TestClock.setTime(startMs);
      const profileDirectory = yield* createProfileWithCliToken();
      let calls = 0;

      const usage = yield* makeAntigravityUsageProbe({
        profileDirectory,
        authMethod: "oauth-personal",
        runCliUsage: () => {
          calls++;
          return Effect.fail(new AntigravityCliUsageError({ reason: "spawn_failed" }));
        },
      });

      const first = yield* usage.probe;
      expect(calls).toBe(1);
      expect(first.unavailable?.reason).toBe("probeFailed");

      yield* TestClock.adjust("20 seconds");
      const second = yield* usage.probe;
      expect(calls).toBe(1);
      expect(second.unavailable?.reason).toBe("probeFailed");

      yield* TestClock.adjust("45 seconds");
      yield* usage.probe;
      expect(calls).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("does not fall back to PATH agy when resolveExecutable rejects the binary", () =>
    Effect.gen(function* () {
      const profileDirectory = yield* createProfileWithCliToken();
      let calls = 0;

      const usage = yield* makeAntigravityUsageProbe({
        profileDirectory,
        authMethod: "oauth-personal",
        resolveExecutable: Effect.fail(
          new AntigravityCliUsageError({ reason: "resolve_executable" }),
        ),
        runCliUsage: () => {
          calls++;
          return Effect.succeed(SAMPLE_CLI_JSON);
        },
      });

      const limits = yield* usage.probe;
      expect(calls).toBe(0);
      expect(limits.unavailable?.reason).toBe("probeFailed");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect(
    "returns unsupported without launching CLI for an unsigned-in oauth-personal profile",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profileDirectory = yield* fs.makeTempDirectoryScoped();
        let calls = 0;

        const usage = yield* makeAntigravityUsageProbe({
          profileDirectory,
          authMethod: "oauth-personal",
          runCliUsage: () => {
            calls++;
            return Effect.succeed(SAMPLE_CLI_JSON);
          },
        });

        const limits = yield* usage.probe;
        expect(calls).toBe(0);
        expect(limits.unavailable?.reason).toBe("unsupported");
        expect(limits.windows).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("returns unsupported for API key auth without invoking the CLI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      let calls = 0;

      const usage = yield* makeAntigravityUsageProbe({
        profileDirectory,
        authMethod: "gemini-api-key",
        runCliUsage: () => {
          calls++;
          return Effect.succeed(SAMPLE_CLI_JSON);
        },
      });

      const limits = yield* usage.probe;
      expect(calls).toBe(0);
      expect(limits.unavailable?.reason).toBe("unsupported");
      expect(limits.windows).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
