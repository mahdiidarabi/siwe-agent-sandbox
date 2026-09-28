import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

// One JSON line per call: ts, level, event, plus whatever fields the
// caller passes. No dependencies, no formatting library, just
// console.log(JSON.stringify(...)).
export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
}

export type RequestLogger = {
  requestId: string;
  debug: (event: string, fields?: LogFields) => void;
  info: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields) => void;
};

// A child logger bound to a fresh requestId (plus any other fields, e.g.
// route), so every line written during one request can be grep'd or
// joined by that id without repeating it at every call site.
export function createRequestLogger(bound: LogFields = {}): RequestLogger {
  const requestId = randomUUID();
  const context = { requestId, ...bound };
  return {
    requestId,
    debug: (event, fields) => log("debug", event, { ...context, ...fields }),
    info: (event, fields) => log("info", event, { ...context, ...fields }),
    warn: (event, fields) => log("warn", event, { ...context, ...fields }),
    error: (event, fields) => log("error", event, { ...context, ...fields }),
  };
}
