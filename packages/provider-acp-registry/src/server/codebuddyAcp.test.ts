import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "../settings.ts";
import { isCodeBuddyAgent, sendCodeBuddySteer } from "./adapter.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

type Runtime = Parameters<typeof sendCodeBuddySteer>[0];

function fakeRuntime(result: unknown) {
  const calls: Array<{ method: string; payload: unknown }> = [];
  const runtime = {
    request: (method: string, payload: unknown) => {
      calls.push({ method, payload });
      return Effect.succeed(result);
    },
  } as unknown as Runtime;
  return { runtime, calls };
}

describe("isCodeBuddyAgent", () => {
  it("recognises a local cbc wrapper", () => {
    expect(
      isCodeBuddyAgent(
        decodeSettings({ source: "local", commandPath: "/Users/me/.local/bin/cbc" }),
      ),
    ).toBe(true);
  });

  it("recognises a local codebuddy binary and a registry entry", () => {
    expect(
      isCodeBuddyAgent(decodeSettings({ source: "local", commandPath: "/opt/bin/codebuddy" })),
    ).toBe(true);
    expect(isCodeBuddyAgent(decodeSettings({ agentId: "codebuddy" }))).toBe(true);
  });

  it("leaves other agents alone", () => {
    expect(
      isCodeBuddyAgent(decodeSettings({ source: "local", commandPath: "/opt/bin/opencode" })),
    ).toBe(false);
    expect(isCodeBuddyAgent(decodeSettings({ agentId: "devin" }))).toBe(false);
  });
});

describe("sendCodeBuddySteer", () => {
  it.effect("sends session/steer with the text and any image blocks", () =>
    Effect.gen(function* () {
      const { runtime, calls } = fakeRuntime({ steered: true, ownerRequestId: "req-1" });
      const images = [{ type: "image", data: "AAAA", mimeType: "image/png" }] as const;

      const steerId = yield* sendCodeBuddySteer(runtime, "session-1", "stop now", [...images]);

      // CodeBuddy answers with the owner request id, not a steer id to wait on.
      expect(steerId).toBeUndefined();
      expect(calls).toEqual([
        {
          method: "session/steer",
          payload: {
            sessionId: "session-1",
            contentBlocks: [{ type: "text", text: "stop now" }, ...images],
          },
        },
      ]);
    }),
  );

  it.effect("fails when CodeBuddy declines the steer so it queues as a follow-up", () =>
    Effect.gen(function* () {
      const { runtime } = fakeRuntime({ steered: false, reason: "idle" });

      const error = yield* Effect.flip(sendCodeBuddySteer(runtime, "session-1", "stop", []));

      expect(error._tag).toBe("AcpTransportError");
    }),
  );
});
