# Prompt caching across the non-qwen families (measured 2026-10-07)

Question: does DashScope prompt caching work beyond the `qwen*` line, i.e. is the warm engine and the
declared cache pricing valid for GLM, Kimi, DeepSeek and MiniMax too?

Method: for each model, the shape this extension actually registers — **Responses +
`x-dashscope-session-cache: enable`** for `responsesCapable` families, **Chat Completions + two
`cache_control: {"type":"ephemeral"}` markers** for the ones that ride Completions and publish
explicit-cache rows — with one unique prefix per model, repeated 15 s apart, ~1.9k tokens (and ~8k
for the follow-up). Reproduce with
[`2026-10-07-dashscope-cache-families-probe.py`](2026-10-07-dashscope-cache-families-probe.py);
raw lines in [`2026-10-07-dashscope-cache-families-results.jsonl`](2026-10-07-dashscope-cache-families-results.jsonl).
The whole plan was run **twice**; both runs agreed on every model.

## Results

`cached` per call, in order. `creation` and `cache_type` appear only where the provider runs an
explicit block.

| Model | Shape (as registered) | prompt | cached | creation | regime |
|---|---|---|---|---|---|
| qwen3.8-flash | responses + header | 2167 | 0 → **2161** | 2161 → 0 | explicit (`ephemeral`) |
| glm-5.1 | completions + markers | 1923 | 0 → **1921** | 1921 → 0 | explicit |
| kimi-k2.5 | completions + markers | 1780 | 0 → **1775** | 1775 → 0 | explicit |
| kimi-k2.7-code | completions + markers | 1824 | 0 → **1820** | 1820 → 0 | explicit |
| deepseek-v3.2 | completions + markers | 1907 | 0 → **1905** | 1905 → 0 | explicit |
| glm-5.3 | responses + header | 1956 | 0 → **1792** → 1792 | — | implicit |
| glm-5.3 | responses + `disable` | 1911 | 0 → **1792** | — | implicit (header is a no-op) |
| glm-4.6 | responses + header | 1950 | 0 → **1792** → 1792 | — | implicit |
| kimi-k3 | responses + header | 2024 | 0 → **1024** → 1024 | — | implicit, 1024-token quanta |
| deepseek-v4.1-flash | responses + header | 1869 | 0 → **1792** → 1792 | — | implicit |
| deepseek-v4-pro | responses + header | 1933 | 0 → **1024** → 1024 | — | implicit, 1024-token quanta |
| MiniMax-M2.1 | responses + header | 1846 | 0 → 0 → 0 | — | **none at this size** |
| MiniMax-M2.1 | responses + header | 7646 | 0 → **7552** → 0 | — | implicit, intermittent |
| MiniMax-M2.1 | completions, no markers | 8009 | 0 → **7936** → 0 | — | implicit, intermittent |
| kimi-k3 | responses + header | 8114 | 0 → **7168** | — | implicit |
| MiniMax/MiniMax-M2.5 | completions | — | HTTP 400 `The product is not activated` | — | account, not caching |

TTL check on a non-qwen explicit block (`kimi-k2.5`, markers, same prefix throughout):

| t | cached | creation | reading |
|---|---|---|---|
| 0 | 0 | 1775 | block created |
| +25 s | 1775 | 0 | hit |
| +4.7 min | 1775 | 0 | hit — 4.25 min after the previous hit, so the window renewed |
| +5.3 min after that hit | 0 | 1775 | expired and re-created |

## What this settles

1. **Caching is not a qwen feature.** Every family tested caches except MiniMax below ~4k tokens.
   The warm engine, the cache pricing and the marker injection are valid across GLM, Kimi, DeepSeek
   and (above the size threshold) MiniMax.
2. **Two regimes, and the catalog tells them apart.** Families that publish `input_token_cache_read`
   / `input_token_cache_creation_5m` rows get an exact, deterministic explicit block with a 125 %
   write premium. Families that publish only `input_token_cache` get implicit hits in 128- or
   1024-token quanta, no creation charge and no `cache_type`. That is precisely the split
   `declareCacheCost()` implements, and the probe confirms it holds per family, not just per price
   list: glm-5.1 reports `creation` while glm-5.3 never does.
3. **The 5-minute TTL renewed on hit is family-independent** — measured here on Kimi's explicit
   block exactly as on qwen's (C3/C4/C5 in the main probe). One `refreshSeconds` for every model is
   therefore correct, and no per-family TTL table is needed.
4. **The session-cache header is a no-op without explicit rows**, as documented: `glm-5.3` returned
   the same implicit `cached=1792` with `enable` and with `disable`. Keeping the header on such
   models costs nothing and buys nothing — the price declaration (implicit read, no write premium)
   is what has to be right, and it is.
5. **Marker injection works on every non-qwen explicit family** (glm-5.1, kimi-k2.5, kimi-k2.7-code,
   deepseek-v3.2): first request `creation=N`, second `cached=N`, exact to the token. Before 2.1.0
   these models had implicit caching only, with coarser quanta and no determinism.
6. **Quantization differs per family**: 128-token quanta on qwen/glm/deepseek-v4.1-flash, 1024 on
   `kimi-k3` and `deepseek-v4-pro` (2024 → 1024 cached, i.e. half the prompt). An implicit hit is
   therefore worth less on those two than the token count suggests, which is another argument for
   explicit caching where the catalog offers it.
7. **MiniMax is the exception.** No caching at ~1.9k tokens; at ~7.6k it hit once and then missed
   again 30 s later on the identical prefix, on both shapes. That pattern is consistent with a
   per-replica cache behind a load balancer rather than a shared one. Consequence: for MiniMax a warm
   may refresh a different replica than the one the next real request lands on, so warming there is a
   bet, not a guarantee.

## Consequences for the code

- **`modelCachesPrompt()` gate (added with these measurements).** The engine now refuses to warm a
  model with no cache rows in the catalog (`explicitCache || implicitRead > 0`), falling back to the
  family table when a boot was served from the compatible-mode listing, which carries no rows. The
  open-weight `qwen3-<size>b` line and unknown families are skipped instead of spending quota on a
  block that is never created.
- **The 20k default prompt floor is load-bearing for MiniMax**, which does not cache at all below
  ~4k tokens and caches unreliably above it. Lowering `minPromptTokens` to 0 makes warming
  effectively useless on that family; the telemetry's `arrived after expiry` / hit split will show it.
- **No per-family interval or TTL.** Point 3 is why one `refreshSeconds` serves every explicit model.
  The implicit families have no published TTL, so they are refreshed on the same schedule; whether
  that is wasteful is the open implicit-TTL question on the `docs/TODO.md` watch list, and
  `alibaba-cache.jsonl` now records exactly the data that would answer it (implicit models never
  report `creation`, so a warm that shows `cached=0` and no creation on them is a miss we paid full
  price for).
- **`MiniMax/MiniMax-M2.5` returning `The product is not activated`** is an account entitlement, not
  a caching fact. The authorized-only filter (`/alibaba → Cloud — Authorized-only Filter`) is the
  mechanism that should hide such models; this key's workspace evidently lists it without
  entitlement.

## The Anthropic shape (pi-ai injects the markers there itself)

`cloudApiFormat: anthropic-messages` is a supported Cloud format, and pi-ai always adds
`cache_control` on that shape — which is why 2.1.0 declares explicit cache prices for it. Verified
with [`2026-10-07-dashscope-anthropic-cache-probe.py`](2026-10-07-dashscope-anthropic-cache-probe.py)
(`POST /apps/anthropic/v1/messages`, ~2k-token prefix, with and without a marker):

| Model | marker | call 1 | call 2 |
|---|---|---|---|
| qwen3.8-max-0902 | yes | `input 6`, `cache_creation 2084` | `input 6`, `cache_read 2084` |
| qwen3.8-max-0902 | no | `input 2135` | `input 87`, `cache_read 2048` (implicit, 128-quanta) |
| kimi-k2.6 | yes | `input 5`, `cache_creation 1820` | `input 5`, `cache_read 1820` |
| kimi-k2.6 | no | `input 1960` | `input 40`, `cache_read 1920` |
| glm-5.3 | yes | `input 1930`, no cache fields | `input 138`, `cache_read 1792` |
| glm-5.3 | no | `input 1930`, no cache fields | `input 138`, `cache_read 1792` |

Three facts that matter for the declarations:

1. **Explicit caching works on this shape** for families that publish explicit rows, with Anthropic
   accounting: cached tokens leave `input_tokens` and appear in `cache_read_input_tokens`.
2. **A marker on a family without explicit rows is silently ignored** — `glm-5.3` behaves identically
   with and without it, and never reports `cache_creation_input_tokens`. No error, no 125 % write.
   `declareCacheCost()` gates on the catalog rows, not on the shape, so such a model is still priced
   as implicit (read 2, write 0) — which is what the provider bills.
3. **Implicit caching also runs on this shape** (the marker-less rows above), so the shape never
   loses caching altogether.

## Sources

- Probe: this directory's `-families-probe.py` / `-families-results.jsonl`, 2026-10-07, against
  `llm-….cn-beijing.maas.aliyuncs.com` (the bound workspace domain), ~45 requests ≈ 130k tokens.
- Catalog rows: `GET /api/v1/models?capabilities=TG` (154 models) — which families publish explicit
  vs implicit cache prices.
- [`2026-10-07-long-session-cache-provider-data-and-options.md`](2026-10-07-long-session-cache-provider-data-and-options.md)
  §1.2–1.3 for the qwen baseline this compares against, and
  [`2026-10-07-dashscope-cache-probe.py`](2026-10-07-dashscope-cache-probe.py) for the TTL/scope
  phases.
- help.aliyun.com/zh/model-studio/context-cache — implicit vs explicit modes, the "no explicit
  support ⇒ implicit cache" rule for the session-cache header.
