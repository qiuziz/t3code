import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as AnalyticsService from "./AnalyticsService.ts";

// This fork never reports analytics, so the layer must stay inert whatever the environment,
// settings, or managed policy say.
it.effect("records nothing, reports no owners, and flushes without sending", () =>
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;

    assert.isFalse(yield* analytics.record("thread.created", { threadId: "thread-1" }));
    assert.isFalse(yield* analytics.record("install.owner_observed", undefined, { anonymous: true }));
    yield* analytics.recordOwners([{ source: "openai", ownerId: "owner-1" }], "server");
    yield* analytics.flush;
  }).pipe(Effect.provide(AnalyticsService.layer)),
);
