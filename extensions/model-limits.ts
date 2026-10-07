// What the endpoint actually accepts, per model and per wire shape.
//
// The catalog's `context_window` is none of these things. Three separate numbers
// decide whether a request survives:
//
//   1. **Request cap** (Chat Completions and Anthropic): above it the endpoint
//      answers `400 Range of input length should be [1, N]`. `N` is per model and
//      matches no single catalog field — measured 2026-10-07 across 15 models it
//      was `reasoning_max_input_tokens` for qwen3.8-*, `max_input_tokens` for
//      qwen3-30b-a3b and MiniMax-M2.1, and plain `context_window` for qwen-plus,
//      kimi-k2.6, deepseek-v3.2 and glm-5.1 (where it is *larger* than both
//      `max_input_tokens` and `reasoning_max_input_tokens`).
//   2. **Responses cap**: the Responses endpoint does not reject, it **silently
//      truncates** — and it keeps the head and the tail while dropping the
//      middle, so the model quietly loses the centre of the conversation and the
//      cached prefix dies. The documented rule is "approximately 80 % of the
//      context window"; measured, it is 79.3–80.0 % for qwen3.6/3.7/3.8 and
//      deepseek-v4, but **~90 000 tokens flat for the qwen3.5 generation**
//      (9 % of a 1 M window), which no catalog field predicts.
//   3. **Output cap**: `max_tokens` above `reasoning_max_output_tokens` is
//      rejected with thinking on — `qwen3-max` answers `Range of max_tokens
//      should be [1, 32768]` to the 65 536 its own catalog row advertises.
//
// So the numbers below are measurements, not derivations, and the derivations are
// only a fallback for models nobody has probed. Re-measure with
// `docs/notes/2026-10-07-dashscope-input-caps-probe.py` (the request cap comes
// free from the 400 text; the Responses cap costs one truncated request).

/** `model_info` rows of the native catalog, as far as this extension uses them. */
export interface CatalogLimits {
  contextWindow?: number;
  maxInput?: number;
  reasoningMaxInput?: number;
  maxOutput?: number;
  reasoningMaxOutput?: number;
}

export interface MeasuredCaps {
  /** Enforced input cap on Chat Completions and Anthropic (400 above it). */
  request?: number;
  /** Saturation point of the Responses endpoint's silent truncation. */
  responses?: number;
}

/**
 * Measured 2026-10-07 on the bound Beijing workspace domain, one probe per
 * model (oversized payload → the 400 text for `request`; oversized payload →
 * the reported `input_tokens` for `responses`). See
 * `docs/notes/2026-10-07-dashscope-input-caps.md`.
 */
export const MEASURED_INPUT_CAPS: Record<string, MeasuredCaps> = {
  "qwen3.8-max": { request: 983_616 },
  "qwen3.8-max-0902": { request: 983_616, responses: 792_945 },
  "qwen3.8-flash": { request: 983_616, responses: 800_056 },
  "qwen3.7-plus": { request: 983_616, responses: 792_907 },
  "qwen3.7-flash": { responses: 792_907 },
  "qwen3.6-flash": { responses: 792_907 },
  "qwen3.5-flash": { responses: 89_127 },
  "qwen3.5-35b-a3b": { request: 258_048, responses: 90_000 },
  "qwen3-max": { request: 258_048 },
  "qwen3-30b-a3b": { request: 98_304 },
  "qwen-plus": { request: 1_000_000 },
  "glm-5.3": { request: 1_048_576 },
  "glm-5.1": { request: 202_745 },
  "glm-4.6": { request: 169_984 },
  "kimi-k3": { request: 1_048_576 },
  "kimi-k2.6": { request: 262_144 },
  "deepseek-v4.1-flash": { request: 1_000_000, responses: 754_977 },
  "deepseek-v3.2": { request: 131_072 },
  "MiniMax-M2.1": { request: 172_032 },
};

/** The documented Responses budget: "approximately 80 % of the context window". */
export const RESPONSES_DOC_FRACTION = 0.8;
/**
 * Fraction used for models nobody has probed. Measured caps land at 79.3–80.0 %
 * of the request cap, so 78 % keeps a margin instead of sitting on the boundary
 * where the endpoint starts dropping the middle of the transcript.
 */
const DERIVED_RESPONSES_FRACTION = 0.78;
/** Measured on two qwen3.5 models (89 127 and ~90 000): a flat budget, not a fraction. */
const QWEN35_RESPONSES_CAP = 90_000;
/** deepseek-v4.1-flash measured 754 977 of a 1 000 000 request cap. */
const DEEPSEEK_V4_RESPONSES_FRACTION = 0.755;

const positive = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const smallest = (...vals: (number | undefined)[]): number | undefined => {
  const known = vals.filter(positive) as number[];
  return known.length ? Math.min(...known) : undefined;
};

/**
 * Request cap for a model nobody probed: the tightest of the catalog's own
 * numbers. Verified against all 15 measurements — it is never above the enforced
 * cap, so it errs toward compacting slightly early rather than toward a 400.
 */
export function deriveRequestCap(limits: CatalogLimits | undefined, fallbackWindow?: number): number | undefined {
  return smallest(fallbackWindow, limits?.contextWindow, limits?.maxInput, limits?.reasoningMaxInput);
}

/** Responses cap for a model nobody probed, from its generation's measured shape. */
export function deriveResponsesCap(id: string, requestCap: number): number {
  if (/^qwen3\.5-/i.test(id)) return Math.min(requestCap, QWEN35_RESPONSES_CAP);
  const fraction = /^deepseek-v4/i.test(id) ? DEEPSEEK_V4_RESPONSES_FRACTION : DERIVED_RESPONSES_FRACTION;
  return Math.floor(requestCap * fraction);
}

export interface ResolvedWindow {
  /** What the card should declare as `contextWindow`. */
  window: number;
  /** Where the number came from, for /alibaba → Status. */
  source: "override" | "measured" | "derived" | "catalog";
}

/**
 * The context window to declare for one model on one shape: the largest window
 * pi can fill without the endpoint rejecting the request (Completions,
 * Anthropic) or silently dropping its middle (Responses). An explicit user
 * override always wins — it exists for exactly the cases this table has not
 * measured.
 *
 * `baseWindow` is the catalog's (or inferred) context window, which stays the
 * ceiling even where the enforced input cap is larger: `glm-5.3` and `kimi-k3`
 * both accept 1 048 576 input tokens against a 1 000 000 window.
 */
export function resolveContextWindow(
  id: string,
  api: string,
  limits: CatalogLimits | undefined,
  baseWindow: number,
  opts: { override?: number; responsesGuard?: boolean } = {},
): ResolvedWindow {
  if (positive(opts.override)) return { window: Math.floor(opts.override), source: "override" };
  const measured = MEASURED_INPUT_CAPS[id];
  const requestCap = measured?.request ?? deriveRequestCap(limits, baseWindow);
  const wantsResponsesCap = api === "openai-responses" && opts.responsesGuard !== false;
  // The documented rule is a fraction of the *context window*, and a request cap
  // can sit above it (glm-5.3 and kimi-k3 accept 1 048 576 input tokens against
  // a 1 000 000 window), so the derivation starts from the tighter of the two.
  const responsesBase = positive(baseWindow) && positive(requestCap)
    ? Math.min(baseWindow, requestCap)
    : requestCap ?? baseWindow;
  const cap = wantsResponsesCap
    ? measured?.responses ?? (positive(responsesBase) ? deriveResponsesCap(id, responsesBase) : undefined)
    : requestCap;
  if (!positive(cap)) return { window: baseWindow, source: "catalog" };
  const window = Math.max(1, Math.floor(Math.min(baseWindow, cap)));
  const source = wantsResponsesCap
    ? measured?.responses ? "measured" : "derived"
    : measured?.request ? "measured" : "derived";
  return { window, source };
}

/**
 * The output ceiling to declare. `reasoning_max_output_tokens` is a hard cap
 * whenever thinking is on (`qwen3-max`: 65 536 rejected, 32 768 accepted), and a
 * card cannot express "it depends on the thinking level", so the lower of the two
 * wins: an undershoot caps a long answer, an overshoot fails every turn.
 */
export function resolveOutputCap(limits: CatalogLimits | undefined, catalogMax?: number): number | undefined {
  return smallest(catalogMax, limits?.maxOutput, limits?.reasoningMaxOutput);
}
