import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  antigravityTokenEmail,
  parseAntigravityAuthEmail,
  readAntigravityAcpLogEmail,
} from "./antigravityAccountIdentity.ts";

describe("antigravityTokenEmail", () => {
  it("reads the account recorded in a profile token file", () => {
    expect(antigravityTokenEmail(JSON.stringify({ id_token_email: "user@example.com" }))).toBe(
      "user@example.com",
    );
  });

  it("ignores malformed tokens", () => {
    expect(antigravityTokenEmail(undefined)).toBeUndefined();
    expect(antigravityTokenEmail("not json")).toBeUndefined();
    expect(antigravityTokenEmail(JSON.stringify({ token: {} }))).toBeUndefined();
  });
});

describe("parseAntigravityAuthEmail", () => {
  it("reads the last account agy authenticated as", () => {
    expect(
      parseAntigravityAuthEmail(
        "applyAuthResult: email=first@example.com, authMethod=consumer\napplyAuthResult: email=second@example.com, authMethod=consumer\n",
      ),
    ).toBe("second@example.com");
  });

  it("ignores output without an authentication line", () => {
    expect(parseAntigravityAuthEmail("You are not logged into Antigravity.")).toBeUndefined();
  });
});

it.effect("reads the newest ACP log's account", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const logDirectory = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(
      path.join(logDirectory, "acp-server-20261126_180000-1.log"),
      "applyAuthResult: email=older@example.com, authMethod=consumer\n",
    );
    yield* fs.writeFileString(
      path.join(logDirectory, "acp-server-20261126_190000-2.log"),
      "applyAuthResult: email=newer@example.com, authMethod=consumer\n",
    );
    expect(yield* readAntigravityAcpLogEmail({ logDirectory })).toBe("newer@example.com");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
