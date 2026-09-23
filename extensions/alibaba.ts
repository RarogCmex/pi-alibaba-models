import { getAgentDir, type ExtensionAPI, type ProviderModelConfig, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import {
  ALIBABA_TOOLS_PARAMETERS,
  buildSidecarRequest,
  dashScopeErrorMessage,
  formatSidecarProgress,
  formatSidecarResult,
  formatSidecarRetry,
  pickSidecarModel,
  rewriteDashScopeBackendOverflowMessage,
  rewriteDashScopeRateLimitErrorMessage,
  runSidecarWithRetry,
  type SidecarAction,
  type SidecarStrategy,
} from "./sidecar.ts";

// ── Paths ─────────────────────────────────────────────────────────────
// Resolve through pi's own getAgentDir() so a relocated config directory
// (PI_CODING_AGENT_DIR, e.g. Nix/Guix store paths) is honored. Hardcoding
// ~/.pi/agent here made the extension miss /login credentials and scrub the
// wrong settings.json under an override.
const HOME_DIR = getAgentDir();
const CONFIG_PATH = path.join(HOME_DIR, "alibaba-config.json");
const AUTH_PATH = path.join(HOME_DIR, "auth.json");
// Model catalogs live in pi's own models store: `refreshModels` returns them,
// pi persists the snapshot and hands it back as `context.stored` for
// offline/cache-only initialization. The extension's own cache files are gone
// — these names survive only so upgrades and "Reset all" can delete leftovers.
const LEGACY_CACHE_PATHS = [
  path.join(HOME_DIR, "alibaba-plan-models.cache.json"),
  path.join(HOME_DIR, "alibaba-cloud-models.cache.json"),
  path.join(HOME_DIR, "alibaba-cloud-models.cache.v2.json"),
];
const removeLegacyCaches = () => {
  for (const p of LEGACY_CACHE_PATHS) { try { fs.unlinkSync(p); } catch {} }
};

// ── Thinking levels (measured against the live endpoint) ─────────────
//
// pi reads `thinkingLevelMap` as a tristate (verified against pi 0.87's
// clampThinkingLevel/getSupportedThinkingLevels): a string is the effort sent
// to the provider, `null` hides the level, and a request for a hidden level is
// routed to the nearest supported one (upward first). `xhigh`/`max` are only
// offered when they carry an explicit key.
//
// Everything below was probed against the workspace endpoint on 2026-09-22:
//   • the Anthropic path splits `maxTokens` into a thinking budget plus the
//     answer, so each model's own catalog ceiling is used (never an
//     id-based guess — the endpoint rejects anything larger).
//   • the OpenAI paths send `reasoning_effort` (some models also require
//     `enable_thinking`), and each family accepts a different subset.

// Anthropic path. DashScope rejects `thinking_budget` for Kimi alone
// (`Parameter thinking_budget is not supported`) — `--thinking off` still sends
// the field, so kimi must not be flagged as reasoning at all (see
// Fornace/pi-alibaba-models#9).
//
// `off` must be a *string*, not `null`: pi serializes `--thinking off` as
// `thinking: {type: "disabled"}` only when `thinkingLevelMap.off` is non-null
// (anthropic-messages path); with `null` the level is unsupported and pi
// clamps "off" up to a real thinking level. The `off` string itself is never
// sent — pi derives the thinking budget from the selected level's name.

type Level = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type Levels = Record<string, string | null>;
const LEVELS: Level[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// A level map listing only the literals a family really accepts; anything
// else is `null`, so pi hides it and routes a request for it to the nearest
// accepted level. Explicit strings express a documented coercion instead.
const levels = (accepted: Partial<Record<Level, string>>): Levels =>
  Object.fromEntries(LEVELS.map((l) => [l, accepted[l] ?? null])) as Levels;

const ANTHROPIC_ALL_LEVELS = levels({
  off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
});

const DEFAULT_PLAN_OPENAI = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const DEFAULT_PLAN_ANTHROPIC = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic";
const DEFAULT_CLOUD_DOMAIN = "dashscope-intl.aliyuncs.com";
const DEFAULT_CLOUD_US_DOMAIN = "dashscope-us.aliyuncs.com";
const DEFAULT_CLOUD_CN_DOMAIN = "dashscope.aliyuncs.com";
const DEFAULT_CLOUD_HK_DOMAIN = "cn-hongkong.dashscope.aliyuncs.com";

// Workspace-specific domains (recommended for Beijing/Singapore; required for
// Japan/Frankfurt/US). {wsid} = the Model Studio business-space ID.
const workspaceDomain = (wsid: string, region: string) => `${wsid}.${region}.maas.aliyuncs.com`;
const WSID_BEIJING = "cn-beijing";
const WSID_SINGAPORE = "ap-southeast-1";
const WSID_TOKYO = "ap-northeast-1";
const WSID_FRANKFURT = "eu-central-1";
const WSID_US = "us-east-1";

type CloudApiFormat = "anthropic-messages" | "openai-completions" | "openai-responses";

// ── Config / auth helpers ─────────────────────────────────────────────
interface AlibabaConfig {
  planOpenAI?: string;
  planAnthropic?: string;
  cloudDomain?: string;
  cloudApiFormat?: CloudApiFormat;
  // Override the context-window shown on a model's card in the picker.
  // Keyed by exact model id (e.g. "qwen3.7-plus"); the special key "*" applies
  // to every model that has no explicit entry. Values are token counts.
  // Useful when the inferred size is wrong for a brand-new model.
  contextWindowOverrides?: Record<string, number>;
  // When true (default), the Cloud catalog is filtered to the models the
  // account is authorized to call (GET /api/v1/models/permissions) whenever
  // that endpoint is reachable. Set to false to always show the full catalog.
  cloudAuthorizedOnly?: boolean;
  // Opt-in Pi tool `alibaba_tools`: a sidecar POST to DashScope built-in
  // tools (web_search / extractor / interpreter). Off by default so it
  // does not inflate every session or bill search on DeepSeek/Kimi/GLM.
  cloudSidecarTools?: boolean;
  // Optional Cloud model id for the sidecar (Qwen only). Empty = pick from catalog.
  cloudSidecarModel?: string;
  // Auto-upgrade a shared regional Cloud domain (dashscope.aliyuncs.com,
  // dashscope-intl…, dashscope-us…) to Alibaba's recommended workspace domain
  // {WorkspaceId}.{region}.maas.aliyuncs.com once the WorkspaceId has been
  // discovered AND the candidate domain passes a live probe. Default true;
  // explicitly picking a shared domain in /alibaba → Cloud — Change Domain
  // sets it to false (opt-out) so the upgrade never fights a manual choice.
  cloudAutoWorkspaceDomain?: boolean;
  // WorkspaceId discovered via GET /api/v1/models/limits (cached; also the
  // placeholder/fallback of the manual workspace-domain prompt).
  cloudWorkspaceId?: string;
  // Timestamp of the last failed auto-probe; retried at most once per 24h.
  cloudWorkspaceProbeFailedAt?: number;
  // Status-only metadata about the last successful catalog fetch (pi's models
  // store keeps the catalogs themselves).
  planFetchedAt?: number;
  cloudFetchedAt?: number;
  cloudAuthorizedFilteredLast?: boolean;
}

const readJSON = <T>(p: string, fallback: T): T => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; } catch { return fallback; }
};
const writeJSON = (p: string, data: unknown) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
};
const loadConfig = (): AlibabaConfig => readJSON<AlibabaConfig>(CONFIG_PATH, {});
const saveConfig = (c: AlibabaConfig) => writeJSON(CONFIG_PATH, c);
// auth.json entries: api_key ({type,key}) or oauth ({type,access,refresh,expires}).
interface AuthEntry {
  type?: string;
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
}
const readAuth = (): Record<string, AuthEntry> => readJSON<Record<string, AuthEntry>>(AUTH_PATH, {});
const writeAuth = (a: Record<string, AuthEntry>) => writeJSON(AUTH_PATH, a);

// pi used to expose ctx.modelRegistry.authStorage (in-memory + disk). Newer
// public types dropped it; keep using it when present so /login's
// "configured" label stays in sync, otherwise write auth.json directly.
interface AuthStorageLike {
  remove(id: string): void;
  get(id: string): AuthEntry | undefined;
  set(id: string, entry: AuthEntry): void;
}
function authStore(ctx: ExtensionCommandContext): AuthStorageLike {
  const live = (ctx.modelRegistry as { authStorage?: AuthStorageLike }).authStorage;
  if (live) return live;
  return {
    remove(id) { const a = readAuth(); delete a[id]; writeAuth(a); },
    get(id) { return readAuth()[id]; },
    set(id, entry) { const a = readAuth(); a[id] = entry; writeAuth(a); },
  };
}

// ── Plan model definitions ────────────────────────────────────────────
// Anthropic-compatible by default; deepseek forced to openai-completions.
interface PlanModelDef {
  id: string; name: string; reasoning: boolean; contextWindow: number;
  input: ("text" | "image")[]; compat?: { thinkingFormat: "qwen" }; openaiOnly?: boolean;
  // A real `max_output_tokens` if a Plan source ever reports one — none does
  // today (bare ids from /compatible-mode/v1/models), so resolveMaxTokens()
  // falls back to the conservative pair for these models.
  catalogMaxTokens?: number;
}

// ── Plan model fetch + parse ──────────────────────────────────────────

// ── Capability heuristics (shared by Plan + Cloud) ───────────────────
// The /models API only returns ids/names, not capabilities — so context
// window, reasoning, and vision are inferred from the id. Both the Plan
// and Cloud code paths route through these helpers so they never drift
// apart. Context windows are corrected here as new models ship.
export const isVisionModel = (id: string): boolean =>
  /vl|vision/i.test(id) || /^qwen3\.\d+-plus\b/i.test(id) || /^qwen3\.8\b/i.test(id) || /kimi/i.test(id);

// Whether a model accepts thinking controls at all. Named families answer
// through their capability row (the single source of truth); exotic ids fall
// back to the naming heuristic. The catalog's `Reasoning` tag is deliberately
// ignored — the /api/v1/models tag is unreliable in both directions (it marks
// `qwen-turbo` as reasoning even though the id accepts no thinking controls,
// and lists plain `qwen3-30b-a3b` without the tag although it answers with
// reasoning), so callers must never OR it back in. Roleplay `-character`
// variants of any family take no thinking controls. The Anthropic path is
// lenient — every family except Kimi accepts `thinking_budget` — so a miss
// here only costs the thinking picker.
const REASONING_HEURISTIC =
  /qwq|max|thinking|deepseek|minimax|glm|stepfun|unisound|^qwen3-\d|^qwen-(plus|flash)(-|$)|3\.[5-9]/i;

export const isReasoningModel = (id: string): boolean =>
  !/^kimi/i.test(id) &&
  !/-character/i.test(id) &&
  (capsFor(id).reasoning ?? REASONING_HEURISTIC.test(id));

// Infer context window (tokens) from model id. Sources:
// https://www.alibabacloud.com/help/en/model-studio/models
// https://www.alibabacloud.com/help/en/model-studio/glm
const inferContextWindow = (id: string, overrides?: Record<string, number>): number => {
  const o = overrides?.[id] ?? overrides?.["*"];
  if (typeof o === "number" && o > 0) return o;

  // Third-party models
  if (/^glm-?5\.2\b/i.test(id)) return 1048576;
  if (/^glm/i.test(id)) return 202752;
  if (/deepseek-?v4/i.test(id)) return 1048576;
  if (/^deepseek/i.test(id)) return 131072;
  if (/kimi/i.test(id)) return 262144;
  if (/minimax-?m2\.5/i.test(id)) return 196608;
  if (/minimax-?m2\.1/i.test(id)) return 204800;
  if (/minimax/i.test(id)) return 196608;

  // Qwen 3.7+: all 1M. Qwen 3.5/3.6: plus/flash = 1M, max/open-weight = 256K.
  if (/^qwen3\.([7-9]|\d{2,})\b/i.test(id)) return 1048576;
  if (/^qwen3\.[56]\b/i.test(id)) return /(plus|flash)/i.test(id) ? 1048576 : 262144;

  return 131072;
};

// Infer the maxTokens card value from the model id.
//
// pi's Anthropic path splits maxTokens into a thinking budget plus the answer
// (maxTokens − thinkingBudget). The safe value is the catalog's own
// `max_output_tokens`, which is per-model and already known to the endpoint
// (qwen-plus = 32768, qwen3-coder-plus = 65536, qwen3-30b-a3b = 8192,
// qwen3.8-max = 131072). Sending a larger number is rejected with
// `Range of max_tokens should be [1, N]`, so the catalog value is never
// exceeded. Models with no catalog row fall back to the conservative pair.
export const ANTHROPIC_MAX_TOKENS = 131072;
export const inferAnthropicMaxTokens = (id: string, catalogMax?: number): number => {
  if (typeof catalogMax === "number" && Number.isFinite(catalogMax) && catalogMax > 0) {
    return Math.min(catalogMax, ANTHROPIC_MAX_TOKENS);
  }
  // No catalog row: stay under every ceiling we know of. The open-weight
  // qwen3-<size>b line is measured at 8192 (qwen3-30b-a3b rejects more).
  if (/^qwen3-\d+b(-|$)/i.test(id)) return 8192;
  return isReasoningModel(id) ? 32768 : 8192;
};

// Catalog / OpenAI-path ceilings. Used for Chat Completions and Responses —
// those APIs do not share max_tokens between thinking and the answer the way
// Anthropic-compat does. Do not use these on the Anthropic path.
export const inferOpenAIMaxTokens = (id: string): number => {
  if (/^kimi-k?3/i.test(id)) return 1048576;
  if (/^deepseek-?v4/i.test(id)) return 384000;
  if (/^qwen3\.\d+-max\b/i.test(id)) return 131072;
  if (/^glm-?5\.2\b/i.test(id)) return 131072;
  if (/^glm-?5\.1\b/i.test(id)) return 128000;
  if (/^glm-?5\b/i.test(id)) return 16384;
  if (/^qwen3\./i.test(id)) return 65536;
  if (/^kimi-k2\.([6-9]|\d{2,})/i.test(id)) return 262144;
  if (/^kimi/i.test(id)) return 98304;
  if (/^minimax/i.test(id)) return 32768;
  return 16384;
};

// The one place a card's `maxTokens` is decided — shared by the Plan and
// Cloud builders so they cannot drift apart (they used to be twins and did).
// `catalogMax` is a *real* `max_output_tokens` from the catalog, or 0/
// undefined when the catalog has no row for the model: a guessed ceiling is
// never passed in as one, because DashScope rejects overshoots outright with
// `Range of max_tokens should be [1, N]`. Plan defs carry no catalog rows
// today, so they take the conservative fallback below.
export function resolveMaxTokens(id: string, api: string, catalogMax?: number): number {
  const catalog = typeof catalogMax === "number" && Number.isFinite(catalogMax) && catalogMax > 0
    ? catalogMax
    : undefined;
  return api === "anthropic-messages"
    ? inferAnthropicMaxTokens(id, catalog)
    : (catalog ?? inferOpenAIMaxTokens(id));
}

// Also shared by both builders: compatible-mode rejects the `developer` role
// (`developer is not one of ['system', ...]`) and has no `store` field, so
// both are forced off there and left untouched on the Anthropic path.
function mergeCompat(
  base: object | undefined,
  tc: ThinkingConfig | undefined,
  openai: boolean,
): ProviderModelConfig["compat"] {
  return openai
    ? {
        ...(base ?? {}),
        ...(tc?.compat ?? {}),
        supportsDeveloperRole: false,
        supportsStore: false,
      } as ProviderModelConfig["compat"]
    : ((tc?.compat ?? base) as ProviderModelConfig["compat"]);
}

// Every card capability is derived from the id here (plus real catalog or
// context-window rows), so a snapshot re-served from pi's store is re-derived
// too — extension updates and the user's context-window overrides apply
// without waiting for the next network fetch. Pure: overrides come from the
// caller, never from disk.
function deriveCard(
  id: string,
  m: { input?: ("text" | "image")[]; contextWindow?: number },
  overrides?: Record<string, number>,
) {
  const override = overrides?.[id] ?? overrides?.["*"];
  const vision = isVisionModel(id) || m.input?.includes("image");
  return {
    reasoning: isReasoningModel(id),
    input: (vision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    contextWindow: typeof override === "number" && override > 0
      ? override
      : (m.contextWindow && m.contextWindow > 0 ? m.contextWindow : inferContextWindow(id, overrides)),
  };
}

// ── Per-family capability table ──────────────────────────────────────
// Chat Completions (`reasoning_effort`, plus `enable_thinking` on the `qwen`
// thinking format) and Responses (`reasoning.effort`) accept a different
// subset per family. Measured 2026-09-22 with a *per-model*
// `max_completion_tokens` — probing with a budget above a model's own ceiling
// returns `Range of max_tokens…` and looks like a rejected effort. Accepted
// literals per family ("none" = thinking can be switched off):
//
//   qwen3.8                    none minimal low medium high xhigh max
//   qwen3.7/3.6/3.5            none minimal low medium high xhigh
//   qwen3-max / -coder / next  none minimal low medium high xhigh max
//   qwen-plus/flash/turbo      none minimal low medium high xhigh max
//   qwen3.8-2.4t / 3.7-preview            minimal low medium high xhigh max
//   glm-5.3                               low             high      max
//   glm-5.2 / glm-4.x          none minimal low medium high xhigh max
//   glm-5.1 / glm-5            none minimal low medium high xhigh
//   deepseek-v4-pro/flash                 low medium high xhigh max
//   deepseek-v4.1-*           none minimal low medium high xhigh max
//   kimi-k3                    none minimal low medium high xhigh max
//   kimi-k2.5/2.6/2.7          none minimal low medium high xhigh
//   MiniMax-M2.5                          low medium high xhigh
//   MiniMax-M2.1               none minimal low medium high xhigh max
//
// "Accepted" is not "distinct": the docs document the coercions explicitly
// for some families (deepseek-v4-pro/flash: low/medium → high, xhigh → max;
// deepseek-v4.1: minimal → low, medium/xhigh → high; glm-5.3: medium → high,
// xhigh → max — help.aliyun.com/…/deepseek-api, …/glm). Where they do, the
// map lists only the distinct literals and hides the coerced ones, so pi's
// own clamp routes a request to exactly the documented effort.
//
// `off` is a separate mechanism per path. Completions: pi sends
// `enable_thinking: false` (the map's `off` value is never sent), and
// `off: null` hides the level for families that reject the field — MiniMax,
// which switches thinking through `thinking.type: "adaptive" | "disabled"`,
// a parameter pi's OpenAI paths never emit. Responses: pi sends
// `reasoning: {effort: <off value>}`, so `off` is the literal `"none"`
// wherever thinking can be disabled at all.
const L_ALL = levels({ off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
const L_NO_MAX = levels({ off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh" });
const L_ALWAYS_ON = levels({ minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
const L_DEEPSEEK_V4 = levels({ high: "high", max: "max" });
const L_DEEPSEEK_V41 = levels({ off: "none", low: "low", high: "high", max: "max" });
const L_GLM53 = levels({ low: "low", high: "high", max: "max" });
const L_MINIMAX25 = levels({ low: "low", medium: "medium", high: "high", xhigh: "xhigh" });
const L_MEDIUM_CEILING = levels({ off: "none", minimal: "minimal", low: "low", medium: "medium" });
const L_NONE_ONLY = levels({ off: "none" });

// Responses accepts the same effort subset as Completions per family (the
// docs point back to the Chat Completions table), with `off` expressible as
// the literal effort "none" wherever thinking can be switched off at all.
// Only families measured *narrower* on Responses carry an explicit override.
const responsesFrom = (completions: Levels): Levels => ({
  ...completions,
  off: completions.off ? "none" : null,
});

interface FamilyCaps {
  /** Present on named families; exotic ids fall back to REASONING_HEURISTIC. */
  reasoning?: boolean;
  completions: Levels;
  /** false → the family rejects `reasoning_effort` outright (GLM-4.5). */
  effort?: boolean;
  /** Narrower than the derived Responses map (measured); else derived. */
  responses?: Levels;
  /** /responses can serve this family at all (measured 2026-09-22). */
  responsesCapable?: boolean;
  /** DashScope prompt caching documented for this family. */
  cache?: boolean;
}

// One row per family — the single place a new family or snapshot touches.
// Order matters: the first match wins, most specific id first.
const FAMILIES: Array<[RegExp, FamilyCaps]> = [
  [/^qwen3\.8-2\.4t/i, { reasoning: true, completions: L_ALWAYS_ON, responsesCapable: true, cache: true }],
  [/^qwen3\.7-max-(preview|\d{4}-\d{2}-\d{2})/i, { reasoning: true, completions: L_ALWAYS_ON, responsesCapable: true, cache: true }],
  [/^qwen3\.8/i, { reasoning: true, completions: L_ALL, responsesCapable: true, cache: true }],
  [/^qwen3\.7-(max|plus)/i, { reasoning: true, completions: L_NO_MAX, responsesCapable: true, cache: true }],
  [/^qwen3\.[5-7]/i, { reasoning: true, completions: L_NO_MAX, responses: L_MEDIUM_CEILING, responsesCapable: true, cache: true }],
  [/^qwen3-max|^qwen3-(coder|next)/i, { reasoning: true, completions: L_ALL, responsesCapable: true, cache: true }],
  // Open-weight qwen3-<size>b: no prompt caching documented (qwen3-30b-a3b).
  [/^qwen3-\d/i, { reasoning: true, completions: L_ALL, responsesCapable: true }],
  [/^qwen-(plus|flash)(-|$)/i, { reasoning: true, completions: L_ALL, responses: L_NONE_ONLY, responsesCapable: true, cache: true }],
  [/^qwen-turbo(-|$)/i, { reasoning: false, completions: L_ALL, responses: L_NONE_ONLY, responsesCapable: true, cache: true }],
  [/^glm-?5\.3/i, { reasoning: true, completions: L_GLM53, responsesCapable: true, cache: true }],
  [/^glm-?5\.2/i, { reasoning: true, completions: L_ALL, responsesCapable: true, cache: true }],
  [/^glm-?4\.6/i, { reasoning: true, completions: L_ALL, responsesCapable: true, cache: true }],
  [/^glm-?4\.5/i, { reasoning: true, completions: L_ALL, effort: false, responses: L_ALWAYS_ON, cache: true }],
  [/^glm-?5\.1|^glm-?5\b/i, { reasoning: true, completions: L_NO_MAX, cache: true }],
  [/^glm/i, { reasoning: true, completions: L_ALL, cache: true }],
  [/^deepseek-?v4\.1/i, { reasoning: true, completions: L_DEEPSEEK_V41, responsesCapable: true, cache: true }],
  [/^deepseek-?v4/i, { reasoning: true, completions: L_DEEPSEEK_V4, responsesCapable: true, cache: true }],
  [/^deepseek-?v3\.1/i, { reasoning: true, completions: L_ALL, responsesCapable: true, cache: true }],
  [/^deepseek/i, { reasoning: true, completions: L_ALL, cache: true }],
  [/^minimax-?m2\.5/i, { reasoning: true, completions: L_MINIMAX25, cache: true }],
  [/^minimax-?m2\.1/i, { reasoning: true, completions: L_ALWAYS_ON, responsesCapable: true, cache: true }],
  [/^minimax/i, { reasoning: true, completions: L_ALL, cache: true }],
  [/^kimi-k3/i, { reasoning: false, completions: L_ALL, responsesCapable: true, cache: true }],
  [/^kimi/i, { reasoning: false, completions: L_NO_MAX, cache: true }],
];

const DEFAULT_CAPS: FamilyCaps = { completions: L_ALL };
function capsFor(id: string): FamilyCaps {
  for (const [match, caps] of FAMILIES) if (match.test(id)) return caps;
  return DEFAULT_CAPS;
}

// DashScope prompt caching (help.aliyun.com/zh/model-studio/context-cache):
// implicit caching is on for these families, and the explicit
// `cache_control: {type: "ephemeral"}` window is 5 minutes, renewed on a hit —
// no longer tier is published. `short: 300` is the conservative end of that
// window; it makes the model eligible for pi's cache warming (the global
// `cacheWarming` setting decides off/streaming/idle). `long` stays unset —
// there is no published 1h-class lifetime. The open-weight qwen3-<size>b line
// has no caching at all and unknown families stay ineligible.
const PROMPT_CACHE: NonNullable<ProviderModelConfig["promptCache"]> = { short: 300 };
const promptCacheFor = (id: string): ProviderModelConfig["promptCache"] =>
  capsFor(id).cache ? PROMPT_CACHE : undefined;

const OPENAI_BASE_COMPAT = {
  thinkingFormat: "qwen" as const,
  supportsDeveloperRole: false,
  supportsStore: false,
};

export interface ThinkingConfig {
  thinkingLevelMap: Record<string, string | null>;
  compat: {
    thinkingFormat: "qwen";
    supportsReasoningEffort?: boolean;
    supportsDeveloperRole?: boolean;
    supportsStore?: boolean;
  };
}

export function thinkingConfigFor(id: string, api: string): ThinkingConfig | undefined {
  if (!isReasoningModel(id)) return undefined;
  const caps = capsFor(id);
  if (api === "openai-completions") {
    return {
      thinkingLevelMap: { ...caps.completions },
      compat: { ...OPENAI_BASE_COMPAT, ...(caps.effort === false ? {} : { supportsReasoningEffort: true }) },
    };
  }
  if (api === "openai-responses") {
    return {
      thinkingLevelMap: { ...(caps.responses ?? responsesFrom(caps.completions)) },
      compat: { ...OPENAI_BASE_COMPAT },
    };
  }
  // Anthropic-compatible: pi derives the thinking budget from the level name,
  // so every level stays selectable and `--thinking off` serializes as
  // `thinking: {type: "disabled"}` (see ANTHROPIC_ALL_LEVELS).
  return { thinkingLevelMap: { ...ANTHROPIC_ALL_LEVELS }, compat: { thinkingFormat: "qwen" } };
}

// Cloud models the Responses endpoint cannot serve (measured 2026-09-22).
// When the user picks the Responses Cloud format, models outside this set stay
// on Chat Completions instead of being exposed and then 400ing on send.
// Families are matched by id so brand-new snapshots inherit the behaviour.
export function supportsCloudResponses(id: string): boolean {
  return capsFor(id).responsesCapable === true;
}

export function resolveCloudApi(id: string, fmt: CloudApiFormat): CloudApiFormat {
  if (fmt === "anthropic-messages" && /deepseek/i.test(id)) return "openai-completions";
  if (fmt === "openai-responses" && !supportsCloudResponses(id)) return "openai-completions";
  return fmt;
}

// Heuristic: turn a bare model id (from /v1/models API) into a full PlanModelDef.
function inferPlanDef(id: string, overrides?: Record<string, number>): PlanModelDef {
  const openaiOnly = /deepseek/i.test(id);
  const isVision = isVisionModel(id);
  const isReasoning = isReasoningModel(id);
  return {
    id,
    name: prettyName(id),
    reasoning: isReasoning,
    input: isVision ? ["text", "image"] : ["text"],
    contextWindow: inferContextWindow(id, overrides),
    compat: isReasoning ? { thinkingFormat: "qwen" } : undefined,
    openaiOnly,
  };
}

// Primary source: the Plan endpoint's own /compatible-mode/v1/models.
async function fetchPlanModelsFromAPI(credentials?: { access?: string; refresh?: string }): Promise<PlanModelDef[]> {
  const key = credentials?.access;
  if (!key) return [];
  const ep = resolvePlanEndpoints(credentials);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${ep.openai}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { id: string }[] };
    if (!json.data?.length) throw new Error("No models in response");
    // Filter out image/audio/etc — only keep chat-capable models.
    const exclude = /(image|audio|video|tts|asr|embed|vector|rerank|wan|omni|livetranslate|realtime)/i;
    const overrides = loadConfig().contextWindowOverrides;
    return json.data
      .filter((m) => !exclude.test(m.id))
      .map((m) => inferPlanDef(m.id, overrides));
  } finally { clearTimeout(t); }
}

function prettyName(id: string): string {
  // qwen3.6-plus → "Qwen 3.6 Plus", glm-5 → "GLM-5", MiniMax-M2.5 → "MiniMax M2.5"
  if (/^qwen/i.test(id)) {
    return id.replace(/^qwen/i, "Qwen ").replace(/-/g, " ").replace(/\b([a-z])/g, (s) => s.toUpperCase());
  }
  if (/^glm/i.test(id)) return id.toUpperCase();
  if (/^kimi/i.test(id)) return id.replace(/^kimi/i, "Kimi").replace(/-/g, " ");
  if (/^minimax/i.test(id)) return id.replace(/-/g, " ");
  if (/^deepseek/i.test(id)) return id.replace(/^deepseek/i, "DeepSeek").replace(/-/g, " ");
  return id;
}

async function fetchPlanModels(_force = false, credentials?: { access?: string; refresh?: string }): Promise<PlanModelDef[]> {
  if (!credentials?.access) return [];
  const apiModels = await fetchPlanModelsFromAPI(credentials);
  if (!apiModels.length) throw new Error("Plan model fetch returned no chat models");
  return apiModels;
}

// ── Plan endpoint resolution ──────────────────────────────────────────
function resolvePlanEndpoints(credentials?: { access?: string; refresh?: string }): { openai: string; anthropic: string } {
  if (credentials?.refresh) {
    try {
      const parsed = JSON.parse(credentials.refresh);
      if (parsed.openai && parsed.anthropic) return { openai: parsed.openai, anthropic: parsed.anthropic };
    } catch {}
  }
  const cfg = loadConfig();
  return {
    openai: cfg.planOpenAI || DEFAULT_PLAN_OPENAI,
    anthropic: cfg.planAnthropic || DEFAULT_PLAN_ANTHROPIC,
  };
}

export function buildPlanModels(
  defs: PlanModelDef[],
  openaiUrl: string,
  anthropicUrl: string,
  overrides?: Record<string, number>,
): ProviderModelConfig[] {
  return defs.map((m) => {
    const useOpenAI = !!m.openaiOnly || /deepseek/i.test(m.id);
    const api = (useOpenAI ? "openai-completions" : "anthropic-messages") as "anthropic-messages" | "openai-completions";
    const tc = thinkingConfigFor(m.id, api);
    return {
      id: m.id, name: m.name,
      ...deriveCard(m.id, m, overrides),
      maxTokens: resolveMaxTokens(m.id, api, m.catalogMaxTokens),
      promptCache: promptCacheFor(m.id),
      compat: mergeCompat(m.compat, tc, useOpenAI),
      thinkingLevelMap: tc?.thinkingLevelMap,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      baseUrl: useOpenAI ? openaiUrl : anthropicUrl,
      api,
    };
  });
}

// ── Cloud builders ────────────────────────────────────────────────────

interface ApiV1Model {
  model: string;
  name?: string;
  capabilities?: string[];
  inference_metadata?: { request_modality?: string[]; response_modality?: string[] };
  model_info?: {
    context_window?: number | null;
    max_output_tokens?: number | null;
  };
  prices?: Array<{
    range_name?: string;
    prices?: Array<{ type?: string; price?: string; price_unit?: string }>;
  }>;
}

export function parseApiV1Prices(prices: ApiV1Model["prices"]): { input: number; output: number } {
  const out = { input: 0, output: 0 };
  if (!prices?.length) return out;
  const range = prices.find((p) => p.range_name === "Default") ?? prices[0];
  for (const item of range?.prices ?? []) {
    if (!item.type || !item.price || !/百万/i.test(item.price_unit ?? "")) continue;
    const n = Number(item.price);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (/input/i.test(item.type)) out.input = n;
    else if (/output/i.test(item.type)) out.output = n;
  }
  return out;
}

export function applyAuthorizedFilter<T extends { id: string }>(
  models: T[],
  authorized: Set<string> | null,
): { models: T[]; authorizedOnly: boolean } {
  if (!authorized) return { models, authorizedOnly: false };
  const filtered = models.filter((m) => authorized.has(m.id));
  if (!filtered.length) return { models, authorizedOnly: false };
  return { models: filtered, authorizedOnly: true };
}

async function fetchCloudModelsV1(domain: string, apiKey: string): Promise<ProviderModelConfig[] | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const models: ProviderModelConfig[] = [];
    const exclude = /(image|audio|video|tts|asr|embed|vector|rerank|wan|omni|livetranslate|realtime|3d|face)/i;
    for (let page = 1; page <= 5; page++) {
      const params = new URLSearchParams({ capabilities: "TG", page_no: String(page), page_size: "100" });
      const res = await fetch(`https://${domain}/api/v1/models?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { output?: { total?: number; models?: ApiV1Model[] } };
      const output = json.output;
      if (!output?.models?.length) break;
      const overrides = loadConfig().contextWindowOverrides;
      for (const m of output.models) {
        if (!m.model || exclude.test(m.model)) continue;
        const caps = m.capabilities ?? [];
        const reqMod = m.inference_metadata?.request_modality ?? [];
        const ctx = m.model_info?.context_window;
        const maxOut = m.model_info?.max_output_tokens;
        const price = parseApiV1Prices(m.prices);
        models.push({
          id: m.model,
          name: m.name || m.model,
          // The catalog's `Reasoning` tag is deliberately ignored (see
          // isReasoningModel) — OR-ing it in reintroduces its false positives
          // (`qwen-turbo`) and its misses (`qwen3-30b-a3b`).
          reasoning: isReasoningModel(m.model),
          input: isVisionModel(m.model) || reqMod.includes("Image") || caps.includes("VU")
            ? (["text", "image"] as ("text" | "image")[])
            : (["text"] as ("text" | "image")[]),
          cost: { input: price.input, output: price.output, cacheRead: 0, cacheWrite: 0 },
          contextWindow: typeof ctx === "number" && ctx > 0 ? ctx : inferContextWindow(m.model, overrides),
          // 0 = "the catalog has no max_output_tokens row". A guessed ceiling
          // must never masquerade as a catalog value here — resolveMaxTokens
          // treats one as authoritative and DashScope rejects overshoots.
          maxTokens: typeof maxOut === "number" && maxOut > 0 ? maxOut : 0,
        });
      }
      if (models.length >= (output.total ?? 0) || output.models.length < 100) break;
    }
    return models.length ? models : null;
  } catch {
    return null;
  } finally { clearTimeout(t); }
}

async function fetchCloudModelsCompat(domain: string, apiKey: string): Promise<ProviderModelConfig[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`https://${domain}/compatible-mode/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { id: string; name?: string }[] };
    if (!json.data?.length) throw new Error("No models");
    const exclude = /(image|audio|video|tts|asr|embed|vector|rerank|wan|omni|livetranslate|realtime)/i;
    const overrides = loadConfig().contextWindowOverrides;
    return json.data
      .filter((m) => !exclude.test(m.id))
      .map((m) => {
        const isVision = isVisionModel(m.id);
        const isReasoning = isReasoningModel(m.id);
        return {
          id: m.id,
          name: m.name || m.id,
          reasoning: isReasoning,
          input: isVision ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: inferContextWindow(m.id, overrides),
          // compatible-mode /v1/models carries no catalog rows at all.
          maxTokens: 0,
        };
      });
  } finally { clearTimeout(t); }
}

async function fetchCloudAuthorizedModels(domain: string, apiKey: string): Promise<Set<string> | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const authorized = new Set<string>();
    for (let page = 1; page <= 5; page++) {
      const params = new URLSearchParams({
        authorization_scope: "AUTHORIZED",
        action: "INFERENCE",
        page_no: String(page),
        page_size: "200",
      });
      const res = await fetch(`https://${domain}/api/v1/models/permissions?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        output?: {
          total?: number;
          permissions?: Array<{ model?: string; permissions?: { inference?: boolean } }>;
        };
      };
      const output = json.output;
      if (!output?.permissions?.length) break;
      for (const p of output.permissions) {
        if (p.model && p.permissions?.inference) authorized.add(p.model);
      }
      if (output.permissions.length < 200) break;
    }
    return authorized.size ? authorized : null;
  } catch {
    return null;
  } finally { clearTimeout(t); }
}

async function fetchCloudModels(domain: string, apiKey: string, _force = false): Promise<{ models: ProviderModelConfig[]; authorizedOnly: boolean }> {
  const v1 = await fetchCloudModelsV1(domain, apiKey);
  if (v1) {
    let models = v1;
    let authorizedOnly = false;
    if (loadConfig().cloudAuthorizedOnly !== false) {
      const authorized = await fetchCloudAuthorizedModels(domain, apiKey);
      const filtered = applyAuthorizedFilter(models, authorized);
      models = filtered.models;
      authorizedOnly = filtered.authorizedOnly;
    }
    return { models, authorizedOnly };
  }
  return { models: await fetchCloudModelsCompat(domain, apiKey), authorizedOnly: false };
}

interface ApiV1QuotaLimit {
  request_limit?: number | null;
  request_limit_period?: number | null;
  usage_limit?: number | null;
  usage_limit_field?: string | null;
  usage_limit_period?: number | null;
  async_user_queue_limit?: number | null;
  async_user_concurrency_limit?: number | null;
}

export interface CloudQuotaInfo {
  model: string;
  modelLimit: ApiV1QuotaLimit;
  hasWorkspaceLimit: boolean;
}

async function fetchCloudQuotas(domain: string, apiKey: string): Promise<Map<string, CloudQuotaInfo> | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const map = new Map<string, CloudQuotaInfo>();
    let total = Infinity;
    for (let page = 1; page <= 5 && map.size < total; page++) {
      const params = new URLSearchParams({ page_no: String(page), page_size: "100" });
      const res = await fetch(`https://${domain}/api/v1/models/limits?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        output?: {
          total?: number;
          quotas?: Array<{ model: string; model_limit?: ApiV1QuotaLimit | null; workspace_limit?: ApiV1QuotaLimit | null }>;
        };
      };
      const output = json.output;
      if (!output?.quotas?.length) break;
      total = output.total ?? total;
      for (const q of output.quotas) {
        if (!q.model || !q.model_limit) continue;
        map.set(q.model, { model: q.model, modelLimit: q.model_limit, hasWorkspaceLimit: !!q.workspace_limit });
      }
      if (output.quotas.length < 100) break;
    }
    return map.size ? map : null;
  } catch {
    return null;
  } finally { clearTimeout(t); }
}

export function formatQuota(q: CloudQuotaInfo): string {
  const l = q.modelLimit;
  let s = `${l.request_limit ?? 0} ${l.request_limit_period === 1 ? "req/s" : `req/${l.request_limit_period ?? 60}s`}`;
  if (l.usage_limit != null && l.usage_limit_field && l.usage_limit_period != null) {
    s += `; ${l.usage_limit.toLocaleString("en-US")} ${l.usage_limit_field}/per-${l.usage_limit_period}s`;
  } else {
    s += "; usage: none";
  }
  if (l.async_user_queue_limit != null || l.async_user_concurrency_limit != null) {
    s += `; async queue ${l.async_user_queue_limit ?? "—"} / concurrency ${l.async_user_concurrency_limit ?? "—"}`;
  }
  if (q.hasWorkspaceLimit) s += "; workspace-limit set";
  return s;
}

function cloudDefaultTransport(domain: string, fmt: CloudApiFormat): { api: CloudApiFormat; baseUrl: string } {
  const api = fmt === "anthropic-messages" ? "anthropic-messages" : fmt;
  return {
    api,
    baseUrl: api === "anthropic-messages"
      ? `https://${domain}/apps/anthropic`
      : `https://${domain}/compatible-mode/v1`,
  };
}

export function buildCloudModels(
  models: ProviderModelConfig[],
  domain: string,
  fmt: string,
  overrides?: Record<string, number>,
): ProviderModelConfig[] {
  const format = (fmt as CloudApiFormat) || "anthropic-messages";
  return models.map((m) => {
    const api = resolveCloudApi(m.id, format);
    const tc = thinkingConfigFor(m.id, api);
    const openai = api !== "anthropic-messages";
    return {
      ...m,
      ...deriveCard(m.id, m, overrides),
      maxTokens: resolveMaxTokens(m.id, api, m.maxTokens),
      promptCache: promptCacheFor(m.id),
      thinkingLevelMap: tc?.thinkingLevelMap,
      compat: mergeCompat(m.compat, tc, openai),
      // DashScope's session cache makes multi-turn prefix hits predictable on
      // Responses (5-min window renewed on hit, reads billed at ~10% instead
      // of the implicit cache's indeterminate TTL and 20–25% reads) and is
      // opt-in per request. Models re-routed to Completions stay unmarked.
      headers: api === "openai-responses" ? { "x-dashscope-session-cache": "enable" } : undefined,
      baseUrl: openai ? `https://${domain}/compatible-mode/v1` : `https://${domain}/apps/anthropic`,
      api,
    };
  });
}

// ── Cloud credential resolution ──────────────────────────────────────
// The Cloud provider can authenticate either from a key saved via /login
// (auth.json) OR from the DASHSCOPE_API_KEY env var (its apiKey is
// "$DASHSCOPE_API_KEY"). Either one lets us fetch the real catalog — so we
// always prefer the live list and only fall back to the login seed below
// when there is no credential at all.
const readCloudKey = (): string | null => {
  try {
    const c = readAuth()["alibaba-cloud"];
    const k = c?.key || c?.access;
    if (k) return k;
  } catch {}
  return process.env.DASHSCOPE_API_KEY || null;
};

// ── Workspace-domain auto-upgrade ────────────────────────────────────
// Alibaba recommends migrating from the shared regional domains to workspace
// domains {WorkspaceId}.{region}.maas.aliyuncs.com (better performance and
// stability; the rate-limit and permissions endpoints are documented there).
// The docs call the WorkspaceId console-only, but the key's workspace is
// empirically discoverable: GET /api/v1/models/limits returns `workspace_id`
// on every quota row — even on the shared domains where the endpoint itself
// is undocumented. Discovery is best-effort and never trusted blindly: the
// candidate domain must pass a live probe before the config is switched.

const SHARED_DOMAIN_REGIONS: Record<string, string> = {
  [DEFAULT_CLOUD_CN_DOMAIN]: WSID_BEIJING,
  [DEFAULT_CLOUD_DOMAIN]: WSID_SINGAPORE,
  [DEFAULT_CLOUD_US_DOMAIN]: WSID_US,
};

// Regions that have workspace domains {wsid}.{region}.maas.aliyuncs.com.
const WORKSPACE_REGIONS: string[] = [WSID_BEIJING, WSID_SINGAPORE, WSID_TOKYO, WSID_FRANKFURT, WSID_US];

// Reverse of SHARED_DOMAIN_REGIONS — where to rediscover the workspace from
// when a configured workspace domain stops accepting the current key (the key
// may have been swapped between runs for one from another region/site). Tokyo
// and Frankfurt have no shared domain — they are workspace-only regions.
export const REGION_SHARED_DOMAINS: Record<string, string> = {
  [WSID_BEIJING]: DEFAULT_CLOUD_CN_DOMAIN,
  [WSID_SINGAPORE]: DEFAULT_CLOUD_DOMAIN,
  [WSID_US]: DEFAULT_CLOUD_US_DOMAIN,
};

// Parse an already-configured workspace domain — used to tell “nothing to do,
// you are on one” apart from “this domain never auto-upgrades” (HK/custom).
export function parseWorkspaceCloudDomain(domain: string): { wsid: string; region: string } | null {
  const m = domain.trim().toLowerCase().match(/^([a-z0-9][a-z0-9-]{2,63})\.([a-z0-9-]+)\.maas\.aliyuncs\.com$/);
  if (!m) return null;
  const wsid = sanitizeWorkspaceId(m[1]);
  if (!wsid || !WORKSPACE_REGIONS.includes(m[2])) return null;
  return { wsid, region: m[2] };
}

// Region a shared domain belongs to, or null for anything else. Hong Kong,
// custom hosts, and workspace domains themselves are never auto-upgraded
// (Tokyo/Frankfurt have no shared domain — they are workspace-only).
export const regionForSharedCloudDomain = (domain: string): string | null =>
  SHARED_DOMAIN_REGIONS[domain.trim().toLowerCase()] ?? null;

// The WorkspaceId is interpolated into a hostname, so accept only
// conservative characters (real ids look like `llm-n9h5iz3a78nfmn7k`).
export function sanitizeWorkspaceId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{2,63}$/.test(id) ? id : null;
}

export function parseWorkspaceIdFromLimits(json: unknown): string | null {
  const quotas = (json as { output?: { quotas?: unknown } } | null)?.output?.quotas;
  if (!Array.isArray(quotas)) return null;
  for (const q of quotas) {
    const id = sanitizeWorkspaceId((q as { workspace_id?: unknown } | null)?.workspace_id);
    if (id) return id;
  }
  return null;
}

export const WORKSPACE_PROBE_RETRY_MS = 24 * 60 * 60 * 1000;

// Pure boot decision: try the auto-upgrade now? Fires only while the user has
// not opted out, the effective domain is a shared regional one, and the last
// failed probe (if any) is older than the 24h backoff. Zero network here —
// the orchestrator below stays free on every launch once upgraded.
export function shouldAutoUpgradeWorkspace(
  cfg: { cloudAutoWorkspaceDomain?: boolean; cloudWorkspaceProbeFailedAt?: number },
  domain: string,
  now = Date.now(),
): boolean {
  if (cfg.cloudAutoWorkspaceDomain === false) return false;
  if (!regionForSharedCloudDomain(domain)) return false;
  const failedAt = cfg.cloudWorkspaceProbeFailedAt;
  if (typeof failedAt === "number" && Number.isFinite(failedAt) && now - failedAt < WORKSPACE_PROBE_RETRY_MS) return false;
  return true;
}

// Ask a domain which workspace this key belongs to (quota rows carry it).
export async function detectCloudWorkspaceId(domain: string, apiKey: string): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const params = new URLSearchParams({ page_no: "1", page_size: "10" });
    const res = await fetch(`https://${domain}/api/v1/models/limits?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return parseWorkspaceIdFromLimits(await res.json());
  } catch {
    return null;
  } finally { clearTimeout(t); }
}

// Cheap GET proving the candidate workspace domain resolves and serves the key.
export async function probeWorkspaceDomain(domain: string, apiKey: string): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`https://${domain}/api/v1/models?page_no=1&page_size=1`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { success?: boolean; output?: unknown };
    return json.success !== false && json.output != null;
  } catch {
    return false;
  } finally { clearTimeout(t); }
}

export type WorkspaceUpgradeResult =
  | { status: "upgraded"; domain: string; wsid: string }
  | { status: "already"; domain: string; reason: string }
  | { status: "demoted"; domain: string; reason: string }
  | { status: "unchanged"; reason: string }
  | { status: "failed"; reason: string };

// Detect → probe → switch, persisting the outcome to alibaba-config.json.
// `force` (from the /alibaba menu) ignores the opt-out flag and the backoff.
export async function upgradeCloudDomainToWorkspace(apiKey: string, force = false): Promise<WorkspaceUpgradeResult> {
  const cfg = loadConfig();
  const domain = cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN;
  const region = regionForSharedCloudDomain(domain);
  if (!region) {
    const ws = parseWorkspaceCloudDomain(domain);
    if (ws) {
      if (!force) return { status: "already", domain, reason: `already on the workspace domain ${domain}` };
      // Forced from the menu: verify the CURRENT key against the domain — it
      // may have been swapped between runs. Same-region workspace swaps are a
      // non-event (DashScope authenticates the key, not the wsid↔key pair);
      // a key from another site (CN ↔ intl ↔ US) gets 401, so rediscover the
      // workspace via the shared domains, current region first.
      if (await probeWorkspaceDomain(domain, apiKey)) {
        return { status: "already", domain, reason: `already on the workspace domain ${domain} (current key verified)` };
      }
      const primary = REGION_SHARED_DOMAINS[ws.region];
      const order = primary
        ? [primary, ...Object.values(REGION_SHARED_DOMAINS).filter((d) => d !== primary)]
        : Object.values(REGION_SHARED_DOMAINS);
      const probed: string[] = [];
      for (const shared of order) {
        const wsid = await detectCloudWorkspaceId(shared, apiKey);
        if (wsid) {
          const target = workspaceDomain(wsid, SHARED_DOMAIN_REGIONS[shared]);
          if (target === domain) {
            return { status: "failed", reason: `${domain} rejected the current key despite mapping to the same WorkspaceId ${wsid} — is the domain reachable?` };
          }
          if (await probeWorkspaceDomain(target, apiKey)) {
            cfg.cloudWorkspaceId = wsid;
            cfg.cloudDomain = target;
            delete cfg.cloudWorkspaceProbeFailedAt;
            saveConfig(cfg);
            return { status: "upgraded", domain: target, wsid };
          }
          probed.push(target);
        }
        // Last resort: this shared domain serves the current key even though
        // it revealed no usable workspace (e.g. models/limits is not offered
        // on that site). Demote only on positive probe evidence, and opt out
        // of the auto-upgrade so it cannot flip back into the same failure.
        if (await probeWorkspaceDomain(shared, apiKey)) {
          cfg.cloudDomain = shared;
          cfg.cloudAutoWorkspaceDomain = false;
          delete cfg.cloudWorkspaceId;
          delete cfg.cloudWorkspaceProbeFailedAt;
          saveConfig(cfg);
          return {
            status: "demoted",
            domain: shared,
            reason: `${domain} rejected the current key and no workspace was discoverable for it`,
          };
        }
      }
      return {
        status: "failed",
        reason: `${domain} rejected the current key (or is unreachable) and no shared domain accepted it either` +
          (probed.length ? ` (probed: ${probed.join(", ")})` : ""),
      };
    }
    return {
      status: "unchanged",
      reason: `${domain} is not a shared regional domain (auto-upgrade applies to ${Object.keys(SHARED_DOMAIN_REGIONS).join(", ")})`,
    };
  }
  if (!force && !shouldAutoUpgradeWorkspace(cfg, domain)) {
    return {
      status: "unchanged",
      reason: cfg.cloudAutoWorkspaceDomain === false ? "auto-upgrade is disabled" : "last probe failed <24h ago (backoff)",
    };
  }
  // Live discovery first; the cached id is only a fallback (e.g. limits
  // unreachable but the workspace domain itself would answer).
  const wsid = (await detectCloudWorkspaceId(domain, apiKey)) ?? sanitizeWorkspaceId(cfg.cloudWorkspaceId);
  if (!wsid) {
    cfg.cloudWorkspaceProbeFailedAt = Date.now();
    saveConfig(cfg);
    return { status: "failed", reason: "no workspace_id in the /api/v1/models/limits response" };
  }
  const target = workspaceDomain(wsid, region);
  if (!(await probeWorkspaceDomain(target, apiKey))) {
    cfg.cloudWorkspaceProbeFailedAt = Date.now();
    saveConfig(cfg);
    return { status: "failed", reason: `${target} did not answer the probe` };
  }
  cfg.cloudWorkspaceId = wsid;
  cfg.cloudDomain = target;
  delete cfg.cloudWorkspaceProbeFailedAt;
  saveConfig(cfg);
  return { status: "upgraded", domain: target, wsid };
}

// ── Cloud login seed ─────────────────────────────────────────────────
// pi hides any provider that has zero registered models, so with no
// credential at all the Cloud provider would vanish from /login → "Use an
// API key" (issue #1). To stay visible we register ONE placeholder model
// when — and only when — the live catalog is empty AND no key exists. In
// that state no model is usable anyway (there's no key), so this is purely a
// "click here to log in" entry, not a model-catalog fallback: as soon as a
// key is present (via /login or $DASHSCOPE_API_KEY) the live catalog is
// fetched and replaces it. We use a real, region-agnostic id (`qwen-plus`,
// present on every DashScope account) so it also works for an env-var user
// before the first refresh, and never lingers as an orphan after login.
const CLOUD_LOGIN_SEED: ProviderModelConfig[] = [{
  id: "qwen-plus",
  name: "Qwen Plus",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 8192,
}];

// ── Offline-resilient catalog loaders ────────────────────────────────
// ── Catalog loading + refresh (pi-owned storage) ───────────────────────
// pi persists whatever `refreshModels` returns in its models store and hands
// the snapshot back as `context.stored` during offline/cache-only
// initialization; its own freshness checks decide when a network refresh is
// due (`force` bypasses them). There is no cache file and no TTL policy here:
// we fetch and derive, pi stores and re-serves.

type RefreshCtx = {
  allowNetwork: boolean;
  force?: boolean;
  signal?: AbortSignal;
  stored?: { models?: readonly ProviderModelConfig[] };
};

// Best-effort fetch: a failure keeps whatever we already hold and warns.
async function loadPlanCatalog(force: boolean): Promise<PlanModelDef[]> {
  try {
    const defs = await fetchPlanModels(force, readAuth()["alibaba-plan"]);
    planDefs = defs;
    const cfg = loadConfig();
    cfg.planFetchedAt = Date.now();
    saveConfig(cfg);
    return defs;
  } catch (e: any) {
    console.warn(`[alibaba] Plan catalog fetch failed (${e?.message || e}); keeping ${planDefs.length} previously loaded models.`);
    return planDefs;
  }
}

async function loadCloudCatalog(domain: string, apiKey: string, force: boolean): Promise<ProviderModelConfig[]> {
  try {
    const { models, authorizedOnly } = await fetchCloudModels(domain, apiKey, force);
    cloudDefs = models.length ? models : CLOUD_LOGIN_SEED;
    const cfg = loadConfig();
    cfg.cloudFetchedAt = Date.now();
    cfg.cloudAuthorizedFilteredLast = authorizedOnly;
    saveConfig(cfg);
    return cloudDefs;
  } catch (e: any) {
    console.warn(`[alibaba] Cloud catalog fetch failed (${e?.message || e}); keeping ${cloudDefs.length} previously loaded models.`);
    return cloudDefs;
  }
}

// What pi calls. The offline phase re-serves the stored snapshot through the
// builders (capabilities are re-derived from ids — see deriveCard); the
// network phase fetches and lets pi persist the result. With no credential at
// all we return no models, so "Reset all" cannot leave ghosts in pi's store.
const planRefreshModels = async (context: RefreshCtx): Promise<ProviderModelConfig[]> => {
  const creds = readAuth()["alibaba-plan"];
  if (!creds?.access) return [];
  const ep = resolvePlanEndpoints(creds);
  const defs = context.allowNetwork
    ? await loadPlanCatalog(!!context.force)
    : (planDefs.length ? planDefs : ((context.stored?.models ?? []) as unknown as PlanModelDef[]));
  return buildPlanModels(defs, ep.openai, ep.anthropic, loadConfig().contextWindowOverrides);
};

const cloudRefreshModels = async (context: RefreshCtx): Promise<ProviderModelConfig[]> => {
  const cfg = loadConfig();
  const domain = cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN;
  const fmt = cfg.cloudApiFormat || "anthropic-messages";
  const key = readCloudKey();
  const defs = key
    ? (context.allowNetwork
      ? await loadCloudCatalog(domain, key, !!context.force)
      : (cloudDefs.length ? cloudDefs : ((context.stored?.models ?? []) as unknown as ProviderModelConfig[])))
    : [];
  return buildCloudModels(defs.length ? defs : CLOUD_LOGIN_SEED, domain, fmt, cfg.contextWindowOverrides);
};

// ── Module-level mutable model lists ─────────────────────────────────
// Filled by the loaders above (registration baseline + refreshModels), and
// read by modifyModels, /alibaba's Status/Rate-limits/Override menus.
let planDefs: PlanModelDef[] = [];
let cloudDefs: ProviderModelConfig[] = [];

// ── Migration ─────────────────────────────────────────────────────────
const isPlanKey = (k: string) => k.startsWith("sk-sp-") || k.startsWith("sk-tok-");

function extractKey(entry: AuthEntry | undefined): string | undefined {
  if (!entry) return undefined;
  return entry.key || entry.access || undefined;
}

function migrateLegacyAuth() {
  try {
    const auth = readAuth();
    let dirty = false;

    // 1) Legacy single-key "alibaba" → split by prefix.
    const old = auth["alibaba"];
    if (old) {
      const key = extractKey(old);
      for (const k of ["alibaba-studio", "alibaba-token", "dashscope"]) {
        if (k in auth) { delete auth[k]; dirty = true; }
      }
      if (!key) {
        delete auth["alibaba"]; dirty = true;
      } else {
        const target = isPlanKey(key) ? "alibaba-plan" : "alibaba-cloud";
        // Plan stays in oauth shape (it's still oauth-registered);
        // Cloud must be api_key shape (now api-key-only registered).
        auth[target] = target === "alibaba-plan"
          ? { type: "oauth", access: key, refresh: "", expires: Date.now() + 365 * 86400_000 }
          : { type: "api_key", key };
        delete auth["alibaba"];
        dirty = true;
      }
    }

    // 2) Cloud was previously registered with `oauth` block — credentials were
    //    saved as {type:"oauth", access:"sk-..."}. Now that cloud is api-key-only,
    //    pi can't read those credentials. Migrate them in place.
    const cloud = auth["alibaba-cloud"];
    if (cloud && cloud.type !== "api_key") {
      const key = extractKey(cloud);
      if (key) {
        // Defensive: if the cloud slot somehow contains a Plan token, route it.
        if (isPlanKey(key)) {
          auth["alibaba-plan"] = auth["alibaba-plan"] ?? {
            type: "oauth", access: key, refresh: "", expires: Date.now() + 365 * 86400_000,
          };
          delete auth["alibaba-cloud"];
        } else {
          auth["alibaba-cloud"] = { type: "api_key", key };
        }
        dirty = true;
      } else {
        delete auth["alibaba-cloud"];
        dirty = true;
      }
    }

    // 3) Defensive: a misrouted Plan token sitting in alibaba-cloud (api_key shape).
    //    Plan tokens won't authenticate against the cloud endpoint. Move it.
    const cloud2 = auth["alibaba-cloud"];
    if (cloud2?.type === "api_key" && typeof cloud2.key === "string" && isPlanKey(cloud2.key)) {
      if (!auth["alibaba-plan"]) {
        auth["alibaba-plan"] = {
          type: "oauth", access: cloud2.key, refresh: "", expires: Date.now() + 365 * 86400_000,
        };
      }
      delete auth["alibaba-cloud"];
      dirty = true;
    }

    if (dirty) writeAuth(auth);
  } catch {}
}

// ── Main ──────────────────────────────────────────────────────────────
// Async factory: pi awaits this before provider registrations are flushed.
// Fetch live model catalogs before registerProvider() so enabledModels
// validation sees the real catalog immediately. No fallbacks.
export default async function (pi: ExtensionAPI) {
  migrateLegacyAuth();
  const config = loadConfig();

  // DashScope reports some transient failures as SSE `server_error` events
  // over HTTP 200: rate limits with `<429>` in the message, and inference-
  // backend `Backend buffer overflow` errors. Prefix the assistant error so
  // modern pi's retry classifier matches it — a bare `Backend buffer
  // overflow.` carries no retryable marker and would fail the turn at once.
  pi.on("message_end", (event) => {
    const { message } = event;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    if (message.provider !== "alibaba-plan" && message.provider !== "alibaba-cloud") return;
    const errorMessage = message.errorMessage ?? "";
    const rewritten =
      rewriteDashScopeRateLimitErrorMessage(errorMessage) ??
      rewriteDashScopeBackendOverflowMessage(errorMessage);
    if (!rewritten) return;
    return { message: { ...message, errorMessage: rewritten } };
  });

  let planKey: string | null = null;
  try {
    const auth = readAuth();
    planKey = auth["alibaba-plan"]?.access || auth["alibaba-plan"]?.key || null;
  } catch {}
  const cloudKey = readCloudKey();

  // ── Live catalog fetch (before provider registration) ───────────────
  let planCreds: { access?: string; refresh?: string } | undefined;
  if (planKey) { try { planCreds = readAuth()["alibaba-plan"]; } catch {} }
  const planEndpoints = resolvePlanEndpoints(planCreds);
  let cloudDomain = config.cloudDomain || DEFAULT_CLOUD_DOMAIN;
  const cloudFmt: CloudApiFormat = config.cloudApiFormat || "anthropic-messages";

  // Catalogs before registerProvider(): pi awaits this factory, and
  // enabledModels validation plus `pi --list-models` want the real catalog
  // right away. One lightweight catalog GET per launch (never billed);
  // offline it keeps whatever we hold, and pi's stored snapshot arrives with
  // the first `refreshModels` phase.
  if (planCreds?.access) planDefs = await loadPlanCatalog(false);
  if (cloudKey) {
    // One-shot endpoint upgrade: shared regional domain → workspace domain.
    // Pure checks first, so a normal launch pays zero network; on success the
    // catalog below is fetched from the upgraded domain directly.
    const up = await upgradeCloudDomainToWorkspace(cloudKey);
    if (up.status === "upgraded") {
      console.warn(
        `[alibaba] Cloud endpoint auto-upgraded to the workspace domain ${up.domain} (WorkspaceId ${up.wsid}) — ` +
        "Alibaba recommends workspace domains for performance and stability. " +
        "Manage or undo: /alibaba → Cloud — Auto workspace domain / Change Domain.",
      );
      cloudDomain = up.domain;
    }
    await loadCloudCatalog(cloudDomain, cloudKey, false);
  }
  // Keep the Cloud provider visible in /login even with no models yet (issue #1).
  if (!cloudDefs.length) cloudDefs = CLOUD_LOGIN_SEED;

  // ── Plan provider ───────────────────────────────────────────────────
  pi.registerProvider("alibaba-plan", {
    name: "Alibaba Model Studio Plan",
    baseUrl: planEndpoints.anthropic,
    api: "anthropic-messages",
    authHeader: true,
    models: buildPlanModels(planDefs, planEndpoints.openai, planEndpoints.anthropic, loadConfig().contextWindowOverrides),
    refreshModels: planRefreshModels,
    oauth: {
      name: "Alibaba Model Studio Coding Plan",
      async login(callbacks) {
        const key = await callbacks.onPrompt({
          message: "Coding Plan token (sk-sp-… or sk-tok-…). Run /alibaba afterwards if you need a non-Singapore region:",
        });
        if (!isPlanKey(key)) {
          throw new Error(
            "This doesn't look like a Coding Plan token (expected sk-sp-… or sk-tok-…). " +
            "If it's a Cloud API key, run /login → 'Alibaba Cloud (API Key)' instead.",
          );
        }
        const cfg = loadConfig();
        const openaiUrl = cfg.planOpenAI || DEFAULT_PLAN_OPENAI;
        const anthropicUrl = cfg.planAnthropic || DEFAULT_PLAN_ANTHROPIC;
        cfg.planOpenAI = openaiUrl;
        cfg.planAnthropic = anthropicUrl;
        saveConfig(cfg);
        return {
          access: key,
          refresh: JSON.stringify({ openai: openaiUrl, anthropic: anthropicUrl }),
          expires: Date.now() + 365 * 86400_000,
        };
      },
      async refreshToken(c) { return c; },
      getApiKey(c) { return c.access; },
      modifyModels(models, credentials) {
        const ep = resolvePlanEndpoints(credentials);
        // Always reads the latest planDefs (startup fetch → session_start refresh)
        const updated = buildPlanModels(planDefs, ep.openai, ep.anthropic);
        return models.map((m) => {
          if (m.provider !== "alibaba-plan") return m;
          const found = updated.find((u) => u.id === m.id);
          if (!found || !found.api) return m;
          return { ...m, baseUrl: found.baseUrl ?? m.baseUrl, api: found.api };
        });
      },
    },
  });

  // ── Cloud provider ─────────────────────────────────────────────────
  const cloudTransport = cloudDefaultTransport(cloudDomain, cloudFmt);
  pi.registerProvider("alibaba-cloud", {
    name: "Alibaba Cloud (API Key)",
    baseUrl: cloudTransport.baseUrl,
    apiKey: "$DASHSCOPE_API_KEY",
    api: cloudTransport.api,
    authHeader: true,
    models: buildCloudModels(cloudDefs, cloudDomain, cloudFmt, loadConfig().contextWindowOverrides),
    refreshModels: cloudRefreshModels,
  });

  // ── Lazy refresh: fetch live catalogs and re-register ───────────────
  pi.on("session_start", async () => {
   try {
    planDefs = await loadPlanCatalog(false);

    const key = readCloudKey();
    if (key) {
      // Covers logging into Cloud mid-process: the boot factory had no key yet.
      const up = await upgradeCloudDomainToWorkspace(key);
      if (up.status === "upgraded") {
        console.warn(`[alibaba] Cloud endpoint auto-upgraded to the workspace domain ${up.domain} (WorkspaceId ${up.wsid}).`);
      }
      const cfg = loadConfig();
      const domain = cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN;
      await loadCloudCatalog(domain, key, false);
    }
    // Keep the Cloud provider visible in /login even with no models yet (issue #1).
    if (!cloudDefs.length) cloudDefs = CLOUD_LOGIN_SEED;

    // Re-register both providers with the expanded model lists
    const currentConfig = loadConfig();
    const currentPlanCreds = readAuth()["alibaba-plan"];
    const ep = resolvePlanEndpoints(currentPlanCreds);
    const currentDomain = currentConfig.cloudDomain || DEFAULT_CLOUD_DOMAIN;
    const currentFmt: CloudApiFormat = currentConfig.cloudApiFormat || "anthropic-messages";

    pi.registerProvider("alibaba-plan", {
      name: "Alibaba Model Studio Plan",
      baseUrl: ep.anthropic,
      api: "anthropic-messages",
      authHeader: true,
      models: buildPlanModels(planDefs, ep.openai, ep.anthropic, loadConfig().contextWindowOverrides),
      refreshModels: planRefreshModels,
      oauth: {
        name: "Alibaba Model Studio Coding Plan",
        async login(callbacks) {
          const key = await callbacks.onPrompt({
            message: "Coding Plan token (sk-sp-… or sk-tok-…). Run /alibaba afterwards if you need a non-Singapore region:",
          });
          if (!isPlanKey(key)) {
            throw new Error(
              "This doesn't look like a Coding Plan token (expected sk-sp-… or sk-tok-…). " +
              "If it's a Cloud API key, run /login → 'Alibaba Cloud (API Key)' instead.",
            );
          }
          const cfg = loadConfig();
          const openaiUrl = cfg.planOpenAI || DEFAULT_PLAN_OPENAI;
          const anthropicUrl = cfg.planAnthropic || DEFAULT_PLAN_ANTHROPIC;
          cfg.planOpenAI = openaiUrl;
          cfg.planAnthropic = anthropicUrl;
          saveConfig(cfg);
          return {
            access: key,
            refresh: JSON.stringify({ openai: openaiUrl, anthropic: anthropicUrl }),
            expires: Date.now() + 365 * 86400_000,
          };
        },
        async refreshToken(c) { return c; },
        getApiKey(c) { return c.access; },
        modifyModels(models, credentials) {
          const ep2 = resolvePlanEndpoints(credentials);
          const updated = buildPlanModels(planDefs, ep2.openai, ep2.anthropic);
          return models.map((m) => {
            if (m.provider !== "alibaba-plan") return m;
            const found = updated.find((u) => u.id === m.id);
            if (!found || !found.api) return m;
            return { ...m, baseUrl: found.baseUrl ?? m.baseUrl, api: found.api };
          });
        },
      },
    });

    const cloudTransport = cloudDefaultTransport(currentDomain, currentFmt);
    pi.registerProvider("alibaba-cloud", {
      name: "Alibaba Cloud (API Key)",
      baseUrl: cloudTransport.baseUrl,
      apiKey: "$DASHSCOPE_API_KEY",
      api: cloudTransport.api,
      authHeader: true,
      models: buildCloudModels(cloudDefs, currentDomain, currentFmt, loadConfig().contextWindowOverrides),
      refreshModels: cloudRefreshModels,
    });
   } catch (e: any) {
    console.warn(`[alibaba] session_start catalog refresh failed (${e?.message || e}); keeping previously loaded models.`);
   }
  });

  // ── Command: /alibaba ──────────────────────────────────────────────
  pi.registerCommand("alibaba", {
    description: "Manage Alibaba (Plan + Cloud) configuration",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const choice = await ctx.ui.select("Alibaba:", [
        "Status",
        "Refresh model lists",
        "Re-login Plan",
        "Re-login Cloud",
        "Plan — Change Endpoints",
        "Cloud — Change Domain",
        "Cloud — Auto workspace domain",
        "Cloud — Change API Format",
        "Cloud — DashScope built-in tools",
        "Rate limits (Cloud)",
        "Cloud — Authorized-only Filter",
        "Context Window — Override",
        "Reset all",
      ]);
      if (!choice) return;

      const cfg = loadConfig();
      const auth = readAuth();
      const planCred = auth["alibaba-plan"];
      const cloudCred = auth["alibaba-cloud"];

      if (choice === "Status") {
        const ep = resolvePlanEndpoints(planCred);
        const age = (t?: number) => (t ? `${Math.round((Date.now() - t) / 60000)}m old` : "not fetched yet");
        const planState = planDefs.length ? `fetched ${age(cfg.planFetchedAt)}` : "not fetched";
        const cloudState = cloudDefs.length ? `fetched ${age(cfg.cloudFetchedAt)}` : "not fetched";
        const lines = [
          `Plan:  ${planCred ? "logged in" : "not logged in"}`,
          `       Anthropic: ${ep.anthropic}`,
          `       OpenAI:    ${ep.openai}`,
          `       Models:    ${planDefs.length} (${planState})`,
          ``,
          `Cloud: ${cloudCred ? "logged in" : (process.env.DASHSCOPE_API_KEY ? "via $DASHSCOPE_API_KEY" : "not logged in")}`,
          `       Domain:    ${cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN}`,
          `       Auto-WS:   ${cfg.cloudAutoWorkspaceDomain === false ? "off" : "on"}${cfg.cloudWorkspaceId ? ` (WorkspaceId ${cfg.cloudWorkspaceId})` : ""}`,
          `       Format:    ${cfg.cloudApiFormat || "anthropic-messages"}`,
          `       Sidecar:   ${cfg.cloudSidecarTools ? `on (${cfg.cloudSidecarModel || "auto Qwen"})` : "off"}`,
          `       Auth-only: ${cfg.cloudAuthorizedOnly === false ? "off" : "on (when endpoint available)"}${cfg.cloudAuthorizedFilteredLast ? " — active (filtered list)" : ""}`,
          `       Models:    ${cloudDefs.length} (${cloudState})`,
        ];
        const overrides = cfg.contextWindowOverrides;
        if (overrides && Object.keys(overrides).length) {
          lines.push("", "Context window overrides:");
          for (const [id, n] of Object.entries(overrides)) {
            lines.push(`       ${id}: ${n.toLocaleString()} tokens`);
          }
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (choice === "Refresh model lists") {
        try {
          // pi's own refresh path: our `refreshModels` handlers fetch and pi
          // persists the result (`force` bypasses its freshness checks).
          const res = await ctx.modelRegistry.refresh({ force: true });
          const failed = [...res.errors.values()].map((err: any) => err?.message || String(err));
          ctx.ui.notify(
            `Plan: ${planDefs.length} models. Cloud: ${cloudDefs.length} models.` +
              (failed.length ? `\nFailed: ${failed.join("; ")}` : ""),
            failed.length ? "warning" : "info",
          );
        } catch (e: any) {
          ctx.ui.notify(`Failed: ${e?.message || e}`, "error");
        }
        return;
      }

      if (choice === "Re-login Plan") {
        if (!await ctx.ui.confirm("Wipe Plan credentials and re-login?", "Removes alibaba-plan from auth.json")) return;
        // Use authStorage.remove() rather than fs.write — it persists AND updates pi's
        // in-memory credential map, so /login's `• configured` label refreshes without restart.
        authStore(ctx).remove("alibaba-plan");
        ctx.ui.notify("Plan credentials wiped. Run /login → Alibaba Model Studio Coding Plan.", "info");
        await ctx.reload();
        return;
      }

      if (choice === "Re-login Cloud") {
        if (!await ctx.ui.confirm("Wipe Cloud credentials and re-login?", "Removes alibaba-cloud from auth.json")) return;
        authStore(ctx).remove("alibaba-cloud");
        ctx.ui.notify("Cloud credentials wiped. Run /login → Use an API key → Alibaba Cloud (API Key).", "info");
        await ctx.reload();
        return;
      }

      if (choice === "Plan — Change Endpoints") {
        const o = (await ctx.ui.input("OpenAI-compat base URL:")) || "";
        const a = (await ctx.ui.input("Anthropic-compat base URL:")) || "";
        if (o && a) {
          cfg.planOpenAI = o; cfg.planAnthropic = a; saveConfig(cfg);
          // Also rewrite the active credential's refresh-blob so resolvePlanEndpoints
          // (which prefers credentials.refresh over config) picks up the new endpoints
          // for the existing logged-in session — otherwise the change only takes effect
          // after the user logs out + back in.
          const store = authStore(ctx);
          const currentPlan = store.get("alibaba-plan");
          if (currentPlan?.type === "oauth") {
            store.set("alibaba-plan", {
              ...currentPlan,
              refresh: JSON.stringify({ openai: o, anthropic: a }),
            });
          }
          ctx.ui.notify("Plan endpoints updated.", "info");
          await ctx.reload();
        }
        return;
      }

      if (choice === "Cloud — Change Domain") {
        const sel = await ctx.ui.select("Cloud endpoint:", [
          `International (${DEFAULT_CLOUD_DOMAIN})`,
          `China (${DEFAULT_CLOUD_CN_DOMAIN})`,
          `US — Virginia (${DEFAULT_CLOUD_US_DOMAIN})`,
          `Hong Kong (${DEFAULT_CLOUD_HK_DOMAIN})`,
          "China — Beijing workspace domain…",
          "Singapore workspace domain…",
          "Japan — Tokyo workspace domain…",
          "Germany — Frankfurt workspace domain…",
          "US — workspace domain…",
          "Custom…",
        ]);
        if (!sel) return;
        let domain = sel.match(/\(([^)]+)\)/)?.[1] || "";
        if (sel.endsWith("workspace domain…")) {
          const region = sel.startsWith("China")
            ? WSID_BEIJING
            : sel.startsWith("Singapore")
              ? WSID_SINGAPORE
              : sel.startsWith("Japan")
                ? WSID_TOKYO
                : sel.startsWith("US")
                  ? WSID_US
                  : WSID_FRANKFURT;
          const cached = sanitizeWorkspaceId(cfg.cloudWorkspaceId);
          const input = await ctx.ui.input(
            "Model Studio business-space ID (console → 业务空间详情):",
            cached || "llm-…",
          );
          if (input === undefined) return; // dismissed
          // Blank input falls back to the WorkspaceId discovered by the
          // auto-upgrade (/alibaba → Cloud — Auto workspace domain).
          const wsid = sanitizeWorkspaceId(input) ?? cached;
          if (wsid) domain = workspaceDomain(wsid, region);
        }
        if (sel.startsWith("Custom")) domain = (await ctx.ui.input("Cloud domain:")) || "";
        if (domain) {
          // Explicitly landing on a shared regional domain means “stay here” —
          // opt out of the boot auto-upgrade so it never fights this choice.
          if (regionForSharedCloudDomain(domain)) cfg.cloudAutoWorkspaceDomain = false;
          cfg.cloudDomain = domain; saveConfig(cfg);
          ctx.ui.notify(`Cloud domain: ${domain}`, "info");
          await ctx.reload();
        }
        return;
      }

      if (choice === "Cloud — Auto workspace domain") {
        const DETECT = "Detect & upgrade now";
        const ENABLE = "Enable auto-upgrade on boot";
        const DISABLE = "Disable auto-upgrade on boot";
        const enabled = cfg.cloudAutoWorkspaceDomain !== false;
        const cached = sanitizeWorkspaceId(cfg.cloudWorkspaceId);
        const current = cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN;
        const onWorkspace = parseWorkspaceCloudDomain(current);
        const sel = await ctx.ui.select(
          `Auto workspace domain — ${enabled ? "enabled" : "disabled"}` +
            (cached ? `, WorkspaceId ${cached}` : "") +
            ` (current: ${current}${onWorkspace ? " — already a workspace domain" : ""}):`,
          [DETECT, enabled ? DISABLE : ENABLE],
        );
        if (!sel) return;
        if (sel === DETECT) {
          const key = readCloudKey();
          if (!key) {
            ctx.ui.notify("Cloud not logged in — no key in auth.json and no $DASHSCOPE_API_KEY. Run /login first.", "error");
            return;
          }
          const up = await upgradeCloudDomainToWorkspace(key, true);
          if (up.status === "upgraded") {
            ctx.ui.notify(`Cloud domain upgraded to ${up.domain} (WorkspaceId ${up.wsid}). Reloading…`, "info");
            await ctx.reload();
          } else if (up.status === "demoted") {
            ctx.ui.notify(
              `${up.reason}. Fell back to the shared ${up.domain}; auto-upgrade disabled — re-enable it from this menu once your key's workspace is discoverable. Reloading…`,
              "warning",
            );
            await ctx.reload();
          } else if (up.status === "already") {
            ctx.ui.notify(`Cloud is ${up.reason} — nothing to upgrade.`, "info");
          } else {
            ctx.ui.notify(`Not upgraded (${up.status}): ${up.reason}.`, "warning");
          }
          return;
        }
        cfg.cloudAutoWorkspaceDomain = sel === ENABLE;
        saveConfig(cfg);
        ctx.ui.notify(
          cfg.cloudAutoWorkspaceDomain
            ? "Auto workspace-domain upgrade enabled — applied on the next boot while on a shared regional domain."
            : "Auto workspace-domain upgrade disabled.",
          "info",
        );
        return;
      }

      if (choice === "Cloud — Change API Format") {
        const sel = await ctx.ui.select("Cloud API format:", [
          "Anthropic Messages (recommended)",
          "OpenAI Chat Completions",
          "OpenAI Responses",
        ]);
        if (!sel) return;
        cfg.cloudApiFormat = sel.startsWith("Anthropic")
          ? "anthropic-messages"
          : sel.startsWith("OpenAI Responses")
            ? "openai-responses"
            : "openai-completions";
        saveConfig(cfg);
        ctx.ui.notify(`Cloud format: ${cfg.cloudApiFormat}`, "info");
        await ctx.reload();
        return;
      }

      if (choice === "Cloud — DashScope built-in tools") {
        const sel = await ctx.ui.select("alibaba_tools sidecar (Cloud Qwen only, billed separately):", [
          cfg.cloudSidecarTools ? "On (keep enabled)" : "Enable",
          "Disable",
          "Enable and set sidecar model…",
        ]);
        if (!sel) return;
        if (sel === "Disable") {
          cfg.cloudSidecarTools = false;
          saveConfig(cfg);
          ctx.ui.notify("alibaba_tools disabled. Reloading…", "info");
          await ctx.reload();
          return;
        }
        cfg.cloudSidecarTools = true;
        if (sel.startsWith("Enable and set")) {
          const id = (await ctx.ui.input(
            `Sidecar Qwen model id (blank = auto; currently ${cfg.cloudSidecarModel || "auto"}):`,
          ))?.trim();
          if (id) cfg.cloudSidecarModel = id;
          else delete cfg.cloudSidecarModel;
        }
        saveConfig(cfg);
        if (!readCloudKey()) {
          ctx.ui.notify("alibaba_tools enabled, but no Cloud key yet. /login → Alibaba Cloud or set $DASHSCOPE_API_KEY, then retry.", "warning");
        } else {
          ctx.ui.notify(`alibaba_tools enabled (${cfg.cloudSidecarModel || "auto Qwen"}). Reloading…`, "info");
        }
        await ctx.reload();
        return;
      }

      if (choice === "Rate limits (Cloud)") {
        const key = readCloudKey();
        if (!key) {
          ctx.ui.notify("Cloud not logged in — no key in auth.json and no $DASHSCOPE_API_KEY. Run /login first.", "error");
          return;
        }
        const domain = cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN;
        const quotas = await fetchCloudQuotas(domain, key);
        if (!quotas) {
          ctx.ui.notify(
            `Could not fetch rate limits from https://${domain}/api/v1/models/limits. ` +
            "This endpoint is only documented on the Beijing workspace domain so far — set one via " +
            "/alibaba → Cloud — Change Domain (e.g. {WorkspaceId}.cn-beijing.maas.aliyuncs.com) and retry.",
            "error",
          );
          return;
        }
        const chatIds = cloudDefs.length > 1 ? new Set(cloudDefs.map((m) => m.id)) : null;
        const entries = [...quotas.values()].filter((q) => !chatIds || chatIds.has(q.model)).sort((a, b) => a.model.localeCompare(b.model));
        const MAX_SHOWN = 60;
        const lines = [`Rate limits — ${domain} (showing ${Math.min(entries.length, MAX_SHOWN)} of ${quotas.size}):`];
        for (const q of entries.slice(0, MAX_SHOWN)) lines.push(`  ${q.model}: ${formatQuota(q)}`);
        if (entries.length > MAX_SHOWN) lines.push(`  … and ${entries.length - MAX_SHOWN} more`);
        if (!entries.length) lines.push("  (no quotas for the current model list)");
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (choice === "Cloud — Authorized-only Filter") {
        const next = cfg.cloudAuthorizedOnly === false;
        cfg.cloudAuthorizedOnly = next;
        saveConfig(cfg);
        ctx.ui.notify(`Cloud authorized-only filter: ${next ? "ON" : "OFF"} — reloading…`, "info");
        await ctx.reload();
        return;
      }

      if (choice === "Context Window — Override") {
        // Override the context-window shown on a model's card (e.g. when the
        // inferred size is wrong for a brand-new model). Pick a model id, or
        // "*" to set a default for every model without its own override.
        const ov = cfg.contextWindowOverrides || {};
        const fmt = (n: number) => n.toLocaleString();
        const ids = Array.from(new Set([...planDefs.map((m) => m.id), ...cloudDefs.map((m) => m.id)])).sort();
        const labelToId = new Map<string, string>();
        const opts: string[] = [];
        for (const id of ids) {
          const label = ov[id] ? `${id}  (override: ${fmt(ov[id])})` : id;
          labelToId.set(label, id);
          opts.push(label);
        }
        const allLabel = ov["*"] ? `* every other model  (override: ${fmt(ov["*"])})` : "* every other model";
        labelToId.set(allLabel, "*");
        opts.push(allLabel);
        const CLEAR = "Clear all overrides";
        opts.push(CLEAR);

        const sel = await ctx.ui.select("Override context window for:", opts);
        if (!sel) return;
        if (sel === CLEAR) {
          delete cfg.contextWindowOverrides;
          saveConfig(cfg);
          ctx.ui.notify("Cleared all context-window overrides.", "info");
          await ctx.reload();
          return;
        }
        const id = labelToId.get(sel) ?? sel;
        const current = ov[id];
        const val = (await ctx.ui.input(
          `Context window for ${id} in tokens — e.g. 1048576 (0 to remove)${current ? `; currently ${fmt(current)}` : ""}:`,
        ))?.trim();
        if (!val) return; // cancelled / left blank → no change
        const n = Number(val.replace(/[_,\s]/g, ""));
        if (!Number.isFinite(n) || n < 0) {
          ctx.ui.notify("Enter a non-negative number of tokens (0 removes the override).", "error");
          return;
        }
        cfg.contextWindowOverrides = cfg.contextWindowOverrides || {};
        if (n === 0) {
          delete cfg.contextWindowOverrides[id];
          ctx.ui.notify(`Removed context-window override for ${id}.`, "info");
        } else {
          cfg.contextWindowOverrides[id] = Math.floor(n);
          ctx.ui.notify(`Context window for ${id} set to ${fmt(Math.floor(n))} tokens.`, "info");
        }
        if (Object.keys(cfg.contextWindowOverrides).length === 0) delete cfg.contextWindowOverrides;
        saveConfig(cfg);
        await ctx.reload();
        return;
      }

      if (choice === "Reset all") {
        if (!await ctx.ui.confirm(
          "Reset all Alibaba settings?",
          "Wipes config, both auth entries, legacy catalog caches, and any alibaba-* entries in settings.json (enabledModels + defaultProvider/defaultModel if alibaba). Run before `pi remove` for a clean uninstall.",
        )) return;
        try { fs.unlinkSync(CONFIG_PATH); } catch {}
        removeLegacyCaches();
        // Use authStorage.remove() so pi's in-memory credential cache stays in sync —
        // otherwise /login's "• configured" label persists until pi is restarted.
        const store = authStore(ctx);
        for (const k of ["alibaba", "alibaba-plan", "alibaba-cloud", "alibaba-studio", "alibaba-token", "dashscope"]) {
          store.remove(k);
        }
        // Also strip stale alibaba-* / dashscope-* model ids from settings.json enabledModels,
        // and clear defaultProvider/defaultModel if they reference alibaba (otherwise pi would
        // try to default-launch into a now-missing provider).
        try {
          const SETTINGS_PATH = path.join(HOME_DIR, "settings.json");
          const s = readJSON<Record<string, any>>(SETTINGS_PATH, {});
          let touched = false;
          if (Array.isArray(s.enabledModels)) {
            const before = s.enabledModels.length;
            s.enabledModels = s.enabledModels.filter((id: string) =>
              typeof id === "string" && !/^(alibaba(-plan|-cloud|-studio|-token)?|dashscope)\//.test(id),
            );
            if (s.enabledModels.length !== before) touched = true;
          }
          if (typeof s.defaultProvider === "string" && /^(alibaba(-plan|-cloud|-studio|-token)?|dashscope)$/.test(s.defaultProvider)) {
            delete s.defaultProvider;
            delete s.defaultModel;
            touched = true;
          }
          if (touched) writeJSON(SETTINGS_PATH, s);
        } catch {}
        ctx.ui.notify("All Alibaba settings wiped. Now safe to `pi remove`.", "info");
        await ctx.reload();
        return;
      }
    },
  });

  if (config.cloudSidecarTools) {
    pi.registerTool({
      name: "alibaba_tools",
      label: "Alibaba tools",
      description:
        "Separate billed Qwen sidecar for current web information, page extraction, " +
        "sandbox computation, or image search. Not for local files or shell commands.",
      promptSnippet:
        "alibaba_tools: billed Qwen sidecar; search=current facts, research=pages/multi-source, " +
        "code=sandbox, image=pictures.",
      promptGuidelines: [
        "Use only when current external information or a DashScope sandbox is needed; skip local/repository work and equivalent results already available from another tool.",
        "Use search for quick lookups. Use research directly for page extraction or multi-source synthesis, or when search is insufficient; research is slower and costlier.",
      ],
      parameters: ALIBABA_TOOLS_PARAMETERS,
      executionMode: "parallel",
      async execute(_toolCallId, rawParams: { action?: string; task?: string; strategy?: SidecarStrategy }, signal?: AbortSignal, onUpdate?: (partial: { content: { type: "text"; text: string }[]; details?: unknown }) => void) {
        const params = rawParams as { action?: string; task?: string; strategy?: SidecarStrategy };
        const action = String(params.action || "search") as SidecarAction;
        const task = typeof params.task === "string" ? params.task.trim() : "";
        const strategy = params.strategy;
        if (!task) throw new Error("alibaba_tools requires a non-empty task.");
        if (!["research", "search", "code", "image"].includes(action)) {
          throw new Error(`Unknown action "${action}". Use search, research, code, or image.`);
        }
        const key = readCloudKey();
        if (!key) {
          throw new Error("No Cloud API key. Run /login → Alibaba Cloud (API Key) or set $DASHSCOPE_API_KEY.");
        }
        const live = loadConfig();
        const domain = live.cloudDomain || DEFAULT_CLOUD_DOMAIN;
        const picked = pickSidecarModel({
          preferred: live.cloudSidecarModel,
          catalogIds: cloudDefs.map((m) => m.id),
          action,
        });
        if ("error" in picked) throw new Error(picked.error);
        const req = buildSidecarRequest({
          model: picked.id,
          transport: picked.transport,
          action,
          task,
          strategy,
        });
        onUpdate?.({
          content: [{ type: "text", text: formatSidecarProgress(action, 0, { text: "", sources: [], calls: [] }) }],
          details: { action, model: picked.id, transport: picked.transport, partial: true },
        });
        const res = await runSidecarWithRetry(domain, key, req, signal, (parsed, elapsedMs) => {
          onUpdate?.({
            content: [{ type: "text", text: formatSidecarProgress(action, elapsedMs, parsed) }],
            details: { action, model: picked.id, transport: picked.transport, partial: true, calls: parsed.calls },
          });
        }, {
          onRetry: ({ attempt, maxAttempts, delayMs, reason }) => {
            onUpdate?.({
              content: [{ type: "text", text: formatSidecarRetry(action, attempt, maxAttempts, delayMs, reason) }],
              details: { action, model: picked.id, transport: picked.transport, partial: true, retry: attempt, maxAttempts },
            });
          },
        });
        if (!res.ok) throw new Error(dashScopeErrorMessage(res.status, res.json));
        return {
          content: [{ type: "text", text: formatSidecarResult(res.parsed) }],
          details: {
            action,
            model: picked.id,
            transport: picked.transport,
            calls: res.parsed.calls,
            sourceCount: res.parsed.sources.length,
            retries: res.retries,
          },
        };
      },
    } as Parameters<ExtensionAPI["registerTool"]>[0]);
  }
}
