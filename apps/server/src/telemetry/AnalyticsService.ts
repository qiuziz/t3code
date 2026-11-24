// This fork ships without telemetry. The service keeps its shape so call sites and layers need no
// changes, but `record`, `flush`, and `recordOwners` are unconditional no-ops: no event is
// buffered and no request is ever sent to PostHog or any other ingest endpoint.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { TelemetryOwner } from "./Identify.ts";

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Always false: the event was not queued because telemetry is disabled in this build. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<boolean>;

    readonly flush: Effect.Effect<void>;

    /** Always a no-op: owner ids are never collected or reported. */
    readonly recordOwners: (
      owners: ReadonlyArray<TelemetryOwner>,
      observedBy: "server" | "client",
    ) => Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {}

/** @public */
export const make = Effect.sync(() =>
  AnalyticsService.of({
    record: () => Effect.succeed(false),
    flush: Effect.void,
    recordOwners: () => Effect.void,
  }),
);

export const layer = Layer.effect(AnalyticsService, make);
