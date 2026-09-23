# Changelog

## 1.4.6

Caching and cache warming move onto pi 0.86+ built-ins.

- **Model catalogs use pi's models store instead of private cache files.** Both providers expose `refreshModels(context)`: the stored snapshot is served during pi's cache-only startup phase (verified on pi 0.87.1 — pi calls it with `allowNetwork=false`), and a fresh catalog is **published** to `models-store.json` exactly once per real fetch (measured: the legacy `ProviderConfig` form does not persist returns on its own, so the extension calls `context.publish({persist})` itself — restores never write the store). The 4h-TTL JSON caches, `isCacheFresh` and the `rehydrate*` loaders are gone; a failed fetch keeps the previous list, and with no credential nothing is served at all, so "Reset all" leaves no ghosts behind. Card capabilities are now derived in one place (`deriveCard`) and therefore re-derived even for a store snapshot — extension updates and context-window overrides apply without waiting for a network fetch. `/alibaba → Refresh model lists` goes through `ctx.modelRegistry.refresh({force: true})`; legacy cache files are deleted on sight.
- **Prompt-cache warming (pi `cacheWarming`).** Caching-capable families declare `promptCache: {short: 300}` — the conservative end of DashScope's documented 5-minute ephemeral window (renewed on hit; no `long` tier is published) — which makes them eligible for pi's idle/streaming prompt-cache warming. The open-weight `qwen3-<size>b` line has no documented caching and is never warmed.
- **DashScope session cache on Cloud Responses.** Requests carry `x-dashscope-session-cache: enable`, giving predictable multi-turn prefix hits server-side (reads ~10% vs the implicit cache's 20–25%, writes 125%, 5-min window renewed on hit; the client still sends the full history). Documented for the Responses endpoint only — models re-routed to Completions stay unmarked.
- **Many pi instances, one agent dir.** Catalog fetches coordinate on an `alibaba-catalog.lock` lockfile (atomic `wx` creation, 60s stale-lock steal): one fetcher at a time, the others skip and get pi's stored snapshot — so parallel instances neither hammer the endpoint nor race on writing `models-store.json`. A shared 10-minute freshness timestamp in `alibaba-config.json` collapses the herd to about one fetch (and one store write) per window; `/alibaba → Refresh model lists` forces as before. The login seed no longer shadows a stored snapshot in the cache-only phase. Measured on a warm start: 153 models restored from the store with zero store writes.

## 1.4.5

- **`max_tokens` resolves in one place, and a guess can no longer pose as a catalog row.** Plan and Cloud share `resolveMaxTokens()`: the catalog's own `max_output_tokens` is authoritative (clamped at 131072) wherever a real row exists, `0` means "no catalog row" and takes the conservative fallback (32768; 8192 for non-reasoning ids and the open-weight `qwen3-<size>b` line, measured at 8192). Until now the producers wrote id-based OpenAI guesses into the very field the Anthropic path then trusted (`glm-5.1` → 128000, `kimi-k3` → 1048576 → 131072 clamp), so `Range of max_tokens should be [1, N]` could recur — and the twin Plan/Cloud builders had already drifted (Plan silently dropped the caller's ceiling). Cloud caches move to `alibaba-cloud-models.cache.v2.json`, so pre-upgrade rows cannot keep masquerading as catalog data until the 4h TTL.
- **Per-family thinking maps follow each family's *distinct* efforts.** DeepSeek splits: `deepseek-v4-pro/flash` keeps `high`/`max` only, `deepseek-v4.1-*` gains `low` and an `off` (`none`) — the 1.4.4 map ignored the split. `glm-5.1`/`glm-5` stop advertising `max` (they reject it) instead of falling through to the universal map. Where the docs publish a coercion (deepseek-v4 low/medium → high, xhigh → max; glm-5.3 medium → high, xhigh → max), the coerced level is hidden and pi's own `clampThinkingLevel` lands on exactly that documented value.
- **Responses effort maps are derived from each family's Completions map** (the docs state Responses accepts the same subset per family), with `off` as the literal effort `none`. Four hand-kept Responses maps are gone and the disagreement the review flagged disappears: `qwen3.7-max` no longer sends `max` on Responses where Completions says it is rejected. Two measured-narrower families keep explicit overrides — qwen3.5–3.7 cap at `medium`, `qwen-plus`/`flash` accept only `none`.
- **Reasoning detection ignores the catalog `Reasoning` tag** (it flagged `qwen-turbo` and missed `qwen3-30b-a3b`; OR-ing it back in reintroduced both bugs), and the `-character` exclusion now covers every family's roleplay variants. `qwen3-coder`/`qwen3-next` count as reasoning: the old id heuristic missed them even though the maps already knew them.
- **Corrections to the 1.4.4 notes.** (a) The failure example was wrong: `qwen-plus`, `qwen-turbo` and `qwen3-30b-a3b` took the 8192 branch in 1.4.3 and sat at or below their own ceilings — the real failure mode is a reasoning-flagged id whose ceiling is below the 32768 guess (`glm-5` = 16384 rejects it with `Range of max_tokens should be [1, 16384]`; the open-weight `qwen3-30b-a3b` = 8192 would have too, once the broader detection flagged it). (b) `thinking: {type: "disabled"}` is serialized pi-side: what the map controls is `off` being **non-null** — `thinkingLevelMap.off !== null` gates the Anthropic serialization, and on Completions pi sends `enable_thinking: false` without ever using the map's `off` value.
- **Simplification, with more of pi's built-ins doing the work.** Four regex ladders over the model id (Completions maps, Responses maps, Responses capability, reasoning) collapse into one capability table (`capsFor`) with one row per family; eleven hand-written 7-key level maps collapse into a `levels()` constructor plus one map per distinct shape (the four byte-identical copies are gone); both builders share `resolveMaxTokens()`/`mergeCompat()`. Level hiding and clamping are delegated to pi (`getSupportedThinkingLevels`/`clampThinkingLevel`) instead of duplicated coercion entries. Known gap, now documented: MiniMax switches thinking through `thinking.type: "adaptive" | "disabled"`, which pi's OpenAI paths never emit, so `--thinking off` stays hidden (`off: null`) on those ids. devDependency pinned to pi `^0.87.0` (the release is built and tested against it).

## 1.4.4

- **Correct per-model `max_tokens` on the Anthropic path.** The extension used to send a flat id-based guess (32768 for reasoning models, 8192 otherwise). DashScope enforces a *per-model* ceiling and rejects anything larger with `Range of max_tokens should be [1, N]`, so prompts failed outright on models below the guess — `qwen-plus`, `qwen-turbo` (16384), `qwen3-30b-a3b` (8192). The catalog's own `max_output_tokens` is now authoritative, clamped at 131072; models with no catalog row keep the conservative fallback.
- **Thinking can be switched off on the Anthropic path again.** `thinkingLevelMap.off` was `null`, and pi *clamps an unsupported level upward* — so `--thinking off` silently became `low` and always paid for thinking. `off` now maps to a real value that serializes as `thinking: {type: "disabled"}`.
- **Per-family thinking levels on both OpenAI paths.** Each family accepts a different `reasoning_effort` subset and some require `enable_thinking` alongside it; the previous maps offered levels the endpoint rejects (e.g. `max` on Qwen 3.5–3.7, `none`/`minimal` on GLM-5.3, `max` on MiniMax-M2.5) and hid ones it accepts. The maps are now per-family and were verified against the live endpoint. GLM-4.5 no longer advertises `supportsReasoningEffort` (it rejects the field outright).
- **Stop advertising Responses for models that cannot serve it.** With the Cloud format set to OpenAI Responses, models such as `kimi-k2.6`, `glm-5.1`, `MiniMax-M2.5` and `qwen-max` answered `Agent capabilities are not enabled` on every request. They now stay on Chat Completions automatically; the Responses-capable set is measured per family.
- **Reasoning detection matches the real catalogs.** `qwen-plus`/`qwen-flash` and the open-weight `qwen3-<size>b` line are reasoning; `qwen-turbo` and the `-character` variants are not.

## 1.4.3

- **DashScope `Backend buffer overflow` handling:** this transient inference-backend failure arrives like the wrapped 429 — an SSE `server_error` event, usually over HTTP 200. Chat path: `message_end` prefixes a bare `Backend buffer overflow.` error with `server_error` so pi's retry classifier matches it (paths that keep the `server_error:` code were already retried). `alibaba_tools` retries it inside the tool on the same budget as 429s; the retry notice shows `server_error, retrying n/3…`.

## 1.4.2

- **DashScope 429-as-`server_error`:** rate limits that arrive as an SSE error event (`server_error: <429> InternalError.Algo: ... [Too many requests.]`) are treated as HTTP 429. On the main chat path, `message_end` prefixes the assistant `errorMessage` with `429` so modern pi auto-retries with backoff (the model never sees the failed turn). `alibaba_tools` copies that retry loop internally: the tool card shows `429, retrying n/3…`, and a recovered call returns only the sidecar result to the model.

## 1.4.1

- **Honor relocated pi config directories:** paths are now resolved through pi's `getAgentDir()` instead of hardcoding `~/.pi/agent`. Under a `PI_CODING_AGENT_DIR` override (e.g. Nix/Guix setups) the extension previously missed `/login` credentials entirely, wrote config/caches to the wrong place, and `/alibaba → Reset all` scrubbed a phantom `settings.json` while leaving the real one pointing at a removed provider.
- Regression tests boot the extension in a child process under a `PI_CODING_AGENT_DIR` override (credential read + Reset-all scrub).

## 1.4.0

- **Workspace-domain auto-upgrade (Cloud):** on boot and `session_start`, when the Cloud endpoint is a shared regional domain (`dashscope.aliyuncs.com`, `dashscope-intl.aliyuncs.com`, `dashscope-us.aliyuncs.com`), the extension discovers the key's WorkspaceId from `GET /api/v1/models/limits` (returned even on shared domains, although the docs call the ID console-only), probes `{WorkspaceId}.{region}.maas.aliyuncs.com`, and switches the Cloud domain **only if the probe succeeds**. Failed probes change nothing and back off for 24h; Hong Kong, custom, and workspace domains are never touched. Explicitly picking a shared domain in `Cloud — Change Domain` opts out; the new `/alibaba → Cloud — Auto workspace domain` menu detects on demand and toggles the behavior; the discovered ID pre-fills the manual workspace-domain prompt; `Status` shows the new `Auto-WS` state. `Detect & upgrade now` also recovers a swapped key: it verifies the current key against the configured workspace domain and, when rejected (key from another site), rediscovers the workspace across all shared domains and switches — or, as a last resort, demotes to a shared domain that positively accepts the key (auto-upgrade then opts out so it cannot flip back). Boot never demotes: fallback requires an explicit menu action.

## 1.3.1

- Sidecar SSE parser splits frames on LF or CRLF blank lines, so CRLF streams no longer glue events and drop JSON.
- An already-aborted input `AbortSignal` cancels `postSidecar` immediately instead of waiting out the timeout.
- README Cloud auth matches the API-key provider (`$DASHSCOPE_API_KEY` / `{ type: "api_key", key }`), not the old OAuth-shaped registration.

## 1.3.0

- **Leaner `alibaba_tools` prompt:** removes repeated guidance while making the cost and latency trade-offs explicit. Quick current-web lookups use `search`; page extraction and multi-source synthesis can go directly to the slower, costlier `research` action.
- **Clearer tool boundaries:** the model is told to skip the sidecar for local/repository work and when equivalent results are already available from another tool.
- **Simpler calls:** `action` is now optional and defaults to `search`; the legacy Completions-only `strategy` is explicitly marked as normally unnecessary.

## 1.2.1

- **`alibaba_tools` is search-first.** Guidelines and schema tell the model to use `search` for live facts; `research` only if that was too thin.
- **Streaming sidecar:** DashScope Responses/Completions are requested with `stream: true`. Progress (elapsed time, search/extract calls, partial text) is pushed through pi's `onUpdate` so the TUI is not a silent hang. Failures **throw** so the transcript marks `isError`.
- **Timeouts:** `research` 8 min, others 3 min (was 3 min / 90 s). Override with `ALIBABA_SIDECAR_TIMEOUT_MS`. Timeout text suggests `search` instead of `research`.
- Auto sidecar model prefers Flash/Plus over Max when the catalog has both. Independent `code`/`image` calls may run in parallel.

## 1.2.0

- **`alibaba_tools` sidecar** (opt-in): `/alibaba → Cloud — DashScope built-in tools` registers one Pi tool that POSTs its own Cloud Completions/Responses request. Actions: `research` (web_search + web_extractor + code_interpreter), `search`, `code`, `image`. Qwen-only allowlist; DeepSeek/Kimi/GLM/MiniMax are rejected. Built-in tool events stay inside the plugin — they are not mixed into pi's agent stream or the current chat format (Anthropic default included).
- Tests for allowlists, model picking, request bodies, and Responses/Completions result parsing.

## 1.1.0

- **OpenAI Responses API** for Cloud: `/alibaba → Cloud — Change API Format → OpenAI Responses` sets `api: "openai-responses"` on `https://{domain}/compatible-mode/v1` (pi talks to `/responses`). Thinking maps onto Bailian's `reasoning.effort` (`off→none`, plus minimal/low/medium/high/xhigh/max). DeepSeek still falls back to Chat Completions when the Cloud format is Anthropic.
- **Native Cloud catalog** via `GET /api/v1/models` (real context windows, max output, Reasoning/VU tags, CNY pricing), with the compatible-mode `/models` list as fallback. Anthropic `maxTokens` is still clamped to the verified **32768** ceiling so thinking does not squeeze the answer budget; OpenAI Completions/Responses keep the catalog ceiling.
- **More Cloud regions**: US-Virginia, Hong Kong, and workspace domains `{WorkspaceId}.{region}.maas.aliyuncs.com` (Beijing / Singapore / Tokyo / Frankfurt / US).
- **Rate limits (Cloud)** (`GET /api/v1/models/limits`) and an **authorized-only catalog filter** (`GET /api/v1/models/permissions`) — both best-effort, currently documented on the Beijing workspace domain.
- **OpenAI-compat flags:** `supportsStore: false` next to `supportsDeveloperRole: false`. Qwen 3.8 is vision-capable. Completions effort maps: Qwen 3.8 `low/medium/xhigh`, GLM-5.x / DeepSeek V4 `high/max`. Re-login / Reset / endpoint changes still prefer `authStorage` when pi exposes it, and write `auth.json` directly otherwise.
- **Startup no longer blocks on a live catalog fetch.** A cache younger than 4 hours is served immediately; `session_start` and `/alibaba → Refresh model lists` still refresh when the cache is stale or when you ask. Fetch failures still fall back to the stale cache.
- **Thinking levels:** reasoning models expose `high` and `max` in the picker on the Anthropic path. Unused intermediate levels are marked unsupported instead of being aliased onto `"high"`.
- **Kimi is not flagged as reasoning.** DashScope Anthropic-compat rejects `thinking_budget` for `kimi-k3` / `kimi-k2.7-code` (Fornace#9); `--thinking off` still sent the field. Cached catalogs rehydrate `reasoning` so a stale kimi entry does not keep sending it.
- Tests: deterministic `node:test` coverage for cache TTL, thinking-level maps, Responses routing, Anthropic maxTokens clamp, native catalog helpers, and reasoning/vision heuristics (no network, no provider).

## 1.0.15

- **Fix: large tool calls no longer truncated on reasoning models.** Every Cloud model used to report a flat `maxTokens: 8192` (Plan non-DeepSeek models: 65536). On pi's Anthropic path, `max_tokens` is a total budget shared between thinking and the final answer, so with pi's high thinking budget (16384) the answer budget collapsed to 8192 − 7168 = **1024 tokens** — enough to cut big `write`/`edit` calls mid-arguments (the model never emitted the `path` field; the content string ended abruptly). Reasoning models now report `maxTokens: 32768` → answer budget 32768 − 16384 = **16384** at high thinking, on both providers (Plan non-DeepSeek included; DeepSeek keeps its 16384 OpenAI-path value). 32768 was verified empirically as the universal `max_tokens` ceiling on the Anthropic-compat endpoint (non-reasoning `qwen-plus` rejects 65536 with `Range of max_tokens should be [1, 32768]`; `qwen3.8-max`, `deepseek-v4-flash`, `glm-5.2` and `kimi-k2.7-code` all accept 32768), so it can never be rejected as out of range. Non-reasoning models keep 8192 (pi sends it straight as the output cap — no thinking squeeze).
- Cached catalogs (offline fallback) now also recompute `maxTokens`, so stale caches pick up the fix.

## 1.0.14

- Release bump. First npm publish since 1.0.10; bundles the 1.0.11–1.0.13 work: Qwen 3.7 Plus/Max metadata (1M context, 3.7 Plus multimodal), shared Plan/Cloud capability heuristics, the `/alibaba → Context Window — Override` setting, the `/login` Cloud-visibility fix (#1), and Cloud catalog loading from `$DASHSCOPE_API_KEY`.

## 1.0.13

- **Cloud catalog now loads from `DASHSCOPE_API_KEY` too.** Previously the live catalog was only fetched when a key was saved via `/login`; users who authenticate the Cloud provider purely through the `DASHSCOPE_API_KEY` env var were stuck on the login-seed model. The catalog fetch now uses the saved key **or** the env var, so env-var users get their full, correctly-described model list. As a result the hardcoded login seed (added in 1.0.12 for #1) is now used **only** when there is no credential anywhere — a state in which no model is usable regardless, so it's purely a "sign in" entry, not a model guess.
- `/alibaba → Status` now reports Cloud auth via `$DASHSCOPE_API_KEY` when that's how you're authenticated.
- Docs: document env-var auth for the Cloud provider.

## 1.0.12

- **Fix: Cloud provider missing from `/login`** (#1). pi hides any provider that has zero registered models, so after the hardcoded fallbacks were removed the **Alibaba Cloud (API Key)** entry disappeared from `/login → Use an API key` until you were already logged in. The provider now registers a single real login seed (`qwen-plus`) whenever the live catalog is empty, so it's always visible to log into. This is one login seed, not a model-catalog fallback — the live catalog replaces it the moment you log in.
- **New setting: context-window override.** `/alibaba → Context Window — Override` lets you correct the context size shown on a model's card — per model id, or `*` for a global default. Stored in `alibaba-config.json` under `contextWindowOverrides`. Handy when a brand-new model is inferred with the wrong size (the `/v1/models` API doesn't report context windows).
- Docs: corrected a stale "48 hours" cache note (it's 4 h).

## 1.0.11

- **Qwen 3.7 support**: `qwen3.7-plus` and `qwen3.7-max` now report their correct **1M (1,048,576) token** context windows, and Qwen 3.7 Plus is correctly flagged as multimodal (text + image input). Both surface automatically from the live catalog — this just fixes their inferred metadata.
- Corrected `qwen3.6-max` to its actual **256K** context window (it does not share the 1M window of Qwen 3.6/3.7 Plus).
- Capability inference (context window, reasoning, vision) is now shared between the Plan and Cloud code paths via common helpers, so they can no longer drift apart. Fixes a case where Qwen 3.x Plus was treated as text-only and non-reasoning on the Cloud provider.
- Context-window matching now also covers dated model variants (e.g. `qwen3.7-plus-2026-06-01`).
- Docs: refreshed the model lineup and corrected stale cache notes (4 h TTL, cache-based offline fallback — no hardcoded list).
- Thanks to [@pkking](https://github.com/pkking) for reporting the context-window issue (#3).

## 1.0.10

- Fix `qwen3.6-plus` context window: now reports **1M (1,048,576)** tokens instead of the hardcoded 128K, on both the Plan and Cloud endpoints (#3, #4). Thanks [@pkking](https://github.com/pkking).
- Use the `$`-prefixed `$DASHSCOPE_API_KEY` env var reference to silence the legacy environment-variable deprecation warning.

## 1.0.9

- Offline resilience: a failed catalog fetch (no connection, DNS, timeout) no longer crashes the extension — and therefore no longer prevents `pi` from starting or blocks your local/other-provider models. The startup and `session_start` catalog loads now fall back to the last-known-good on-disk cache and emit a warning instead of throwing. Live API remains the source of truth whenever it's reachable; the cache is an offline fallback only. If there's no cache either, the affected provider registers with an empty model list (a warning, not a fatal error).

## 1.0.8

- Fix startup model resolution by making the extension factory async and fetching live Plan/Cloud catalogs before provider registration. Pi now validates `enabledModels` against the real API model lists immediately, eliminating startup "No models match pattern" warnings without hardcoded or cache fallbacks.

## 1.0.7

- Bump (1.0.6 already published).

## 1.0.6

- Removed all hardcoded model fallbacks (`PLAN_MODEL_DEFS_FALLBACK`, `CLOUD_FALLBACK`). If the API is unreachable and no stale cache exists, the extension now errors immediately instead of silently degrading to a stale model list. This eliminates transient "no models match" warnings caused by the hardcoded list being out of sync with the live catalog.

## 1.0.5

- Plan model list now fetched dynamically from the Plan endpoint's own `/compatible-mode/v1/models` API (primary source), replacing the fragile GitHub TypeScript template parser. New models appear automatically as Alibaba ships them — no extension update needed. The GitHub template parser remains as a secondary fallback.

## 1.0.4

- Version bump (no code changes)

## 1.0.3

- Sync factory pattern: hardcoded models registered instantly for picker availability, with lazy `session_start` fetch that re-registers both providers with live catalog data

## 1.0.2

- Fix README install instructions: replaced hardcoded local path (`/Users/francesco/alibaba-pi-package`) with `pi install pi-alibaba-models` everywhere (Install, Uninstall, Troubleshooting). npm and git fallbacks documented.

## 1.0.1

- Pre-release polish: fix LICENSE author, fix import scope, expand README, sync model lineup (Qwen 3.6 Max, DeepSeek V4 Pro), gitignore `package-lock.json`
- Use Supabase CDN for directory banner

## 1.0.0

- Initial release
- Two providers: `alibaba-plan` (Model Studio Coding Plan) and `alibaba-cloud` (DashScope API Key)
- `/alibaba` slash command for runtime configuration
- Dynamic plan model list fetched from upstream Qwen Code template
- Cloud model list fetched live from DashScope `/v1/models`
- Vision support via `input: ["text", "image"]` for VL/Qwen-plus models
- Qwen thinking support with `thinkingFormat: "qwen"` and `thinkingLevelMap`
- DeepSeek models forced to OpenAI-compat endpoint (Anthropic-compat hangs)
- Auth migration from legacy single-key format to split Plan/Cloud
