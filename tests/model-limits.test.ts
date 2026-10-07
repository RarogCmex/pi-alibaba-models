import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEquivalenceIndex,
  deriveRequestCap,
  deriveResponsesCap,
  MEASURED_INPUT_CAPS,
  resolveContextWindow,
  resolveOutputCap,
  type CatalogLimits,
} from "../extensions/model-limits.ts";

// Numbers below are the 2026-10-07 measurements recorded in
// docs/notes/2026-10-07-dashscope-input-caps.md. The catalog rows are verbatim
// `model_info` objects from GET /api/v1/models.
const QWEN38_MAX: CatalogLimits = {
  contextWindow: 1_000_000, maxInput: 991_808, reasoningMaxInput: 983_616,
  maxOutput: 131_072, reasoningMaxOutput: 131_072,
};
const QWEN3_MAX: CatalogLimits = {
  contextWindow: 262_144, maxInput: 258_048, reasoningMaxInput: 258_048,
  maxOutput: 65_536, reasoningMaxOutput: 32_768,
};
const QWEN35_FLASH: CatalogLimits = {
  contextWindow: 1_000_000, maxInput: 991_808, reasoningMaxInput: 983_616,
  maxOutput: 65_536, reasoningMaxOutput: 65_536,
};
const GLM_53: CatalogLimits = { contextWindow: 1_000_000, maxInput: 1_048_576, reasoningMaxInput: 1_048_576 };
const DEEPSEEK_V32: CatalogLimits = { contextWindow: 131_072, maxInput: 98_304, maxOutput: 65_536 };
const KIMI_K26: CatalogLimits = { contextWindow: 262_144, maxInput: 229_376 };
const MINIMAX_M21: CatalogLimits = { contextWindow: 204_800, maxInput: 172_032, maxOutput: 32_768 };

describe("deriveRequestCap (fallback for unmeasured models)", () => {
  it("takes the tightest catalog number, which never exceeded a measurement", () => {
    assert.equal(deriveRequestCap(QWEN38_MAX), 983_616); // = measured
    assert.equal(deriveRequestCap(QWEN3_MAX), 258_048); // = measured
    assert.equal(deriveRequestCap(DEEPSEEK_V32), 98_304); // measured 131_072: under, not over
    assert.equal(deriveRequestCap(KIMI_K26), 229_376); // measured 262_144: under
    assert.equal(deriveRequestCap(MINIMAX_M21), 172_032); // = measured
    assert.equal(deriveRequestCap(GLM_53, 1_000_000), 1_000_000); // window binds
  });

  it("falls back to the declared window with no catalog rows at all", () => {
    assert.equal(deriveRequestCap(undefined, 131_072), 131_072);
    assert.equal(deriveRequestCap(undefined), undefined);
    assert.equal(deriveRequestCap({}), undefined);
  });
});

describe("deriveResponsesCap", () => {
  it("keeps a margin under the documented 80% for unmeasured models", () => {
    // Measured caps land at 79.3–80.0% of the request cap, so the derived value
    // sits just below the boundary instead of on it.
    assert.equal(deriveResponsesCap("qwen3.8-max", 983_616), Math.floor(983_616 * 0.78));
    assert.equal(deriveResponsesCap("glm-5.2", 1_000_000), 780_000);
  });

  it("knows the qwen3.5 generation's flat ~90k budget", () => {
    // 9% of a 1M window: no catalog field predicts it, and declaring 80% there
    // would let pi fill a transcript the endpoint then hollows out.
    assert.equal(deriveResponsesCap("qwen3.5-plus", 983_616), 90_000);
    assert.equal(deriveResponsesCap("qwen3.5-122b-a10b", 258_048), 90_000);
    // A request cap below the flat budget still wins.
    assert.equal(deriveResponsesCap("qwen3.5-tiny", 40_000), 40_000);
  });

  it("uses deepseek-v4's measured 75.5%", () => {
    assert.equal(deriveResponsesCap("deepseek-v4-pro", 1_000_000), 755_000);
  });
});

describe("resolveContextWindow", () => {
  it("prefers the measurement for the shape in use", () => {
    assert.deepEqual(
      resolveContextWindow("qwen3.8-max-0902", "openai-responses", QWEN38_MAX, 1_000_000),
      { window: 792_945, source: "measured" },
    );
    assert.deepEqual(
      resolveContextWindow("qwen3.8-max-0902", "openai-completions", QWEN38_MAX, 1_000_000),
      { window: 983_616, source: "measured" },
    );
    // The Anthropic shape was measured to enforce the same cap as Completions.
    assert.equal(resolveContextWindow("deepseek-v3.2", "anthropic-messages", DEEPSEEK_V32, 131_072).window, 131_072);
  });

  it("derives for a model nobody probed, and says so", () => {
    const derived = resolveContextWindow("glm-5.2", "openai-responses", GLM_53, 1_000_000);
    assert.deepEqual(derived, { window: 780_000, source: "derived" });
    const request = resolveContextWindow("glm-5.2", "openai-completions", GLM_53, 1_000_000);
    assert.deepEqual(request, { window: 1_000_000, source: "derived" });
  });

  it("never declares more than the catalog window", () => {
    assert.equal(resolveContextWindow("glm-5.3", "openai-completions", GLM_53, 1_000_000).window, 1_000_000);
    assert.equal(resolveContextWindow("kimi-k3", "openai-completions", undefined, 1_000_000).window, 1_000_000);
  });

  it("derives the Responses fraction from the window when the request cap is larger", () => {
    // glm-5.3 accepts 1 048 576 input tokens against a 1 000 000 window, and
    // the documented Responses budget is a fraction of the *window*.
    assert.deepEqual(resolveContextWindow("glm-5.3", "openai-responses", GLM_53, 1_000_000),
      { window: 780_000, source: "derived" });
  });

  it("lets the guard off, and lets an override win outright", () => {
    assert.equal(
      resolveContextWindow("qwen3.8-max-0902", "openai-responses", QWEN38_MAX, 1_000_000, { responsesGuard: false }).window,
      983_616,
    );
    assert.deepEqual(
      resolveContextWindow("qwen3.8-max-0902", "openai-responses", QWEN38_MAX, 1_000_000, { override: 250_000 }),
      { window: 250_000, source: "override" },
    );
  });

  it("falls back to the documented fraction for a model nobody has seen", () => {
    // Unknown id, no catalog rows: the only thing we know is that Responses
    // keeps ~80% of the window, so the derived value stays just under it.
    assert.deepEqual(resolveContextWindow("brand-new-model", "openai-responses", undefined, 131_072),
      { window: Math.floor(131_072 * 0.78), source: "derived" });
    assert.deepEqual(resolveContextWindow("brand-new-model", "openai-completions", undefined, 131_072),
      { window: 131_072, source: "derived" });
    // With no window to work from there is nothing to derive from either.
    assert.deepEqual(resolveContextWindow("brand-new-model", "openai-responses", undefined, 0),
      { window: 0, source: "catalog" });
  });
});

describe("resolveOutputCap", () => {
  it("takes the thinking-mode ceiling when it is lower", () => {
    // qwen3-max answers `Range of max_tokens should be [1, 32768]` to 65536 with
    // thinking on, so the card must not advertise 65536.
    assert.equal(resolveOutputCap(QWEN3_MAX, 65_536), 32_768);
    assert.equal(resolveOutputCap(QWEN38_MAX, 131_072), 131_072);
    assert.equal(resolveOutputCap(QWEN35_FLASH, 65_536), 65_536);
  });

  it("ignores rows it does not have", () => {
    assert.equal(resolveOutputCap(undefined, 8_192), 8_192);
    assert.equal(resolveOutputCap(DEEPSEEK_V32, 0), 65_536);
    assert.equal(resolveOutputCap(DEEPSEEK_V32, undefined), 65_536);
    assert.equal(resolveOutputCap(undefined, 0), undefined);
  });
});

describe("equivalence links (the catalog's own equivalent_snapshot)", () => {
  it("resolves a measurement through the declared twin", () => {
    // qwen3.7-plus was probed; qwen3.7-plus-2026-05-26 is the same deployment,
    // so the dated snapshot should not fall back to a derived cap.
    assert.deepEqual(
      resolveContextWindow("qwen3.7-plus-2026-05-26", "openai-responses", QWEN38_MAX, 1_000_000,
        { equivalent: "qwen3.7-plus" }),
      { window: 792_907, source: "measured" },
    );
    assert.equal(
      resolveContextWindow("qwen3.7-plus-2026-05-26", "openai-completions", QWEN38_MAX, 1_000_000,
        { equivalent: "qwen3.7-plus" }).window,
      983_616,
    );
    // A model's own measurement wins over its twin's.
    assert.equal(
      resolveContextWindow("qwen3.8-flash", "openai-responses", QWEN38_MAX, 1_000_000,
        { equivalent: "qwen3.7-plus" }).window,
      800_056,
    );
  });

  it("indexes both directions and ignores empty links", () => {
    const idx = buildEquivalenceIndex([
      ["qwen3.7-plus", "qwen3.7-plus-2026-05-26"],
      ["qwen3-max", "qwen3-max-2026-01-23"],
      ["qwen3.8-27b", undefined],
      ["qwen3.8-2.4t-a95b", ""],
      ["self", "self"],
    ]);
    assert.equal(idx.get("qwen3.7-plus"), "qwen3.7-plus-2026-05-26");
    assert.equal(idx.get("qwen3.7-plus-2026-05-26"), "qwen3.7-plus");
    assert.equal(idx.get("qwen3-max-2026-01-23"), "qwen3-max");
    assert.equal(idx.has("qwen3.8-27b"), false);
    assert.equal(idx.has("qwen3.8-2.4t-a95b"), false);
    assert.equal(idx.has("self"), false);
  });
});

describe("the measured table", () => {
  it("holds only sane numbers, so a typo cannot shrink a window to nothing", () => {
    for (const [id, caps] of Object.entries(MEASURED_INPUT_CAPS)) {
      for (const [kind, value] of Object.entries(caps)) {
        assert.equal(typeof value, "number", `${id}.${kind}`);
        assert.ok((value as number) >= 4_096, `${id}.${kind} = ${value} is implausibly small`);
        assert.ok((value as number) <= 10_000_000, `${id}.${kind} = ${value} is implausibly large`);
      }
    }
  });

  it("never measures a Responses cap above the same model's request cap", () => {
    for (const [id, caps] of Object.entries(MEASURED_INPUT_CAPS)) {
      if (caps.request && caps.responses) {
        assert.ok(caps.responses <= caps.request, `${id}: ${caps.responses} > ${caps.request}`);
      }
    }
  });
});
