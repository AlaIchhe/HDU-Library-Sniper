import * as Sentry from "@sentry/react";
import { onCLS, onINP, onLCP, type Metric } from "web-vitals";

type LogLevel = "info" | "warn" | "error";

export function initializeTelemetry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (dsn) Sentry.init({ dsn, environment: import.meta.env.MODE, tracesSampleRate: 0.1 });
  const report = (metric: Metric) => structuredLog("info", "web_vital", { name: metric.name, value: metric.value, rating: metric.rating, id: metric.id });
  onCLS(report); onINP(report); onLCP(report);
}

export function structuredLog(level: LogLevel, event: string, context: Record<string, unknown> = {}) {
  const payload = { level, event, timestamp: new Date().toISOString(), ...context };
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.info(payload);
}
