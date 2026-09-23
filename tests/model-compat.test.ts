import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyAuthorizedFilter,
  buildCloudModels,
  buildPlanModels,
  formatQuota,
  inferAnthropicMaxTokens,
  isReasoningModel,
  isVisionModel,
  parseApiV1Prices,
  resolveCloudApi,
  supportsCloudResponses,
  thinkingConfigFor,
} from "../extensions/alibaba.ts";

const reasoningQwen = {
  id: "qwen3.7-max",
  name: "Qwen 3.7 Max",
  reasoning: true,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 32_768,
  compat: { thinkingFormat: "qwen" as const },
};

const nonReasoning = {
  ...reasoningQwen,
  id: "qwen-turbo",
  name: "Qwen Turbo",
  reasoning: false,
  compat: undefined,
};

const ANTHROPIC_LEVELS = {
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

function compatFlags(model: { compat?: object }) {
  return (model.compat ?? {}) as {
    supportsDeveloperRole?: boolean;
    supportsStore?: boolean;
    supportsReasoningEffort?: boolean;
    thinkingFormat?: string;
  };
}

describe("thinkingLevelMap", () => {
  it("exposes every level on the Anthropic path, with a string `off`", () => {
    // `off` must not be null: pi clamps an unsupported level *upward*, so a
    // null `off` silently upgraded "thinking off" into a real thinking budget.
    const [plan] = buildPlanModels(
      [{ ...reasoningQwen, openaiOnly: false }],
      "https://plan.example/openai",
      "https://plan.example/anthropic",
    );
    const [cloud] = buildCloudModels([reasoningQwen], "dashscope.example", "anthropic-messages");

    assert.deepEqual(plan.thinkingLevelMap, ANTHROPIC_LEVELS);
    assert.deepEqual(cloud.thinkingLevelMap, ANTHROPIC_LEVELS);
    assert.equal(plan.thinkingLevelMap?.off, "off");
  });

  it("leaves non-reasoning models without a thinking map", () => {
    const [plan] = buildPlanModels(
      [{ ...nonReasoning, openaiOnly: false }],
      "https://plan.example/openai",
      "https://plan.example/anthropic",
    );
    const [cloud] = buildCloudModels([nonReasoning], "dashscope.example", "anthropic-messages");

    assert.equal(plan.thinkingLevelMap, undefined);
    assert.equal(cloud.thinkingLevelMap, undefined);
  });
});

describe("isReasoningModel", () => {
  it("does not flag kimi — DashScope rejects thinking_budget for those ids", () => {
    assert.equal(isReasoningModel("kimi-k3"), false);
    assert.equal(isReasoningModel("kimi-k2.7-code"), false);
    assert.equal(isReasoningModel("kimi-k2.5"), false);
  });

  it("still flags qwen max, glm, deepseek, and minimax as reasoning", () => {
    assert.equal(isReasoningModel("qwen3.7-max"), true);
    assert.equal(isReasoningModel("qwen3.7-plus"), true);
    assert.equal(isReasoningModel("glm-5.2"), true);
    assert.equal(isReasoningModel("deepseek-v4-pro"), true);
    assert.equal(isReasoningModel("deepseek-v4-flash"), true);
    assert.equal(isReasoningModel("minimax-m2.5"), true);
  });

  it("flags Qwen plus/flash and the open-weight qwen3-<size>b line", () => {
    assert.equal(isReasoningModel("qwen-plus"), true);
    assert.equal(isReasoningModel("qwen-flash"), true);
    assert.equal(isReasoningModel("qwen3-30b-a3b"), true);
  });

  it("does not flag qwen-turbo, which accepts no thinking controls", () => {
    assert.equal(isReasoningModel("qwen-turbo"), false);
  });

  it("does not flag the -character roleplay variants", () => {
    assert.equal(isReasoningModel("qwen-plus-character"), false);
    assert.equal(isReasoningModel("qwen-flash-character"), false);
    assert.equal(isReasoningModel("qwen3-max-character"), false);
  });

  it("flags qwen3-coder/next via the family table (the heuristic missed them)", () => {
    assert.equal(isReasoningModel("qwen3-coder-plus"), true);
    assert.equal(isReasoningModel("qwen3-next"), true);
  });
});

describe("supportsDeveloperRole", () => {
  it("disables the developer role only on the OpenAI-compat path", () => {
    const [planAnthropic, planOpenAI] = buildPlanModels(
      [
        { ...reasoningQwen, id: "qwen3.7-max", openaiOnly: false },
        { ...reasoningQwen, id: "deepseek-v4", openaiOnly: true },
      ],
      "https://plan.example/openai",
      "https://plan.example/anthropic",
    );

    assert.equal(planAnthropic.api, "anthropic-messages");
    assert.equal(compatFlags(planAnthropic).supportsDeveloperRole, undefined);
    assert.equal(compatFlags(planAnthropic).thinkingFormat, "qwen");

    assert.equal(planOpenAI.api, "openai-completions");
    assert.equal(compatFlags(planOpenAI).supportsDeveloperRole, false);
    assert.equal(compatFlags(planOpenAI).thinkingFormat, "qwen");

    const [cloudAnthropic] = buildCloudModels([reasoningQwen], "dashscope.example", "anthropic-messages");
    const [cloudOpenAI] = buildCloudModels([reasoningQwen], "dashscope.example", "openai-completions");

    assert.equal(cloudAnthropic.api, "anthropic-messages");
    assert.equal(compatFlags(cloudAnthropic).supportsDeveloperRole, undefined);
    assert.equal(cloudOpenAI.api, "openai-completions");
    assert.equal(compatFlags(cloudOpenAI).supportsDeveloperRole, false);
    assert.equal(compatFlags(cloudOpenAI).supportsStore, false);
    assert.equal(compatFlags(cloudAnthropic).supportsStore, undefined);
  });
});

describe("openai-responses", () => {
  it("routes Cloud models to compatible-mode/v1 with api openai-responses", () => {
    const [cloud] = buildCloudModels([reasoningQwen], "dashscope.example", "openai-responses");
    assert.equal(cloud.api, "openai-responses");
    assert.equal(cloud.baseUrl, "https://dashscope.example/compatible-mode/v1");
    assert.equal(compatFlags(cloud).supportsDeveloperRole, false);
    assert.equal(compatFlags(cloud).supportsStore, false);
    // Derived from the family's Completions map — qwen3.7-max rejects `max`.
    assert.deepEqual(cloud.thinkingLevelMap, {
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    });
  });

  it("keeps DeepSeek on Chat Completions when the Cloud format is Anthropic", () => {
    const deepseek = { ...reasoningQwen, id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" };
    const [anthropicFmt] = buildCloudModels([deepseek], "dashscope.example", "anthropic-messages");
    const [responsesFmt] = buildCloudModels([deepseek], "dashscope.example", "openai-responses");
    assert.equal(anthropicFmt.api, "openai-completions");
    assert.equal(responsesFmt.api, "openai-responses");
  });

  it("falls back to Chat Completions for models the Responses endpoint rejects", () => {
    // Measured against the live endpoint: these ids answer `Agent
    // capabilities are not enabled` on /responses even though they work on
    // /chat/completions, so exposing them on Responses would only 400.
    assert.equal(supportsCloudResponses("kimi-k2.6"), false);
    assert.equal(supportsCloudResponses("glm-5.1"), false);
    assert.equal(supportsCloudResponses("MiniMax-M2.5"), false);
    assert.equal(supportsCloudResponses("qwen-max"), false);

    assert.equal(resolveCloudApi("kimi-k2.6", "openai-responses"), "openai-completions");
    assert.equal(resolveCloudApi("qwen3.8-max", "openai-responses"), "openai-responses");
    assert.equal(resolveCloudApi("kimi-k3", "openai-responses"), "openai-responses");
    // The Anthropic format still only re-routes DeepSeek.
    assert.equal(resolveCloudApi("kimi-k2.6", "anthropic-messages"), "anthropic-messages");
  });
});

describe("thinkingConfigFor", () => {
  it("keeps `off` sendable on the Anthropic path", () => {
    // pi clamps an unsupported level *upward*, so `off: null` would silently
    // turn "thinking off" into a real budget instead of sending
    // `thinking: {type: "disabled"}`.
    const cfg = thinkingConfigFor("qwen3.8-max", "anthropic-messages");
    assert.equal(cfg?.thinkingLevelMap.off, "off");
    assert.equal(cfg?.compat.thinkingFormat, "qwen");
    assert.equal(cfg?.compat.supportsReasoningEffort, undefined);
  });

  it("hides the levels Chat Completions cannot express per family", () => {
    const glm53 = thinkingConfigFor("glm-5.3", "openai-completions");
    // Only low/high/max are distinct — the docs coerce medium to high and
    // xhigh to max — so the coerced levels are hidden and pi clamps onto the
    // very same values.
    assert.deepEqual(glm53?.thinkingLevelMap, {
      off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max",
    });
    // Everything above `medium` is rejected on qwen3.6-plus.
    const qwen36 = thinkingConfigFor("qwen3.6-plus", "openai-completions");
    assert.equal(qwen36?.thinkingLevelMap.max, null);
    assert.equal(qwen36?.thinkingLevelMap.high, "high");
  });

  it("does not advertise reasoning_effort for GLM-4.5", () => {
    // GLM-4.5 rejects `reasoning_effort` outright, so pi must not send it.
    const cfg = thinkingConfigFor("glm-4.5", "openai-completions");
    assert.equal(cfg?.compat.supportsReasoningEffort, undefined);
  });

  it("returns undefined for non-reasoning ids", () => {
    assert.equal(thinkingConfigFor("qwen-turbo", "anthropic-messages"), undefined);
    assert.equal(thinkingConfigFor("qwen-turbo", "openai-completions"), undefined);
  });
});

describe("maxTokens vs API shape", () => {
  it("uses the per-model catalog ceiling on the Anthropic path", () => {
    // The endpoint rejects `max_tokens` above the model's own limit
    // (`Range of max_tokens should be [1, N]`), and the catalog reports N per
    // model, so that value is authoritative — never an id-based guess.
    const plus = { ...reasoningQwen, id: "qwen-plus", maxTokens: 32_768 };
    const coder = { ...reasoningQwen, id: "qwen3-coder-plus", maxTokens: 65_536 };
    const [cloud] = buildCloudModels([plus], "dashscope.example", "anthropic-messages");
    const [cloudCoder] = buildCloudModels([coder], "dashscope.example", "anthropic-messages");
    assert.equal(cloud.maxTokens, 32_768);
    assert.equal(cloudCoder.maxTokens, 65_536);
  });

  it("falls back to a conservative ceiling when the catalog has no row", () => {
    assert.equal(inferAnthropicMaxTokens("qwen3.7-max"), 32_768);
    assert.equal(inferAnthropicMaxTokens("qwen-turbo"), 8_192);
    // The open-weight qwen3-<size>b line is measured at 8192.
    assert.equal(inferAnthropicMaxTokens("qwen3-30b-a3b"), 8_192);
    // 0 is how producers mark "the catalog has no row".
    assert.equal(inferAnthropicMaxTokens("qwen3.7-max", 0), 32_768);
  });

  it("never lets an id-based guess masquerade as a catalog row", () => {
    // OpenAI-path guesses (glm-5.1 128000, kimi-k3 1048576) must not leak
    // onto the Anthropic path — DashScope rejects overshoots outright with
    // `Range of max_tokens should be [1, N]`. (deepseek is force-routed to
    // Completions anyway; glm-5.1 and kimi-k3 stay on the Anthropic path.)
    const [glm51] = buildCloudModels(
      [{ ...reasoningQwen, id: "glm-5.1", maxTokens: 0 }],
      "dashscope.example",
      "anthropic-messages",
    );
    assert.equal(glm51.maxTokens, 32_768);
    const [kimi] = buildCloudModels(
      [{ ...nonReasoning, id: "kimi-k3", maxTokens: 0 }],
      "dashscope.example",
      "anthropic-messages",
    );
    assert.equal(kimi.maxTokens, 8_192);
  });

  it("honors a catalog row on the Plan path as well", () => {
    const def = {
      id: "qwen3-coder-plus",
      name: "Qwen 3 Coder Plus",
      reasoning: true,
      input: ["text" as const],
      contextWindow: 262_144,
    };
    const [withCatalog] = buildPlanModels(
      [{ ...def, catalogMaxTokens: 65_536 }],
      "https://plan.example/openai",
      "https://plan.example/anthropic",
    );
    assert.equal(withCatalog.maxTokens, 65_536);
    const [fallback] = buildPlanModels([def], "https://plan.example/openai", "https://plan.example/anthropic");
    assert.equal(fallback.maxTokens, 32_768);
  });

  it("keeps catalog maxTokens on OpenAI Completions and Responses", () => {
    const fat = { ...reasoningQwen, maxTokens: 131_072 };
    const [completions] = buildCloudModels([fat], "dashscope.example", "openai-completions");
    const [responses] = buildCloudModels([fat], "dashscope.example", "openai-responses");
    assert.equal(completions.maxTokens, 131_072);
    assert.equal(responses.maxTokens, 131_072);
  });
});

describe("per-family capability table", () => {
  it("splits DeepSeek v4-pro/flash from v4.1 (distinct efforts differ)", () => {
    // deepseek-v4-pro/flash: only high/max are distinct (the docs coerce
    // low/medium to high and xhigh to max); v4.1 adds low and an off switch.
    assert.deepEqual(thinkingConfigFor("deepseek-v4-pro", "openai-completions")?.thinkingLevelMap, {
      off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max",
    });
    assert.deepEqual(thinkingConfigFor("deepseek-v4.1-flash", "openai-completions")?.thinkingLevelMap, {
      off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max",
    });
  });

  it("drops `max` for glm-5.1/glm-5, which reject it", () => {
    assert.equal(thinkingConfigFor("glm-5.1", "openai-completions")?.thinkingLevelMap.max, null);
    assert.equal(thinkingConfigFor("glm-5", "openai-completions")?.thinkingLevelMap.off, "none");
    assert.equal(thinkingConfigFor("glm-5.2", "openai-completions")?.thinkingLevelMap.max, "max");
  });

  it("derives Responses efforts from the family's Completions map", () => {
    // Docs: Responses accepts the same subset per family, with `off` as the
    // literal effort "none" wherever thinking can be disabled at all.
    assert.deepEqual(thinkingConfigFor("deepseek-v4-pro", "openai-responses")?.thinkingLevelMap, {
      off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max",
    });
    assert.equal(thinkingConfigFor("deepseek-v4.1-flash", "openai-responses")?.thinkingLevelMap.off, "none");
    // Measured narrower on Responses: qwen3.5–3.7 cap at medium.
    const qwen36 = thinkingConfigFor("qwen3.6-plus", "openai-responses");
    assert.equal(qwen36?.thinkingLevelMap.medium, "medium");
    assert.equal(qwen36?.thinkingLevelMap.high, null);
  });
});

describe("isVisionModel", () => {
  it("flags VL, Qwen 3.x Plus, Qwen 3.8, and Kimi", () => {
    assert.equal(isVisionModel("qwen-vl-max"), true);
    assert.equal(isVisionModel("qwen3.7-plus"), true);
    assert.equal(isVisionModel("qwen3.8-max"), true);
    assert.equal(isVisionModel("kimi-k2.7-code"), true);
    assert.equal(isVisionModel("qwen3.7-max"), false);
  });
});

describe("native catalog helpers", () => {
  it("parses Default-range CNY-per-million prices", () => {
    assert.deepEqual(
      parseApiV1Prices([
        {
          range_name: "Default",
          prices: [
            { type: "input", price: "2.4", price_unit: "元/百万Tokens" },
            { type: "output", price: "9.6", price_unit: "元/百万Tokens" },
          ],
        },
      ]),
      { input: 2.4, output: 9.6 },
    );
  });

  it("intersects the catalog with authorized inference models, and keeps the full list if empty", () => {
    const models = [{ id: "qwen3.8-max" }, { id: "glm-5.2" }, { id: "secret-model" }];
    const filtered = applyAuthorizedFilter(models, new Set(["qwen3.8-max", "glm-5.2"]));
    assert.equal(filtered.authorizedOnly, true);
    assert.deepEqual(filtered.models.map((m) => m.id), ["qwen3.8-max", "glm-5.2"]);

    const empty = applyAuthorizedFilter(models, new Set(["nope"]));
    assert.equal(empty.authorizedOnly, false);
    assert.equal(empty.models.length, 3);

    const missing = applyAuthorizedFilter(models, null);
    assert.equal(missing.authorizedOnly, false);
    assert.equal(missing.models, models);
  });

  it("formats QPS and per-period usage quotas", () => {
    assert.equal(
      formatQuota({
        model: "qwen3.8-max",
        modelLimit: { request_limit: 10, request_limit_period: 1, usage_limit: 1_000_000, usage_limit_field: "tokens", usage_limit_period: 60 },
        hasWorkspaceLimit: true,
      }),
      "10 req/s; 1,000,000 tokens/per-60s; workspace-limit set",
    );
  });
});
