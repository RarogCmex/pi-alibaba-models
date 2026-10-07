import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  convertCost,
  declareCacheCost,
  DEFAULT_CNY_PER_USD,
  DEFAULT_TIER_TOKENS,
  formatCacheEconomics,
  parseCatalogPrices,
  parseRangeTokens,
  pickPriceRange,
  type CatalogPriceRange,
} from "../extensions/prices.ts";

// Fixtures are verbatim rows from `GET /api/v1/models?capabilities=TG`
// (cn-beijing workspace, 2026-10-07). Prices are CNY per million tokens.
const row = (type: string, price: string, time_band: string | null = "standard") =>
  ({ type, price, price_unit: "每百万tokens", time_band }) as const;

const QWEN38_MAX_0902: CatalogPriceRange[] = [
  {
    range_name: "Default",
    prices: [
      row("input_token", "12"), row("output_token", "36"), row("input_token_cache", "1.5"),
      row("input_token_cache_creation_5m", "15"), row("input_token_cache_read", "1"),
    ],
  },
];

// Batch rows sit next to the interactive ones and must never be picked.
const QWEN38_MAX: CatalogPriceRange[] = [
  {
    range_name: "Default",
    prices: [
      row("input_token", "12"), row("output_token", "36"), row("input_token_cache", "1.5"),
      row("input_token_batch", "6"), row("output_token_batch", "18"),
      row("input_token_cache_creation_5m", "15"), row("input_token_cache_read", "1"),
      row("input_token_batch_chat", "12"), row("output_token_batch_chat", "36"),
    ],
  },
];

const QWEN3_MAX_TIERS: CatalogPriceRange[] = [
  {
    range_name: "输入<=32k",
    prices: [row("input_token", "2.5"), row("output_token", "10"), row("input_token_cache", "0.5"),
      row("input_token_cache_creation_5m", "3.125"), row("input_token_cache_read", "0.25")],
  },
  {
    range_name: "32k<输入<=128k",
    prices: [row("input_token", "4"), row("output_token", "16"), row("input_token_cache", "0.8"),
      row("input_token_cache_creation_5m", "5"), row("input_token_cache_read", "0.4")],
  },
  {
    range_name: "128k<输入<=256k",
    prices: [row("input_token", "7"), row("output_token", "28"), row("input_token_cache", "1.4"),
      row("input_token_cache_creation_5m", "8.75"), row("input_token_cache_read", "0.7")],
  },
];

// The only shape in the catalog that publishes time bands instead of one price.
const DEEPSEEK_V41_FLASH: CatalogPriceRange[] = [
  {
    range_name: "Default",
    prices: [
      row("input_token", "1", "offpeak"), row("input_token", "2", "peak"),
      row("output_token", "4", "offpeak"), row("output_token", "8", "peak"),
      row("input_token_cache", "0.1", "offpeak"), row("input_token_cache", "0.2", "peak"),
    ],
  },
];

const GLM_53: CatalogPriceRange[] = [
  { range_name: "Default", prices: [row("input_token", "8"), row("output_token", "28"), row("input_token_cache", "2")] },
];

// Thinking-only ids publish no plain input/output row at all.
const QWEN3_THINKING_ONLY: CatalogPriceRange[] = [
  { range_name: "Default", prices: [row("thinking_input_token", "2"), row("thinking_output_token", "20")] },
];

const QWEN_PLUS_TIERS: CatalogPriceRange[] = [
  {
    range_name: "输入<=128k",
    prices: [
      row("input_token", "0.8"), row("output_token", "2"), row("thinking_input_token", "0.8"),
      row("thinking_output_token", "8"), row("input_token_cache", "0.16"),
      row("input_token_cache_creation_5m", "1"), row("input_token_cache_read", "0.08"),
    ],
  },
  {
    range_name: "128k<输入<=256k",
    prices: [row("input_token", "2.4"), row("output_token", "20"), row("thinking_output_token", "24")],
  },
];

describe("parseRangeTokens", () => {
  it("reads the Chinese tier names the catalog uses", () => {
    assert.equal(parseRangeTokens("Default"), null);
    assert.equal(parseRangeTokens(undefined), null);
    assert.deepEqual(parseRangeTokens("输入<=32k"), { lo: 0, hi: 32_000 });
    assert.deepEqual(parseRangeTokens("输入<=128k"), { lo: 0, hi: 128_000 });
    assert.deepEqual(parseRangeTokens("32k<输入<=128k"), { lo: 32_000, hi: 128_000 });
    assert.deepEqual(parseRangeTokens("256k<输入<=1m"), { lo: 256_000, hi: 1_000_000 });
    assert.deepEqual(parseRangeTokens("32k<输入<=200k"), { lo: 32_000, hi: 200_000 });
  });
});

describe("pickPriceRange", () => {
  it("prefers an explicit Default range", () => {
    assert.equal(pickPriceRange(QWEN38_MAX_0902)?.range_name, "Default");
  });

  it("picks the tier that contains the probe size, and the widest tier above it", () => {
    assert.equal(pickPriceRange(QWEN3_MAX_TIERS, 20_000)?.range_name, "输入<=32k");
    assert.equal(pickPriceRange(QWEN3_MAX_TIERS, DEFAULT_TIER_TOKENS)?.range_name, "32k<输入<=128k");
    assert.equal(pickPriceRange(QWEN3_MAX_TIERS, 200_000)?.range_name, "128k<输入<=256k");
    // A prompt past the highest band still has to be priced: the widest wins.
    assert.equal(pickPriceRange(QWEN3_MAX_TIERS, 900_000)?.range_name, "128k<输入<=256k");
    assert.equal(pickPriceRange(undefined), undefined);
    assert.equal(pickPriceRange([]), undefined);
  });
});

describe("parseCatalogPrices", () => {
  it("reads every cache row of the default Cloud model", () => {
    assert.deepEqual(parseCatalogPrices(QWEN38_MAX_0902), {
      input: 12, output: 36, implicitRead: 1.5, explicitRead: 1, explicitWrite: 15,
      explicitCache: true, tier: "Default", tiered: false, thinkingOutput: false,
    });
  });

  it("never mistakes a cache or batch row for the input price", () => {
    // The regression this module exists for: `/input/i` also matched
    // input_token_cache_read, and the last match won — 1 instead of 12 CNY/M
    // for the default model, and 6 (batch) for qwen3.8-max.
    assert.equal(parseCatalogPrices(QWEN38_MAX_0902).input, 12);
    assert.equal(parseCatalogPrices(QWEN38_MAX).input, 12);
    assert.equal(parseCatalogPrices(QWEN38_MAX).output, 36);
  });

  it("prices tiered models at the configured probe size", () => {
    assert.equal(parseCatalogPrices(QWEN3_MAX_TIERS, { tierTokens: 20_000 }).input, 2.5);
    assert.equal(parseCatalogPrices(QWEN3_MAX_TIERS).input, 4);
    assert.equal(parseCatalogPrices(QWEN3_MAX_TIERS).tiered, true);
    assert.equal(parseCatalogPrices(QWEN3_MAX_TIERS).explicitRead, 0.4);
  });

  it("takes the peak price when a model publishes only time bands", () => {
    const p = parseCatalogPrices(DEEPSEEK_V41_FLASH);
    assert.equal(p.input, 2);
    assert.equal(p.output, 8);
    assert.equal(p.implicitRead, 0.2);
    assert.equal(p.explicitCache, false);
  });

  it("marks implicit-only models as having no explicit cache", () => {
    const p = parseCatalogPrices(GLM_53);
    assert.deepEqual({ input: p.input, implicitRead: p.implicitRead, explicitCache: p.explicitCache },
      { input: 8, implicitRead: 2, explicitCache: false });
  });

  it("falls back to thinking rows, and prefers them for output by default", () => {
    const thinkingOnly = parseCatalogPrices(QWEN3_THINKING_ONLY);
    assert.equal(thinkingOnly.input, 2);
    assert.equal(thinkingOnly.output, 20);
    assert.equal(thinkingOnly.thinkingOutput, true);

    assert.equal(parseCatalogPrices(QWEN_PLUS_TIERS).output, 8);
    assert.equal(parseCatalogPrices(QWEN_PLUS_TIERS, { thinkingOutput: false }).output, 2);
    assert.equal(parseCatalogPrices(QWEN_PLUS_TIERS, { thinkingOutput: false }).thinkingOutput, false);
    assert.equal(parseCatalogPrices(QWEN_PLUS_TIERS).input, 0.8);
  });

  it("ignores rows in another unit and returns zeros without rows", () => {
    const odd = [{ range_name: "Default", prices: [{ type: "input_token", price: "3", price_unit: "每千tokens" }] }];
    assert.equal(parseCatalogPrices(odd).input, 0);
    assert.deepEqual(parseCatalogPrices(undefined).input, 0);
    assert.equal(parseCatalogPrices([]).explicitCache, false);
  });
});

describe("declareCacheCost", () => {
  const p = parseCatalogPrices(QWEN38_MAX_0902);

  it("declares the explicit pair while the session cache is on", () => {
    assert.deepEqual(declareCacheCost(p, true), { cacheRead: 1, cacheWrite: 15 });
  });

  it("declares implicit reads and no write premium without it", () => {
    // An implicit-cache write is billed as ordinary input, so cacheWrite stays
    // 0 — which is also what keeps pi's own warming arithmetic honest.
    assert.deepEqual(declareCacheCost(p, false), { cacheRead: 1.5, cacheWrite: 0 });
  });

  it("falls back to implicit for models without explicit rows", () => {
    assert.deepEqual(declareCacheCost(parseCatalogPrices(GLM_53), true), { cacheRead: 2, cacheWrite: 0 });
  });
});

describe("convertCost", () => {
  const cost = { input: 12, output: 36, cacheRead: 1, cacheWrite: 15 };

  it("keeps CNY by default", () => {
    assert.deepEqual(convertCost(cost, "cny"), cost);
  });

  it("divides by the configured rate in USD", () => {
    const usd = convertCost(cost, "usd", 6);
    assert.deepEqual(usd, { input: 2, output: 6, cacheRead: 1 / 6, cacheWrite: 2.5 });
  });

  it("ignores a rate that cannot divide", () => {
    assert.deepEqual(convertCost(cost, "usd", 0), convertCost(cost, "usd", DEFAULT_CNY_PER_USD));
    assert.deepEqual(convertCost(cost, "usd", NaN), convertCost(cost, "usd", DEFAULT_CNY_PER_USD));
  });
});

describe("formatCacheEconomics", () => {
  it("states read and write prices as a share of input", () => {
    const p = parseCatalogPrices(QWEN38_MAX_0902);
    assert.equal(
      formatCacheEconomics(p, true, "cny"),
      "session cache: read 1 (8.3% of input), write 15 (125%) CNY/M",
    );
    assert.equal(formatCacheEconomics(p, false, "cny"), "implicit cache only: read 1.5 (12.5% of input) CNY/M");
    assert.equal(
      formatCacheEconomics(parseCatalogPrices(GLM_53), true, "usd"),
      "implicit cache only: read 2 (25% of input) USD/M",
    );
  });

  it("says so when the catalog has no cache rows", () => {
    assert.equal(formatCacheEconomics(parseCatalogPrices([]), true, "cny"), "no cache rows in catalog (CNY/M)");
  });
});
