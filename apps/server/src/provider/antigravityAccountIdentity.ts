import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// agy writes the resolved sign-in to its own log; a different address means the session
// authenticated from the shared keyring instead of this provider's token file.
const AUTH_EMAIL_PATTERN = /applyAuthResult: email=([^\s,]+)/g;
const ACP_LOG_PREFIX = "acp-server-";
const ACP_LOG_SUFFIX = ".log";
const MAX_LOG_TAIL_CHARS = 256 * 1024;

export function parseAntigravityAuthEmail(output: string): string | undefined {
  let email: string | undefined;
  for (const match of output.matchAll(AUTH_EMAIL_PATTERN)) {
    const candidate = match[1]?.trim();
    if (candidate) email = candidate;
  }
  return email;
}

/**
 * Reads the account the newest ACP process authenticated as. Log names carry a fixed-width
 * timestamp, so the newest session sorts first without a stat call per file.
 */
export const readAntigravityAcpLogEmail = Effect.fn("readAntigravityAcpLogEmail")(
  function* (input: { readonly logDirectory: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* fs
      .readDirectory(input.logDirectory)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    const newest = names
      .filter((name) => name.startsWith(ACP_LOG_PREFIX) && name.endsWith(ACP_LOG_SUFFIX))
      .sort()
      .at(-1);
    if (newest === undefined) return undefined;
    const output = yield* fs
      .readFileString(path.join(input.logDirectory, newest))
      .pipe(Effect.orElseSucceed(() => ""));
    return parseAntigravityAuthEmail(output.slice(-MAX_LOG_TAIL_CHARS));
  },
);
