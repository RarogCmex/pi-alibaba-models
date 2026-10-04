// Structure-based classification of raw provider stream events.
//
// DashScope reports some transient failures as SSE `error`/`server_error`
// events wrapped in HTTP 200, and phrases the same condition differently from
// one response to the next. The `provider_stream_event` handler captures the
// raw parsed event and classifies it by its structure and contents — HTTP 429,
// throttling/rate-limit phrasings, 5xx, and the `Backend buffer overflow`
// family — so pi's retry decision no longer depends on the finalized message's
// wording. The handler cannot rewrite the provider response; the classification
// is consulted later, from `message_end`, and the existing text matchers stay
// as the fallback for turns where no raw event was seen.
//
// Pure and offline: `classifyStreamError` is a function of one event, so new
// phrasings are added as data, not as branches in the message path.

export type StreamErrorClass = "rate_limit" | "backend_error";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function collectText(rec: Record<string, unknown>): string {
  const err = asRecord(rec.error) ?? asRecord(asRecord(rec.response)?.error);
  const parts = [
    typeof rec.type === "string" ? rec.type : "",
    typeof rec.code === "string" ? rec.code : "",
    typeof rec.message === "string" ? rec.message : "",
    typeof rec.error === "string" ? rec.error : "",
    typeof err?.type === "string" ? err.type : "",
    typeof err?.code === "string" ? err.code : "",
    typeof err?.message === "string" ? err.message : "",
  ];
  return parts.filter(Boolean).join(" ");
}

function collectStatuses(rec: Record<string, unknown>): number[] {
  const candidate = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const response = asRecord(rec.response);
  const err = asRecord(rec.error) ?? asRecord(response?.error);
  const statuses = [
    candidate(rec._httpStatus),
    candidate(rec.status),
    candidate(rec.status_code),
    candidate(response?.status),
    candidate(response?.status_code),
    candidate(err?.status),
    candidate(err?.status_code),
    candidate(rec.code),
  ].filter((n): n is number => n !== undefined);
  return statuses;
}

// InternalError.Algo.InvalidParameter is permanent even when it carries an
// `<429>` marker; the same rule as the sidecar's text matcher.
const INVALID_PARAM = /InternalError\.Algo\.InvalidParameter/i;
const RATE_LIMIT = /too many requests|throttling(?:\.(?:ratequota|burstrate|allocationquota|rate))?|limit_requests|limit_burst_rate|rate.?limit/i;
const EMBEDDED_429 = /<429\b|HTTP_STATUS\/429|(?:^|[\s:])429(?:\s|:|\b)/;
const BACKEND_OVERFLOW = /backend\s*buffer\s*overflow/i;

/** Does this event look like a failure at all? */
export function isStreamErrorEvent(data: unknown): boolean {
  const rec = asRecord(data);
  if (!rec) return false;
  const type = typeof rec.type === "string" ? rec.type : "";
  if (/error|fail/i.test(type)) return true;
  if (asRecord(rec.error)) return true;
  if (asRecord(asRecord(rec.response)?.error)) return true;
  if (collectStatuses(rec).some((s) => s >= 400)) return true;
  if (BACKEND_OVERFLOW.test(collectText(rec))) return true;
  return false;
}

/** Classify one raw provider stream event, or undefined when it is not a retryable failure. */
export function classifyStreamError(data: unknown): StreamErrorClass | undefined {
  if (!isStreamErrorEvent(data)) return undefined;
  const rec = asRecord(data)!;
  const text = collectText(rec);
  if (INVALID_PARAM.test(text)) return undefined;
  const statuses = collectStatuses(rec);

  // Rate limits first: DashScope wraps a 429 in a `server_error` event over
  // HTTP 200, and the same condition may arrive with an `_httpStatus` marker or
  // only in the message text.
  if (statuses.includes(429)) return "rate_limit";
  if (RATE_LIMIT.test(text)) return "rate_limit";
  if (EMBEDDED_429.test(text) && /InternalError\.Algo\b/i.test(text)) return "rate_limit";

  if (BACKEND_OVERFLOW.test(text)) return "backend_error";
  if (statuses.some((s) => s >= 500 && s <= 599)) return "backend_error";
  return undefined;
}

/** The retryable marker pi's classifier recognizes. */
export function streamErrorPrefix(cls: StreamErrorClass): string {
  return cls === "rate_limit" ? "429 " : "server_error ";
}

// Retryable markers pi's isRetryableAssistantError already recognizes — a
// prefix is unnecessary when one is present, and avoids double-prefixing.
const RETRYABLE_MARKER = /server.?error|internal.?error|overloaded|service.?unavailable|too many requests|rate.?limit|429|5(?:00|02|03|04|24)/i;

/**
 * Rewrite an unrecognized error message from the captured classification, or
 * undefined when there is nothing to do. The caller only reaches this after
 * the wording-based matchers returned undefined.
 */
export function rewriteFromStreamError(
  errorMessage: string,
  cls: StreamErrorClass | undefined,
): string | undefined {
  if (!cls || !errorMessage) return undefined;
  if (cls === "rate_limit" && /^\s*429\b/.test(errorMessage)) return undefined;
  if (cls === "backend_error" && RETRYABLE_MARKER.test(errorMessage)) return undefined;
  return streamErrorPrefix(cls) + errorMessage;
}
