import { describe, expect, it } from "@effect/vitest";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderDriverKind, ProviderThreadId, ProviderTurnId } from "@t3tools/contracts";

import { AcpSteerDeclined, acpSteerTurnError } from "./adapter.ts";

const driver = ProviderDriverKind.make("acpRegistry");
const providerThreadId = ProviderThreadId.make("provider-thread:1");
const providerTurnId = ProviderTurnId.make("provider-turn:1");
const context = { driver, providerThreadId, providerTurnId };

describe("acpSteerTurnError", () => {
  it("keeps a declined steer as declined so the orchestrator queues it as a follow-up", () => {
    const declined = new ProviderAdapter.ProviderAdapterSteerDeclinedError(context);
    expect(acpSteerTurnError({ ...context, cause: declined })).toBe(declined);
  });

  it("keeps an unsupported steer as unsupported", () => {
    const unsupported = new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
      driver,
      providerThreadId,
    });
    expect(acpSteerTurnError({ ...context, cause: unsupported })).toBe(unsupported);
  });

  it("folds other failures into a steer run error", () => {
    const mapped = acpSteerTurnError({ ...context, cause: new AcpSteerDeclined({}) });
    expect(mapped._tag).toBe("ProviderAdapterSteerRunError");
  });
});
