import { Schema } from "effect";
import { list } from "@/lib/schemas/shape";

/** Runtime validator for `DoctorReport` (`screens/doctor.tsx`), the
 * `doctor_run` command's result — a few subprocess-probed checks, worth
 * catching a shape drift on rather than rendering a blank screen. */

const CheckResultSchema = Schema.Struct({
  name: Schema.String,
  version: Schema.NullOr(Schema.String),
  ok: Schema.Boolean,
  warning: Schema.optional(Schema.String),
});

const NameOkSchema = Schema.Struct({
  name: Schema.String,
  ok: Schema.Boolean,
});

const PluginCheckSchema = Schema.Struct({
  name: Schema.String,
  ok: Schema.Boolean,
  installHint: Schema.optional(Schema.String),
});

const AgentBoardCheckSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  ok: Schema.Boolean,
  warning: Schema.optional(Schema.String),
  hint: Schema.optional(Schema.String),
});

const StaleTaskCheckSchema = Schema.Struct({
  name: Schema.String,
  branch: Schema.String,
  reason: Schema.String,
});

const PortHealthCheckSchema = Schema.Struct({
  port: Schema.Number,
  owner: Schema.String,
  var: Schema.String,
  finding: Schema.String,
  hint: Schema.String,
});

const CheckoutCheckSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  ok: Schema.Boolean,
  warning: Schema.optional(Schema.String),
  hint: Schema.optional(Schema.String),
});

export const DoctorReportSchema = Schema.Struct({
  result: Schema.Struct({
    timestamp: Schema.String,
    tools: list(CheckResultSchema),
    ghAuth: Schema.Boolean,
    plugins: list(NameOkSchema),
    agentboard: list(NameOkSchema),
  }),
  plugins: list(PluginCheckSchema),
  agentboard: list(AgentBoardCheckSchema),
  staleTasks: list(StaleTaskCheckSchema),
  portHealth: list(PortHealthCheckSchema),
  checkout: list(CheckoutCheckSchema),
});

/** `doctor_recent_crashes`: `tt_telemetry::CrashRecord`, newest first. */
export const CrashRecordListSchema = list(
  Schema.Struct({
    ts: Schema.String,
    kind: Schema.String,
    message: Schema.String,
    location: Schema.NullOr(Schema.String),
    stack: Schema.NullOr(Schema.String),
    ttTask: Schema.NullOr(Schema.String),
    ttBuildSha: Schema.NullOr(Schema.String),
  }),
);

export type CrashRecord = (typeof CrashRecordListSchema.Type)[number];

/** `doctor_repeated_errors`: `tt_telemetry::RepeatedError`, most frequent first. */
export const RepeatedErrorListSchema = list(
  Schema.Struct({
    key: Schema.String,
    level: Schema.String,
    target: Schema.String,
    message: Schema.String,
    error: Schema.NullOr(Schema.String),
    count: Schema.Number,
    firstTs: Schema.String,
    lastTs: Schema.String,
  }),
);

export type RepeatedError = (typeof RepeatedErrorListSchema.Type)[number];

/** `doctor_state_on_disk`: `tt_doctor::DiskReport`. Own command — sizing is the
 * slow probe, so it never gates the main report. */
export const DiskReportSchema = Schema.Struct({
  root: Schema.String,
  entries: list(
    Schema.Struct({ name: Schema.String, bytes: Schema.Number, partial: Schema.Boolean }),
  ),
  scopes: list(
    Schema.Struct({
      name: Schema.String,
      path: Schema.String,
      bytes: Schema.Number,
      partial: Schema.Boolean,
      orphan: Schema.Boolean,
    }),
  ),
  residue: Schema.Struct({ count: Schema.Number, bytes: Schema.Number, partial: Schema.Boolean }),
  totalBytes: Schema.Number,
  partial: Schema.Boolean,
});

export type DiskReport = typeof DiskReportSchema.Type;
