// Explicit-cache markers for the Chat Completions shape.
//
// The Responses shape opts into DashScope's explicit (session) cache with the
// `x-dashscope-session-cache` header, which `buildCloudModels` sets. Chat
// Completions has no such header: a block is created only where the payload
// carries `cache_control: {"type": "ephemeral"}`. Without markers those models
// fall back to the implicit cache — indeterminate lifetime, 128-token
// granularity, and reads at 12.5–25 % of input instead of 8.3–10 %.
//
// Verified live on 2026-10-07 against `kimi-k2.6`, `glm-5.1` and
// `deepseek-v3.2`: two identical requests, the first reporting
// `cache_creation_input_tokens = 2524/2553/2701` and the second
// `cached_tokens` of exactly the same size.
//
// Provider constraints (help.aliyun.com/zh/model-studio/context-cache): at most
// four markers, and if a payload carries more, **the last four win**; each
// marker caches the 20 content blocks before it; tools are serialized into the
// system message, so marking the system message covers them.
//
// Two markers are enough for an agent transcript and stay under the cap:
//   1. the last system/developer message — system prompt + tool definitions,
//      the part that never changes inside a session;
//   2. the last markable message — the growing tail. On the next turn the
//      previous tail position sits inside the new marker's 20-block window, so
//      the increment hits instead of being rewritten.

const EPHEMERAL = { type: "ephemeral" } as const;

interface ContentPart {
  type?: string;
  text?: string;
  cache_control?: unknown;
  [k: string]: unknown;
}

interface WireMessage {
  role?: string;
  content?: unknown;
  [k: string]: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// `tool` results are excluded: DashScope documents array content for
// system/user/assistant parts, and turning a tool result into parts to cache a
// few hundred tokens is not worth a 400 on every turn.
const MARKABLE_ROLES = new Set(["system", "developer", "user", "assistant"]);

/** The message content as a part array, or undefined when it cannot be marked. */
function asParts(message: WireMessage): ContentPart[] | undefined {
  const content = message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content) && content.every(isRecord)) {
    const parts = content as ContentPart[];
    // Only a text part can carry a marker; an image-only message stays unmarked.
    return parts.length && parts[parts.length - 1].type === "text" ? parts : undefined;
  }
  return undefined;
}

function markable(message: WireMessage): boolean {
  return !!message.role && MARKABLE_ROLES.has(message.role) && asParts(message) !== undefined;
}

function withMarker(message: WireMessage): WireMessage {
  const parts = asParts(message);
  if (!parts) return message;
  const last = parts[parts.length - 1];
  if (last.cache_control) return message; // already marked: never stack markers
  const next = [...parts.slice(0, -1), { ...last, cache_control: EPHEMERAL }];
  return { ...message, content: next };
}

export interface CacheControlResult {
  /** The payload to send; identical to the input when nothing was marked. */
  payload: Record<string, unknown>;
  markers: number;
}

/**
 * Add up to two `cache_control` markers to a Chat Completions payload. Pure and
 * non-mutating: pi owns the payload object, and `before_provider_request` may
 * be called more than once for the same request.
 */
export function injectCacheControl(payload: unknown): CacheControlResult | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return undefined;
  const messages = payload.messages as WireMessage[];
  if (messages.some((m) => JSON.stringify(m?.content ?? "").includes("cache_control"))) return undefined;

  let systemIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if ((role === "system" || role === "developer") && markable(messages[i])) { systemIndex = i; break; }
  }
  let tailIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (i !== systemIndex && markable(messages[i])) { tailIndex = i; break; }
  }
  const targets = [...new Set([systemIndex, tailIndex].filter((i) => i >= 0))].sort((a, b) => a - b);
  if (!targets.length) return undefined;

  const next = [...messages];
  for (const i of targets) next[i] = withMarker(messages[i]);
  return { payload: { ...payload, messages: next }, markers: targets.length };
}
