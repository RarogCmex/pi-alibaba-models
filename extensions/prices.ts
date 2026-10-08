// Cloud catalog price rows → the numbers pi's `cost` field needs.
//
// `GET /api/v1/models` returns, per model, one or more price *ranges* (size
// tiers such as `输入<=256k`), each holding rows keyed by `type`. Three facts
// make naive matching wrong (docs/notes/2026-10-07-long-session-cache-provider-
// data-and-options.md §1.1):
//
//   • `/input/i` also matches `input_token_cache_read`, and the last match used
//     to win: 72 of 154 models were priced from a cache row (`qwen3.8-max-0902`
//     read 1 instead of 12 CNY/M).
//   • Every row is CNY per million tokens while pi treats `cost.*` as USD, so
//     the unit has to be a decision, not an accident.
//   • Cache rows come in an implicit (`input_token_cache`) and an explicit
//     (`…_cache_read` / `…_cache_creation_5m`) pair. Only the explicit pair
//     applies while the session-cache header is on; with it off, a write is
//     billed as ordinary input.
//
// Rows are therefore matched by exact `type`, inside one chosen range and one
// chosen time band.

/** One price row of the Cloud catalog. */
export interface CatalogPriceItem {
  type?: string;
  price?: string;
  price_unit?: string;
  price_name?: string;
  time_band?: string | null;
}

/** One size tier ("range") of a model's price table. */
export interface CatalogPriceRange {
  range_name?: string;
  prices?: CatalogPriceItem[];
}

export interface CatalogPrices {
  /** Ordinary input tokens, CNY per million. */
  input: number;
  /** Ordinary output tokens, CNY per million. */
  output: number;
  /** Implicit-cache read price (`input_token_cache`); 0 when the model has none. */
  implicitRead: number;
  /** Session-cache read price (`input_token_cache_read`); 0 when absent. */
  explicitRead: number;
  /** Session-cache write price (`input_token_cache_creation_5m`); 0 when absent. */
  explicitWrite: number;
  /** True when the catalog publishes the explicit/session-cache pair. */
  explicitCache: boolean;
  /** The range the numbers came from, for /alibaba → Status. */
  tier?: string;
  /** True when the catalog has several size tiers, i.e. the choice mattered. */
  tiered: boolean;
  /** True when `output` came from a `thinking_output_token` row. */
  thinkingOutput: boolean;
}

export interface CatalogPriceOptions {
  /** Prompt size used to pick a tier. Default 128k — the middle of what long sessions send. */
  tierTokens?: number;
  /**
   * Prefer `thinking_output_token` over `output_token` when a model publishes
   * both. Default true: these are reasoning models and pi runs them with a
   * thinking level, which is the mode the thinking row bills.
   */
  thinkingOutput?: boolean;
}

export const DEFAULT_TIER_TOKENS = 128_000;

/** CNY per USD used when costs are declared in USD. Overridable in config. */
export const DEFAULT_CNY_PER_USD = 7.1;

const PER_MILLION = /百万/i;

const number = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

// `输入<=256k` → {0, 256_000}; `32k<输入<=128k` → {32_000, 128_000};
// `256k<输入<=1m` → {256_000, 1_000_000}. One number means "from zero", two
// mean a half-open band. `Default` (or anything without a number) has no band.
export function parseRangeTokens(name: string | undefined): { lo: number; hi: number } | null {
  if (!name || /default/i.test(name)) return null;
  const found = [...name.matchAll(/(\d+(?:\.\d+)?)\s*([km])?/gi)].map((m) => {
    const unit = (m[2] ?? "").toLowerCase();
    return Number(m[1]) * (unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1);
  });
  if (!found.length) return null;
  return found.length === 1 ? { lo: 0, hi: found[0] } : { lo: found[0], hi: found[1] };
}

/**
 * The range to price from: an explicit `Default` when the model has one, else
 * the tier containing `tierTokens`, else the widest tier. DashScope bills per
 * request size while this declares one flat `cost`, so the number is an
 * estimate by construction — /alibaba → Status says which tier was chosen.
 * The host can bill per request size itself: `cost.tiers` (`ModelCostTier`,
 * `inputTokensAbove`, highest matching threshold prices the whole request) has
 * been accepted on extension-registered models since pi 0.80.6 and is not used
 * here yet. See docs/TODO.md → “Request-wide price tiers”.
 */
export function pickPriceRange(
  ranges: CatalogPriceRange[] | undefined,
  tierTokens = DEFAULT_TIER_TOKENS,
): CatalogPriceRange | undefined {
  if (!ranges?.length) return undefined;
  const named = ranges.find((r) => /default/i.test(r.range_name ?? ""));
  if (named) return named;
  const banded = ranges.map((r) => ({ r, band: parseRangeTokens(r.range_name) }));
  const hit = banded.find((b) => b.band && tierTokens > b.band.lo && tierTokens <= b.band.hi);
  if (hit) return hit.r;
  const widest = banded
    .filter((b) => b.band)
    .sort((a, b) => (b.band?.hi ?? 0) - (a.band?.hi ?? 0))[0];
  return widest?.r ?? ranges[0];
}

// Only three models publish peak/off-peak rows instead of a single price
// (deepseek-v4.1-flash and friends). `standard`/absent is what the console
// shows; when a type exists only as peak/off-peak, peak is the conservative
// pick — under-reporting a bill is worse than over-reporting it.
const BAND_RANK: Record<string, number> = { standard: 0, peak: 1, offpeak: 2 };
function pickByTimeBand(items: CatalogPriceItem[]): number | undefined {
  const ranked = items
    .map((i) => ({ v: number(i.price), rank: BAND_RANK[i.time_band ?? "standard"] ?? 1 }))
    .filter((x): x is { v: number; rank: number } => x.v !== undefined)
    .sort((a, b) => a.rank - b.rank);
  return ranked[0]?.v;
}

/** Exact-type lookup, in priority order, within one range. */
function rowValue(range: CatalogPriceRange | undefined, types: string[]): number | undefined {
  for (const type of types) {
    const v = pickByTimeBand((range?.prices ?? []).filter((i) => i.type === type && PER_MILLION.test(i.price_unit ?? "")));
    if (v !== undefined) return v;
  }
  return undefined;
}

export function parseCatalogPrices(
  ranges: CatalogPriceRange[] | undefined,
  opts: CatalogPriceOptions = {},
): CatalogPrices {
  const tierTokens = opts.tierTokens ?? DEFAULT_TIER_TOKENS;
  const preferThinking = opts.thinkingOutput !== false;
  const range = pickPriceRange(ranges, tierTokens);
  const out = preferThinking
    ? rowValue(range, ["thinking_output_token", "output_token"])
    : rowValue(range, ["output_token", "thinking_output_token"]);
  const thinkingOutput =
    out !== undefined && rowValue(range, ["thinking_output_token"]) === out && rowValue(range, ["output_token"]) !== out;
  const implicitRead = rowValue(range, ["input_token_cache", "thinking_input_token_cache"]) ?? 0;
  const explicitRead = rowValue(range, ["input_token_cache_read", "thinking_input_token_cache_read"]) ?? 0;
  const explicitWrite = rowValue(range, ["input_token_cache_creation_5m", "thinking_input_token_cache_creation_5m"]) ?? 0;
  return {
    input: rowValue(range, ["input_token", "thinking_input_token"]) ?? 0,
    output: out ?? 0,
    implicitRead,
    explicitRead,
    explicitWrite,
    explicitCache: explicitRead > 0 && explicitWrite > 0,
    tier: range?.range_name,
    tiered: (ranges ?? []).length > 1,
    thinkingOutput,
  };
}

export interface CostFields {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The `cacheRead`/`cacheWrite` pair to declare for a request shape. With the
 * session-cache header on, reads bill at the explicit price and a miss writes
 * at 125 % of input; with it off, reads bill at the implicit price and there
 * is no separate write (a miss is ordinary input, so `cacheWrite` stays 0 —
 * which is also what keeps pi's own warming arithmetic honest).
 */
export function declareCacheCost(p: CatalogPrices, explicit: boolean): Pick<CostFields, "cacheRead" | "cacheWrite"> {
  return explicit && p.explicitCache
    ? { cacheRead: p.explicitRead, cacheWrite: p.explicitWrite }
    : { cacheRead: p.implicitRead, cacheWrite: 0 };
}

/**
 * Catalog prices are CNY per million; pi labels `cost.*` as dollars and its
 * warming gate is a $0.05 threshold. `cny` keeps the numbers the Bailian
 * console bills in (pi's `$` then reads as CNY); `usd` converts.
 */
export function convertCost(cost: CostFields, currency: "cny" | "usd", cnyPerUsd = DEFAULT_CNY_PER_USD): CostFields {
  if (currency !== "usd") return cost;
  const rate = Number.isFinite(cnyPerUsd) && cnyPerUsd > 0 ? cnyPerUsd : DEFAULT_CNY_PER_USD;
  return {
    input: cost.input / rate,
    output: cost.output / rate,
    cacheRead: cost.cacheRead / rate,
    cacheWrite: cost.cacheWrite / rate,
  };
}

/** One Status line: what a cached turn costs relative to an uncached one. */
export function formatCacheEconomics(p: CatalogPrices, explicit: boolean, currency: "cny" | "usd"): string {
  const unit = currency === "usd" ? "USD" : "CNY";
  if (!p.explicitCache && !p.implicitRead) return `no cache rows in catalog (${unit}/M)`;
  if (explicit && p.explicitCache) {
    const read = ((p.explicitRead / p.input) * 100).toFixed(1).replace(/\.0$/, "");
    const write = ((p.explicitWrite / p.input) * 100).toFixed(1).replace(/\.0$/, "");
    return `session cache: read ${p.explicitRead} (${read}% of input), write ${p.explicitWrite} (${write}%) ${unit}/M`;
  }
  const read = ((p.implicitRead / p.input) * 100).toFixed(1).replace(/\.0$/, "");
  return `implicit cache only: read ${p.implicitRead} (${read}% of input) ${unit}/M`;
}
