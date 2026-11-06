import type { CommLogEntry } from "../../shared/state";

type OptionalCommLogField = "reason" | "durationMs" | "actor" | "triggeredBy";

// Timestamp and optional diagnostics are supplied by SQLite, keeping every caller's audit shape consistent.
export type CommLogInput = Omit<CommLogEntry, "ts" | OptionalCommLogField> &
  Partial<Pick<CommLogEntry, OptionalCommLogField>>;
