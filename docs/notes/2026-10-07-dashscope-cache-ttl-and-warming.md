# DashScope context cache: TTL facts & cache warming (2026-10-07)

Research notes after a night of orchestrator sessions with heavy `cache miss` telemetry
(pi-debi turn-metrics: every miss after idle ≥ ~5 min; active back-to-back turns hit).

## TL;DR

- **TTL is NOT configurable.** Explicit and session cache are hard-coded at **5 minutes, reset on
  every hit**. Implicit cache has *no* fixed TTL (system-managed, probabilistic hit). There is **no
  1-hour tier** (no DashScope analogue of Anthropic's extended cache TTL).
- The only way to stretch effective lifetime is **renewing on hit** — i.e. pi's prompt-cache
  **warming** (`cacheWarming` setting). This extension already declares the eligibility metadata
  (`promptCache: { short: 300 }`), so warming works out of the box once enabled in pi settings.

## The three cache modes (official docs, help.aliyun.com/zh/model-studio/context-cache, rev. 2026-10-03)

| | Explicit | Implicit | Session (Responses API) |
|---|---|---|---|
| Enabled by | `cache_control: {type: "ephemeral"}` markers in messages (≤4/request) | automatic, cannot be disabled | `x-dashscope-session-cache: enable` header |
| TTL | **5 min, reset on hit** | none published; system cleans up idle data | **5 min, reset on hit** |
| Write cost | 125% of standard input | 100% | 125% (when explicit is used under the hood) |
| Hit cost | ~10% (⚠ per-model exceptions) | ~20% (⚠ per-model exceptions) | ~10% (⚠ per-model exceptions) |
| Determinism | 100% deterministic hit | probabilistic even for identical prefixes | deterministic for models with explicit support |

Constraints (all modes): min cacheable block 1024 tokens; exact matching — any character change
(including whitespace) in system/user prompt zeroes `cached_tokens`; `tools` are part of the system
prompt for cache purposes (tool list changes ⇒ miss); cache creation happens **after** the model
responds; backward prefix matching checks the last 20 content blocks.

### ⚠ qwen3.8 family pricing exception

`qwen3.8-max`, `qwen3.8-max-0902`, `qwen3.8-flash`, `qwen3.8-2.4t-a95b`: hit price is **not** the
standard 10% (explicit/session) or 20% (implicit) — «具体价格请参见百炼控制台» (see Bailian
console). **TODO: read the actual rates from the console before trusting the economics below.**

## What this extension already does

- `PROMPT_CACHE = { short: 300 }` + `promptCacheFor(id)` gated by `capsFor(id).cache`
  (`extensions/alibaba.ts` ~line 577): caching-capable families (incl. all `qwen3.8*`, `qwen3.5-3.7`,
  `glm`, `kimi`) are **eligible for pi cache warming**; open-weight `qwen3-<size>b` and unknown
  families stay ineligible. `long` tier deliberately unset — nothing longer is published.
- `x-dashscope-session-cache: enable` on every Cloud **Responses** request (`~line 1040`), toggle:
  `/alibaba → Cloud — Session Cache` / `cloudSessionCache` in config. Reads ~10% vs implicit 20–25%,
  writes 125%.
- Warming requests go through the same Responses stream path, so they should carry the session-cache
  header too (verify on first observed `cache_warm` request — see Verification).

## pi cache warming (the "extend TTL" mechanism)

- pi settings: `"cacheWarming": "off" | "streaming" | "idle"` (default `streaming`; **global only**).
  `"idle"` keeps the cache warm **between runs** — exactly the long-session-with-pauses scenario.
- pi warms only when the model declares a `promptCache` lifetime for the active tier **and** pi
  estimates ≥ **$0.05** of avoided cache-miss cost. Refreshes are recorded as usage entries
  `kind: "cache_warm"` (session format) and do **not** enter model context. `/session` shows the next
  decision; `showCacheMissNotices: true` surfaces miss/warm notices in-session.
- Extensions can override each idle decision via the `cache_warming_decision` hook
  (`{ action: "warm" }` / `{ action: "stop" }`, last handler wins) — the place for scenario policy
  (see below) if the native $0.05 gate proves too naive.

## Economics for our scenarios (measured rate $1.04/M input, ~120k-token prompt)

| Event | Cost |
|---|---|
| Full miss after idle (implicit) | ~$0.125 |
| Full miss + session-cache rewrite (125%) | ~$0.156 |
| One warming refresh (~10% hit rate; qwen3.8-max rate is console-TBD) | ~$0.0125 |
| Refreshes needed per idle hour (TTL 5 min → every ~4 min) | ~15 ⇒ ~$0.19/h |

Break-even: warming pays off for pauses up to **~30–40 min**; for multi-hour/overnight idles a single
miss is cheaper than keeping the cache alive. Scenario mapping (debi modes):

- **Orchestrator waiting on async children** — resume is *guaranteed* (completion notification).
  Waits < ~30 min: warm. Longer child runs (hours): warming is net-negative; a `cache_warming_decision`
  policy could cap warming at N refreshes per idle period.
- **Human thinking pauses (5–40 min)** — the sweet spot; warm.
- **Overnight idle** — do not warm; accept the morning miss (or lower the prefix cost: pi-debi
  `ops-mode small` saves ~7–8k tokens/miss).
- **Session-cache ON/OFF rule of thumb**: back-to-back agent turns (gaps < 5 min) → ON (10% reads);
  gap-heavy human chat with ≥1 miss per 2 hits → OFF (skip the 125% write premium).

## Verification plan (after enabling `"cacheWarming": "idle"`)

1. `/session` — next warming decision visible for the active model.
2. Session `session.jsonl` — entries with `kind: "cache_warm"`; usage counted, context untouched.
3. First warm request — confirm the `x-dashscope-session-cache: enable` header is present (provider
   stream logs / `provider_stream_event`); without it the refresh renews nothing server-side.
4. turn-metrics (pi-debi): miss count on next resume after a 5–30 min pause should drop to 0.
5. If pi's $0.05 gate warms through long idles and waste grows — add a `cache_warming_decision`
   handler in this extension (policy: stop after N refreshes / when idle > 40 min).

## Sources

- help.aliyun.com/zh/model-studio/context-cache (rev. 2026-10-03) — modes, TTL, pricing, FAQ
- help.aliyun.com/zh/model-studio/explicit-cache-best-practice — cache_control mechanics, ≤4 markers, tools-in-cache
- alibabacloud.com/help/en/model-studio/compatibility-with-openai-responses-api — session cache header, exact matching rules
- pi docs: settings.md (`cacheWarming`, `showCacheMissNotices`), models.md#prompt-cache-lifetimes,
  extensions.md#cache_warming_decision, session-format.md (`cache_warm` usage entries)
- Local telemetry: ~/.pi-debi/pi-debi.log (miss↔idle correlation: 330s/592s/1020s/4610s/15465s → miss;
  active turns → cacheRead > 0)
- Profile Wiki: DebiForeverProfile/Wiki/discoveries/2026-10-07-dashscope-context-cache-ttl-5-мин-захардкожен-60-минутного-т.md
