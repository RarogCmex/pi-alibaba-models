# Long-session cache: measured provider data, pi's warmer internals, and options (2026-10-07)

Follow-up to [`2026-10-07-dashscope-cache-ttl-and-warming.md`](2026-10-07-dashscope-cache-ttl-and-warming.md),
which fixed the TTL facts from documentation. This note adds what documentation cannot give:

1. **Provider data read from the live catalog and from probe requests** against our own Cloud key
   (prices incl. the qwen3.8 "console-TBD" exception, usage field map, TTL renewal, cache scope).
2. **pi's warmer as installed** (`dist/core/cache-warmer.js`, `dist/core/sdk.js`, pi-ai's
   `openai-responses.js`) — schedule, hard caps, the decision formula, the replay shape.
3. **Four months of local telemetry** (all `~/.pi/agent/sessions`, 2026-06-15 → 2026-10-07):
   146 real warm requests, 646 cold misses, per-day hit rates, latency of hits vs misses.
4. **Ranked options** with the arithmetic that supports each one.

Probe script: [`2026-10-07-dashscope-cache-probe.py`](2026-10-07-dashscope-cache-probe.py)
(16 requests, ~70k tokens, < 0.5 CNY; `--skip-ttl` skips the 15-minute chain), raw results in
[`2026-10-07-dashscope-cache-probe-results.jsonl`](2026-10-07-dashscope-cache-probe-results.jsonl)
(one line per request, full `usage` objects included). Phase names below are the script's `C*`
labels; `P*`/`Q*` refer to the exploratory runs it was built from.

## TL;DR

- The previous note's TTL story holds and is now **measured**: a hit at +4.5 min renewed the block,
  a hit at +9.5 min renewed it again, and the request at +15 min (5.5 min after the last hit) missed
  and re-created it. 5 minutes, reset on hit, no longer tier, no configuration knob.
- **The economics in the previous note are wrong by roughly an order of magnitude**, in both
  directions. The catalog prices are CNY per million and pi reads them as USD; and for 72 of 154
  Cloud models — including the default `qwen3.8-max-0902` — `parseApiV1Prices()` picks the *wrong
  price row* (`1` instead of `12`), because it matches `/input/i` against `input_token_cache_read`
  too and keeps the last match. Every pi/pi-debi cost figure and every warming decision is computed
  from those numbers.
- The qwen3.8 "see Bailian console" exception is resolved from the live catalog: **implicit hit
  12.5 %** of input (1.5 of 12 CNY/M), **explicit/session hit 8.33 %** (1 CNY/M), **explicit
  creation 125 %** (15 CNY/M). Better than the documented "typical" 20 %/10 %.
- pi's idle warming stops **30 min after the request that started it** (`MAX_IDLE_WARMING_AGE_MS`);
  streaming warming stops after 60 min. No extension hook extends those. A longer horizon means an
  extension-owned warmer, and the arithmetic says that is only worth it with a *known* resume.
- Warming works on DashScope, but our own history shows its weak point: **10 of 146 warm requests
  arrived after the block had expired and paid full price — 34 CNY, more than the 136 successful
  warms cost (31 CNY)**. All ten fired 274–328 s after the previous completion on 73k–593k-token
  prompts: pi's 270 s schedule leaves ~15 s of margin, which huge prompts do not always make.
- The dominant cache loss in long sessions is **not** TTL expiry. Of 928 CNY of cold-miss spend
  (prompts ≥ 20k, artifact window excluded): **38 % happened < 300 s after the previous request**
  (prefix invalidation — context rewrites, compaction, session/child cold starts), 29 % falls in
  pi's warmable 5–30 min window, 26 % is beyond any economical warming.
- The strongest argument for warming here is **latency, not money**: a 150k–220k prompt takes
  10–17 s when cached and 57–151 s when it misses.
- An asymmetry worth exploiting: the **explicit/session block died at 5.5 min, while an implicit
  block was still hitting 25 min later** (C6). For gap-heavy sessions the session-cache header can
  be the wrong default — it converts every >5-min pause into a guaranteed 125 % rewrite, where
  implicit caching costs at most 100 % and sometimes still hits at 12.5 % (option P2-K).
- A 4-day window (Sep 23–27) shows 0–20 % *reported* hit rate on the Responses format with no
  latency signature of real misses: a **usage-reporting blind spot**, not a cache outage. DashScope
  reports cache creation tokens *only* in `usage.x_details[].prompt_tokens_details`, which pi-ai
  never reads.

## 1. Provider data (live, 2026-10-07, workspace domain `llm-….cn-beijing.maas.aliyuncs.com`)

### 1.1 Catalog prices — `GET /api/v1/models?capabilities=TG`, CNY per 1M tokens

| Model | input | output | implicit hit `input_token_cache` | explicit create `…_cache_creation_5m` | explicit hit `…_cache_read` |
|---|---|---|---|---|---|
| qwen3.8-max | 12 | 36 | 1.5 (12.5 %) | 15 (125 %) | 1 (8.33 %) |
| qwen3.8-max-0902 | 12 | 36 | 1.5 | 15 | 1 |
| qwen3.8-2.4t-a95b | 12 | 36 | 1.5 | 15 | 1 |
| qwen3.8-flash | 0.8 | 2.7 | 0.1 (12.5 %) | 1.25 | 0.1 |
| qwen3.7-plus (≤256k tier) | 2 | 8 | 0.4 | 2.5 | 0.2 |
| qwen3.7-plus (256k–1M tier) | 6 | 24 | 1.2 | 7.5 | 0.6 |
| glm-5.3 | 8 | 28 | 2 (25 %) | — | — |
| kimi-k3 | 20 | 100 | 2 (10 %) | — | — |
| deepseek-v4.1-flash | 1 off-peak / 2 peak | 4 / 8 | 0.1 / 0.2 (10 %) | — | — |

These are the `Default` (untiered) rows for the cn-beijing deployment our key is bound to; the
*international* deployment of the same model id is priced separately ($2 / $6 per M for
`qwen3.8-max`), so the English price list on alibabacloud.com is not interchangeable with these.

Three structural facts the parser currently ignores:

- **Presence of `input_token_cache_*` rows is a machine-readable "supports explicit cache" signal.**
  81 of 154 models expose cache rows; `glm-5.3`, `kimi-k3`, `deepseek-v4.x` expose only
  `input_token_cache` (implicit). Per the Responses doc, with the session-cache header ON a model
  without explicit support "uses implicit cache" — so for those families **the header changes
  nothing**: no 125 % write premium, but no determinism gain either.
- **43 of 154 models are tiered by prompt size** (`range_name` like `输入<=256k`, `256k<输入<=1m`)
  and have **no `Default` range**; `parseApiV1Prices()` then falls back to `prices[0]`, i.e. the
  *cheapest* tier. `qwen3.5-plus` reads 0.8 CNY/M while a 300k-token request bills at 4 CNY/M (5×).
  Long sessions live exactly in the expensive tier.
- **3 models carry `time_band: peak|offpeak` rows**; the parser keeps whichever comes last.

### 1.2 Where cache tokens are reported (probe-verified, `qwen3.8-max-0902`)

| Mode | cached tokens | creation tokens | granularity |
|---|---|---|---|
| Responses + `x-dashscope-session-cache: enable` | `usage.input_tokens_details.cached_tokens` **and** `usage.x_details[].prompt_tokens_details.cached_tokens` | **only** `usage.x_details[].prompt_tokens_details.cache_creation_input_tokens` (+ `.cache_creation.ephemeral_5m_input_tokens`, `.cache_type: "ephemeral"`) | exact block (4563 of 4569 input; the ≤10 tokens the backend appends after the marker are not cacheable) |
| Responses, header off/absent (implicit) | both places | never reported | quantized to 128-token blocks (4224, 4096) |
| Chat Completions + `cache_control: {"type":"ephemeral"}` | `usage.prompt_tokens_details.cached_tokens` | `usage.prompt_tokens_details.cache_creation_input_tokens` | exact (4531 of 4549, C8/C9) |
| Anthropic-compatible | `usage.cache_read_input_tokens` (not part of `input_tokens`) | `usage.cache_creation_input_tokens` | exact |

pi-ai reads `usage.input_tokens_details.cached_tokens` (→ `cacheRead`, correct) and
`usage.input_tokens_details.cache_write_tokens` (→ `cacheWrite`, **a field DashScope never sends**).
So pi currently records every Cloud cache write as ordinary input at 100 %, while the bill is 125 %
with the session-cache header on.

### 1.3 TTL, renewal, scope (probe)

| Phase | t | result |
|---|---|---|
| C1 create (header ON, 4569-token prompt) | 0 s | `creation=4563`, `cached=0`, `cache_type=ephemeral` |
| C2 hit | +25 s | `cached=4563` |
| C3 renew | +4.5 min | `cached=4563` |
| C4 renew | +9.5 min | `cached=4563` → **a hit really does reset the 5-min clock** |
| C5 expire | +15 min (5.5 min after the last hit) | `cached=0`, `creation=4563` → TTL is still 5 min |
| C6 implicit, header `disable`, prefix last sent **25 min earlier** | — | `cached=4096` → **implicit blocks outlive the explicit 5-min window by a wide margin** |
| C7 implicit hit | +25 s | `cached=4224` (128-token blocks: 33 × 128) |
| C8/C9 Chat Completions + `cache_control` | 0 / +25 s | `creation=4531` → `cached=4531`: explicit caching works on the Completions format too (exact, `cache_type=ephemeral`) |
| C10 same bytes, **different `prompt_cache_key`** | — | `cached=4563` → **the cache is prefix-scoped, not key/session-scoped** |
| C11/C12 header absent / `disable` | — | `cached=4224` → implicit is a **separate store**; explicit and implicit are mutually exclusive per request |
| C13/C14 brand-new unique prefix, implicit | 0 / +25 s | `cached=0` then `4224` → implicit hits are prefix-based, not fuzzy |
| C15/C16 same unique prefix, header ON | 0 / +25 s | `creation=4453` then `cached=4453` → explicit is exact and deterministic |

Two consequences:

- Because the cache is prefix-scoped, **any two pi sessions that share a byte-identical prefix share
  the cache** — the basis for option P2-I (child/fork prefix alignment).
- Because the implicit store survives far longer than 5 minutes (one observation at 25 min, and the
  docs only promise "the system periodically clears old, unused cache data"), the session-cache
  header is not automatically the right default for every session shape — see option P2-K and the
  implicit-TTL experiment in §6.

One anomaly worth remembering: the exploratory run reported `cached=4096` for a *first-ever* prefix
that differed from a cached one by one character per line (P4), while the identical shape with a
different tag correctly reported `0` (Q1). Both readings came from the implicit store. Treat a
single implicit `cached_tokens` value as approximate; the eight explicit/session measurements were
exact every time (`creation` size == later `cached` size).

### 1.4 Warm-replay shape

pi replays the request with `maxTokens: 1`, which pi-ai clamps to
`OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16`. Probe confirms DashScope accepts that on a reasoning
model (`reasoning.effort: low`): every warm returned `output_tokens: 16` with 13–16 reasoning
tokens, no error. Cost of the output side: 16 × 36 CNY/M ≈ 0.0006 CNY — negligible next to the
cached-read side. Headers come from `model.headers` (`openai-responses.js:192`), so the session-cache
header rides along on every warm: the earlier note's open question 3 is answered **yes** without
needing a stream capture.

### 1.5 Two Responses-endpoint limits that matter for long sessions

- **Silent truncation**: "the maximum input context of the Responses API is approximately 80 % of
  the model's context window … Any excess is automatically truncated without raising an error."
  We register `contextWindow: 1_000_000` for `qwen3.8-*`, so pi will happily build a 900k-token
  request and the endpoint will quietly drop the tail. Our largest observed prompt is 593k, i.e.
  already inside the 800k danger zone.
- `previous_response_id` (server-side context, **valid 7 days**) and the `conversation` API exist,
  but pi-ai hardcodes `store: false`, so nothing is ever stored and neither is reachable. It also
  sends `prompt_cache_key` (the session id), which DashScope ignores — probe P6b shows that is
  harmless because the cache is prefix-scoped anyway.

## 2. pi's warmer as installed (pi 1.0.4)

From `dist/core/cache-warmer.js` and `dist/core/sdk.js:259`:

| Aspect | Value |
|---|---|
| Start point | `cacheWarmer.start()` is called at **dispatch**, only when `options.sessionId` is the session's (compaction/summary requests do not restart it) |
| Refresh delay | `min(0.9·TTL, TTL − 10 s)` → **270 s** for `promptCache.short = 300` |
| Dispatch deadline | `nextWarmAt + (TTL − delay)/2` = **+15 s**; a later fire ends warming with `cache refresh deadline missed` and it does not resume until the next real request (sleep/hibernation is the usual cause) |
| Hard caps | streaming phase: 60 min from `startedAt`; **idle phase: 30 min from `startedAt`** — not from when the run settled |
| Decision | `expectedSavings = p · missCost − warmCost`, warm iff ≥ **$0.05**; `p = 1` (streaming) or **0.15** (idle, a hardcoded constant: "per-session estimates were not better than this constant") |
| Costs used | `missCost = price(cacheWrite>0 ? {cacheWrite:P} : {input:P}) − price({cacheRead:P})`; `warmCost = price({cacheRead:P, output:1})`; `P` = last assistant message's `input+cacheRead+cacheWrite` |
| Replay | same model/context/options, `maxTokens: 1` (→16), `maxRetries: 0`, aborted on context change; usage persisted as `kind: "cache_warm"`, never enters context |
| Extension hook | `cache_warming_decision` receives only `{warmCost, missCost, continuationProbability, action}`; returning `{action:"warm"|"stop"}` overrides, last handler wins. No idle-elapsed, no refresh count, no prompt size — an extension must keep its own counters |

### 2.1 What our declarations do to that decision

This extension registers Cloud models with `cost: { input: <parsed>, output: <parsed>, cacheRead: 0,
cacheWrite: 0 }`. Consequences for `qwen3.8-max-0902` (parsed input = **1**, real = 12 CNY/M):

- `cacheWrite = 0` → `missCost` uses the plain `input` price, not the 125 % creation price.
- `cacheRead = 0` → `warmCost` ≈ 0 (only the 16 output tokens), so pi believes warming is free.
- The gate reduces to `p · P · 1/M ≥ 0.05`: **streaming warms from P ≈ 50k tokens, idle only from
  P ≈ 333k**. That matches telemetry: no warm was ever observed on a `qwen3.8-max-0902` prompt below
  70k, and the 70k–105k warms can only have been streaming-phase decisions.

What the three P0 fixes do to the idle threshold (`P` = prompt tokens at which pi starts warming):

| State | `qwen3.8-max-0902` | `glm-5.3` |
|---|---|---|
| Today (parsed 1 / 2 CNY read as USD, cache prices 0) | 333k | 167k |
| + P0-A exact rows (12 / 8 CNY, still read as USD) | 28k | 42k |
| + P0-C converted to USD (1.69 / 1.13 USD/M) | 197k | 296k |
| + P0-B honest `cacheRead`/`cacheWrite` | **321k** | **never** (break-even p = 33 % > pi's 15 %) |

Two things follow. First, for the default model the errors nearly cancel — the honest end state
(321k) is close to today's accidental 333k — so P0 alone will not visibly change warming here, and
the value of P1-E is that it replaces a 333k-token accident with a decision we chose. Second, honest
prices make pi *correctly refuse* to warm families whose cached reads are expensive (`glm-5.3` at
25 %: warming breaks even only above a 33 % resume probability), so a forced `warm` in P1-E should be
scoped to models where the measured break-even is below pi's 15 % assumption — `qwen3.8-*` at 7.1 %,
not everything.

## 3. Local telemetry (2026-06-15 → 2026-10-07)

### 3.1 Warm requests: 146 in 32 sessions (first one 2026-09-24)

| | count | tokens | recomputed at catalog prices |
|---|---|---|---|
| Successful warms (`cacheRead > 0`) | 136 | 29.58 M cached | **≈ 31 CNY** |
| Failed warms (`cacheRead = 0`, full-price rewrite) | 10 | 4.26 M input | **≈ 34 CNY** |

Failed-warm gaps after the previous completion: 274, 282, 293, 299, 307, 309, 320, 328 s (plus
outliers 143 s and 723 s), on prompts of 73k, 100k, 254k, 291k, 323k, 360k, 393k, 411k, 484k,
593k tokens. Eight of ten sit **right at the 300 s boundary**: the refresh was dispatched inside
pi's 15 s window but the server-side lookup happened after expiry — plausible for 250k–600k-token
payloads, where upload, queueing and prefill scheduling eat the margin. No two failed warms were
consecutive (a failure re-creates the block, so the next one hits).

Chains: 109 chains, 17 with more than one warm; median warm-to-warm gap 273 s (pi schedules 270 s).
The longest chain is 12 warms over 51.4 min (`glm-5.3`, 207k prompt) — that is the **streaming**
phase (60-min cap); idle chains top out at 3–4 warms ≈ 9–14 min, so the 30-min idle cap rarely
binds in practice: a real request usually arrives first.

### 3.2 Where the miss money goes (Cloud, prompts ≥ 20k, Sep 23–27 excluded)

| Bucket | n | CNY | share |
|---|---|---|---|
| Cached reads (the win) | — | 5 266 (4 883 M tokens ≈ 1.08 CNY/M) | — |
| Cold misses, gap **< 300 s** → prefix invalidation | 247 | 357 | 38 % |
| Cold misses, gap 300–600 s | 75 | 124 | 13 % |
| Cold misses, gap 600–1800 s → **pi's warmable window** | 87 | 149 | 16 % |
| Cold misses, gap 1800–3600 s | 58 | 100 | 11 % |
| Cold misses, gap > 1 h | 66 | 145 | 16 % |
| Cold misses, first request of their session (no previous request to gap against) | 113 | 53 | 6 % |
| Total cold-miss spend | 646 | **928** | |

Inside the < 300 s bucket — the largest one, and one no warmer can touch — 49 misses (78 CNY) are
provable **context rewrites**: the prompt shrank between two requests seconds apart (compaction,
context edits, truncated tool output). The 113 session-first misses are cold starts; of the 51
sessions whose *first* big request could be attributed, 47 were cold on Responses and only the 4
Anthropic-format ones hit (option P2-I).

Caching already carries the workload: 4 883 M cached tokens vs 112 M missed tokens (**43 : 1**).
Against the session-cache break-even of 6 hits per miss (§3.3), the header being ON by default is
clearly right for this usage.

### 3.3 Session-cache ON vs OFF, corrected

Per 100k prompt tokens on `qwen3.8-max-0902`: ON costs 1.5 CNY on a miss / 0.1 CNY on a hit; OFF
costs 1.2 / 0.15. Break-even = **6 hits per miss** (the previous note's "≥1 miss per 2 hits → OFF"
was based on the wrong 10 %/20 % rates; with the standard 20 %/10 % families the break-even is 2.5).

### 3.4 Warming arithmetic, corrected (per 100k prompt tokens, qwen3.8-max-0902, header ON)

| | CNY |
|---|---|
| One warm refresh (cached read + 16 output tokens) | 0.10 |
| Refreshes per idle hour at pi's 270 s schedule | 13.3 → 1.33 CNY/h |
| Cost avoided when a warm prevents a miss | 1.5 − 0.1 = 1.40 |
| Break-even continuation probability per refresh | **7.1 %** (header OFF: 14.3 %) |
| Break-even idle length with a guaranteed resume | **≈ 1 h** (header OFF: ≈ 0.5 h) |

pi assumes `p = 0.15` when idle — about twice the break-even with the header on — so its default
policy is directionally right; only its absolute $0.05 gate (and our wrong prices) stand in the way.
Beyond ~1 h of idle, warming is net-negative even with a *certain* resume: 13 refreshes/h cost more
than the single miss they avoid. That confirms the previous note's conclusion with real numbers and
moves the boundary from "30–40 min" to "~1 h".

### 3.5 Latency is the real prize

Requests with a 150k–220k prompt, median wall time (previous request → this completion, output < 600
tokens):

| | median |
|---|---|
| Confirmed cache hits (Sep 28 – Oct 3, n = 742) | **17.0 s** |
| Sep 23–27 requests *reported* as full misses (n = 270) | 15.1 s ← see 3.6 |
| Genuine cold misses on other days (Sep 18/21/24/29, Oct 1/6, n = 20) | **57–151 s** |

A cold miss on a long session is a 1–2.5 minute stall. Across 646 misses that is roughly
8–10 hours of avoidable waiting; the money (928 CNY over 2.5 months) is the smaller half of the
argument.

### 3.6 The Sep 23–27 reporting blind spot

Per-day cached share of Cloud prompt tokens: 87–98 % up to Sep 22, then **57 % (Sep 23), 92 % (24),
19 % (25), 0 % (26), 3 % (27)**, then 92–98 % from Sep 28 on. Split by wire format, the collapse is
only on `openai-responses`; `anthropic-messages` requests on Sep 23 and 25 reported 99–100 % hits.

It was not a real cache failure:

- Latency of the "missed" 150k–220k requests (15.1 s median) matches confirmed hits (17.0 s) and is
  4–10× faster than genuine cold misses on neighbouring days.
- 621 consecutive requests over two days with 8–70 s gaps reporting *zero* cached tokens is not a
  plausible implicit-cache hit rate.

Most likely cause: with the session-cache header newly enabled (this extension's v1.4.6/v1.5.0, both
Sep 23) the endpoint reported hits only in `prompt_tokens_details` — the Responses doc still
describes that field as "returned when session cache is enabled" — while pi-ai reads only
`input_tokens_details`. The probe shows both fields populated today, so the endpoint side appears to
have changed. Not reproducible now; the lesson is the guard in option P1-F.

## 4. Options

Ordered by (value ÷ risk). "P0" items are correctness fixes that change no behaviour on the wire.

### P0-A — Fix `parseApiV1Prices()` (`extensions/alibaba.ts:747`)

Match exact type strings instead of `/input/i`, and make the tier/time-band policy explicit:

```ts
const EXACT = { input: "input_token", output: "output_token" } as const;
// keep the last row per exact type, prefer time_band "standard" | null, then "peak"
// return cache rows too: input_token_cache, input_token_cache_read,
//                      input_token_cache_creation_5m
```

Effect: `qwen3.8-max-0902` input 1 → 12 CNY/M (12× under-report today), 71 other models corrected
(2×–50×). Risk: every cost figure in pi/pi-debi moves, **in both directions** — for
`qwen3.8-max-0902` the input side rises 12× while the output side is unchanged in CNY and then falls
~7× under P0-C; for models the parser happened to read correctly (`qwen3.8-max`) everything falls by
the conversion. Announce it in the CHANGELOG, and land it together with P0-C and P1-E so the warming
gate does not flip unexpectedly (see §2.1).

Also decide the tier policy for the 43 tiered models: `prices[0]` (cheapest tier, current accidental
behaviour) vs the tier matching the model's typical prompt. pi has one price per model, so exact
per-request tiering needs a `streamSimple` wrapper (P3-M); until then the honest choice is the
**first tier + a `/alibaba → Status` note that long prompts bill higher**, or the highest tier if we
prefer over-reporting to under-reporting.

### P0-B — Declare `cost.cacheRead` / `cost.cacheWrite`

`buildCloudModels()` already knows `sessionCache` and the resolved `api`, so it can pick the right
row: `cacheRead = sessionCache && explicit ? input_token_cache_read : input_token_cache`,
`cacheWrite = explicit ? input_token_cache_creation_5m : input_token`. Effect: real cost totals,
real pi-debi waste metrics, and a correct `missCost`/`warmCost` in the warmer (it switches to the
`cacheWrite` branch, i.e. 125 % − 8.33 % instead of 100 % − 0 %). pi still cannot see *actual*
creation tokens (pi-ai reads a field DashScope does not send), so this is a price declaration, not a
usage fix — see P1-F.

### P0-C — Decide the currency story

pi's `cost.*` are USD per million (its warming gate is a $0.05 threshold). We feed it CNY. Options:
(1) convert with a configurable rate (`priceCurrency` / `cnyPerUsd` in `alibaba-config.json`,
default ≈ 7.1, surfaced in `/alibaba → Status`); (2) keep CNY-as-USD and document that all pi cost
figures for Cloud models are CNY. (1) is honest and makes pi's gate behave as designed — but then
idle warming needs prompts ≥ ~320k tokens to clear $0.05, which is why P1-E must land with it.

### P1-D — Buy dispatch margin: declare `promptCache.short = 240`

Refresh moves from 270 s to 216 s while the server-side TTL stays 300 s: margin grows from ~15 s to
~84 s, which is what the eight boundary failures in 3.1 needed. Cost: 16.7 refreshes/h instead of
13.3 (+25 % of the *cheap* side, ≈ 0.34 CNY/h per 100k prompt) to avoid a 1.4 CNY/100k full-price
rewrite. Expected-value positive at today's observed failure rate (6.8 %), and much better if prompt
sizes keep growing. Make it a config item (`/alibaba → Cloud — Warm margin: 300/270/240`) rather
than a constant, since the right value depends on prompt size.

### P1-E — `cache_warming_decision` policy handler

The hook is the only place where scenario knowledge exists. Minimal version, all state local to the
extension:

- `{action: "warm"}` while a pi-subagents child is known to be running or a resume is otherwise
  guaranteed (`p ≈ 1`, not 0.15) — this is the orchestrator case the previous note identified.
  Scope it to models whose measured break-even is below 0.15 (§2.1): `qwen3.8-*` yes, `glm-5.3` no;
- `{action: "stop"}` after N refreshes in one idle period (config, default ≈ 14 ≈ 1 h at 240 s) or
  when the extension's own per-day warming budget is exhausted;
- count refreshes per run (pi's event carries no counter), reset on `agent_start`/`turn_start`.

Note the hard limit: the hook fires only while pi's own run is alive, so it **cannot** push past the
30-min idle / 60-min streaming caps — that is P3-M.

### P1-F — Cache telemetry from the provider's own fields

A `provider_stream_event` handler (debug-gated, off by default) that records, per response:
`input_tokens_details.cached_tokens`, `x_details[].prompt_tokens_details.{cached_tokens,
cache_creation_input_tokens, cache_type}`, and the wire format. That gives (a) true write counts pi
cannot see, (b) an immediate alarm if the Sep 23–27 blind spot returns (compare `cached_tokens`
against the latency-implied hit), (c) the data to decide P1-D and P1-E instead of guessing. Optionally
propose the mapping upstream: pi-ai should fall back to
`x_details[0].prompt_tokens_details.cache_creation_input_tokens` for `usage.cacheWrite`.

### P2-G — Prefix-stability rules (biggest single bucket: 38 % of miss spend)

Documented, and partly enforced by us already:

- Tool definitions are serialized into the system message; any change (order, optional field,
  description text) invalidates everything. This extension's codemode exposure (2.0.0) is a cache
  win for exactly that reason — two tools stop being declared every turn.
- Our own `before_agent_start` section is static (no timestamps, no counters) — keep it that way;
  any volatile string in any section costs a full miss per turn.
- pi-debi side: role/persona swaps, `ops-mode` switches and skill-list changes rewrite the system
  prompt. Prefer switching at a moment when the cache is already dead (P2-H).

### P2-H — Time rewrites to a dead cache

Compaction, context edits and persona switches invalidate the whole prefix, so their marginal cost
is zero right after a ≥ 5 min idle and maximal during an active run. 49 provable rewrite misses cost
78 CNY; a "compact on resume" habit (or a pi-debi rule) recovers most of it. Same trick for image
re-encoding and any history normalization.

### P2-I — Child/fork prefix alignment (experiment first)

The cache is prefix-scoped (C10), so a subagent whose system prompt + tool block + transcript prefix
is byte-identical to its parent's can inherit the parent's cache block instead of paying a cold
create. Observed: 47 of 51 "first big request of a session" cases were cold on Responses (~32k
tokens each for the pi-subagents children of Oct 2), while the 4 Anthropic-format ones hit. Before
building anything, run the experiment: launch two children, one with the parent's exact system
prompt and tools, one with a modified section, and compare `cached_tokens` on their first request.
If it holds, the rule belongs in pi-subagents' fork path, not here.

### P2-J — Model guidance for cache-heavy long sessions

Read-price spread at equal prompt size: `qwen3.8-*` 8.33 % (explicit) / 12.5 % (implicit),
`deepseek-v4.1-flash` 10 %, `kimi-k3` 10 %, `glm-5.3` **25 % and no explicit support** (the session
header is a no-op there). For multi-hour orchestrator sessions the qwen3.8 family is the cheap
place to sit; `glm-5.3` pays 2–3× more per cached turn. Worth a line in the README's model section
and in `/alibaba → Status`.

### P2-K — Adaptive session-cache header (implicit can outlive explicit)

The header is a static model property today (`buildCloudModels()`), so every request pays explicit
cache pricing. But the two stores age differently: the explicit block is *certainly* dead after
5 min (C5), while an implicit block was still hitting after 25 min (C6). So on the first request
after a long gap, `enable` guarantees a 125 % rewrite where `disable` costs at most 100 % and
sometimes 12.5 %.

`before_provider_headers` mutates headers in place per request, so the switch needs no
re-registration — only a "when was the last provider request" timestamp (`message_end` /
`turn_start`).

Arithmetic per 1M prompt tokens on `qwen3.8-max-0902`, for a burst of N turns following a long gap:

| | first request after the gap | each of the N following turns | total |
|---|---|---|---|
| header ON | 15 | 1 | 15 + N |
| header OFF, implicit dead | 12 | 1.5 | 12 + 1.5 N |
| header OFF, implicit alive | 1.5 | 1.5 | 1.5 + 1.5 N |

ON wins when N > 6 (N > 27 if the implicit block survived). Agent runs routinely have N ≫ 6, so the
current always-ON default is right for them — and telemetry agrees (43 hits per miss). Human chat
with a few turns per burst is the case where OFF is cheaper.

Caveats: the modes are exclusive per request, so a burst that starts OFF and flips ON pays creation
again — the policy must not oscillate inside a burst; and "implicit survives 25 min" is one data
point, which is what the §6 experiment is for. Land it behind a config item
(`/alibaba → Cloud — Session Cache: On / Off / Auto`) and measure with option P1-F before trusting
it.

### P2-L — Guard the Responses 80 % truncation

The endpoint truncates silently above ≈ 800k input tokens on a 1M-context model. Cheapest fix:
register `contextWindow: 800_000` for Cloud models on the `openai-responses` format (or warn in
`/alibaba → Status` when a session crosses it). This is a correctness issue adjacent to caching —
a truncated tail also destroys the prefix match for every later turn.

### P3-M — Extension-owned warmer (only with a known resume)

Registering a complete `Provider` with our own `streamSimple` that delegates to pi-ai's
implementation would let us (a) replay the last request on our own schedule past pi's 30-min cap,
(b) apply per-request tier pricing, (c) map `cache_creation_input_tokens` into `usage.cacheWrite`.
Arithmetic says (a) is worth it only when the resume is *known* (an orchestrator waiting on children)
and the wait is under ~1 h; beyond that accept the miss. (b) and (c) are the real reasons to
consider it. Cost: we take ownership of streaming behaviour pi documents as "safer to delegate";
risk of double-warming unless `cacheWarming` is set to `streaming` and the extension owns idle.

### P3-N — `cache_control` markers on the Cloud Completions format

`before_provider_request` may replace the payload, so the extension could inject up to four
`cache_control: {"type":"ephemeral"}` markers for models re-routed to `openai-completions`
(non-`responsesCapable` families), turning probabilistic implicit hits (12.5–25 % reads) into
deterministic explicit ones (8.33–10 %). Probe C8/C9 confirm the format accepts markers and returns
exact `cache_creation_input_tokens` / `cached_tokens`. Constraints from the docs: ≤ 4 markers (if
more, **the last four win**), a 20-content-block backward window from each marker, tools serialized
into the system message, and parallel tool results should be merged into one message. Deferred: with
Responses as the default format the affected models are a minority, and getting the marker placement
wrong makes caching worse, not better.

### P3-O — Server-side context (`previous_response_id` / `conversation`) and PTU

7-day server-side context would remove the upload and most of the latency of long sessions, but pi
sends `store: false` and rebuilds context every turn (compaction, branching, context edits), so it
is an upstream conversation, not an extension change. PTU (预置吞吐) supports context cache with
discount coefficients and changes the economics entirely for this volume — worth a look if monthly
Cloud spend keeps growing.

## 5. Corrections to `2026-10-07-dashscope-cache-ttl-and-warming.md`

| Previous note | Corrected |
|---|---|
| qwen3.8 hit price "console-TBD", assumed 10 % explicit / 20 % implicit | 8.33 % explicit-session (1 CNY/M) / 12.5 % implicit (1.5 CNY/M), live catalog |
| "measured rate $1.04/M input, ~120k prompt" | pi's own cost math over the mis-parsed rows; the real list price of `qwen3.8-max-0902` is 12 CNY/M ≈ $1.69/M and the parser registers 1 |
| Full miss ≈ $0.125, warm ≈ $0.0125, ~15 refreshes ≈ $0.19/h | Per 100k prompt: miss 1.5 CNY (header ON) / 1.2 (OFF); warm 0.10 / 0.15; 13.3 refreshes/h = 1.33 / 2.0 CNY |
| Break-even "pauses up to ~30–40 min" | ≈ 1 h with the header ON, ≈ 0.5 h with it OFF; break-even resume probability 7.1 % / 14.3 % |
| Session cache "reads ~10 % vs implicit 20–25 %; OFF if ≥1 miss per 2 hits" | qwen3.8: 8.33 % vs 12.5 %, OFF only below 6 hits per miss. For `glm-5.3`/`kimi-k3`/`deepseek-v4.x` the header is a no-op (no explicit support) |
| "Warming works out of the box once enabled" | It runs (146 warms), but the idle gate needs P ≈ 333k tokens with today's declarations, and 10 warms paid full price. Also capped at 30 min idle / 60 min streaming |
| Verification item 3 (session-cache header on warms) | Answered from source: `model.headers` is applied to every request incl. warm replays |

## 6. Verification plan

1. **P0-A/B/C (prices)**: `/alibaba → Status` shows the parsed price table; `pi --list-models`
   cost for `qwen3.8-max-0902` reads 12/36/1/15 (÷ rate if P0-C converts). `/session` cost for one
   known turn matches the Bailian console bill.
2. **P1-D (warm margin)**: watch `cache_warm` entries — failed warms (`cacheRead = 0`) should drop to
   ~0 while the warm count per idle hour rises ~25 %.
3. **P1-E (policy)**: `/session` must show `extension override` on a forced warm; the refresh counter
   resets on the next real request.
4. **P1-F (telemetry)**: one debug-enabled run produces a per-response line with
   `cached`/`creation`/`cache_type`; `creation > 0` on the first request after an idle proves the
   125 % write that pi cannot see.
5. **P2-I**: two children, identical vs modified prefix — compare first-request `cached_tokens`.
6. **P2-K (implicit TTL)**: one fixed ~4k-token prefix, header `disable`, re-sent after 6 / 10 / 20 /
   40 / 60 min of idle (5 requests per hour of waiting, ~0.05 CNY). The result is the survival curve
   that decides whether `Auto` is worth building: if implicit blocks routinely survive 20–60 min,
   gap-heavy sessions should stop paying the 125 % rewrite; if they die at ~5 min like explicit ones,
   C6 was a fluke and the header stays always-on.

## 7. What 2.1.0 implemented

Decisions and live verification: [`docs/specs/2.1.0-cache-warming-and-prices.md`](../specs/2.1.0-cache-warming-and-prices.md).

| Option | Status | Where |
|---|---|---|
| P0-A exact price rows, tiers, time bands | **implemented** | `extensions/prices.ts` (`parseCatalogPrices`, `pickPriceRange`, `parseRangeTokens`) |
| P0-B declare `cacheRead`/`cacheWrite` | **implemented** | `prices.ts` `declareCacheCost` + `alibaba.ts` `explicitCacheActive` |
| P0-C currency | **implemented**, default `cny` | `prices.ts` `convertCost`, config `costCurrency`/`cnyPerUsd`, Status states the unit |
| P1-D refresh margin | **implemented** as a setting (216 s default, 60–270) | `cache-warm.ts` `resolveWarmSettings`; in `pi` mode via `declaredCacheTtlSeconds` |
| P1-E warming policy | **implemented** | `cache-warm.ts` `warmingDecisionOverride` + the `cache_warming_decision` handler |
| P1-F cache telemetry | **implemented** | `cache-warm.ts` `cacheFieldsFromStreamEvent`, `appendCacheLog`, `alibaba-cache.jsonl` |
| P2-G prefix stability | documented (review rule) | README, `docs/TODO.md` |
| P2-H rewrite timing | documented (habit / pi-debi) | README, `docs/TODO.md` |
| P2-I child prefix alignment | deferred upstream | `docs/TODO.md` (experiment now cheap: telemetry reports creation vs cached) |
| P2-J model guidance | **implemented** | `/alibaba → Status` `Model:` line (`formatCacheEconomics`) + README |
| P2-K adaptive header | **decided against "Auto"** | `docs/TODO.md`; stays `on`/`off` |
| P2-L Responses 80 % guard | **implemented** (default on) | `alibaba.ts` `RESPONSES_INPUT_FRACTION`, config `responsesInputGuard` |
| P3-M extension-owned warmer | **implemented**, and it is now the default engine | `extensions/cache-warm.ts` (`createCacheWarmer`, `planWarm`) |
| P3-N `cache_control` on Completions | **implemented** (default on, gated on catalog rows) | `extensions/cache-control.ts` |
| P3-O server-side context / PTU | deferred (upstream / purchasing) | `docs/TODO.md` |

§6 items 1–4 were verified live on 2026-10-07 against the bound Beijing workspace domain; items 5
and 6 (child prefix alignment, implicit-TTL curve) remain open and are on the `docs/TODO.md` watch
list. Two differences from the plan as written:

- The engine does **not** register a custom `Provider`. `before_provider_request` +
  `before_provider_headers` already hand over the exact payload and the resolved headers, so a plain
  `fetch` replay is byte-identical without taking ownership of streaming, and per-request tier pricing
  turned out to be unnecessary once the tier is a declared estimate.
- `promptCache` became the engine switch rather than a margin knob: declaring nothing is how Cloud
  models opt out of pi's warmer, which is what keeps one engine per block. P1-D's margin is now our
  own `refreshSeconds`.

## Sources

Provider (primary):
- Live `GET https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/models?capabilities=TG`
  (154 models, 2026-10-07) — prices, tiers, time bands, cache rows.
- Probe requests to `/compatible-mode/v1/responses` and `/compatible-mode/v1/chat/completions`
  (script + raw JSONL referenced above).
- help.aliyun.com/zh/model-studio/context-cache (rev. 2026-10-03) — modes, TTL, 20-block window,
  ≤4 markers ("最后四个生效"), tools-in-system-message, parallel tool-result merging, per-model
  cached-token rates, explicit/implicit mutual exclusion, PTU note.
- alibabacloud.com/help/en/model-studio/qwen-api-via-openai-responses (rev. 2026-09-23) —
  `x-dashscope-session-cache`, `previous_response_id` (7 days), `conversation`, `store` default
  true, `usage.x_details[].prompt_tokens_details`, **80 % input limit with silent truncation**,
  "only parameters listed here are processed".
- help.aliyun.com/zh/model-studio/qwen3-8-max and /model-pricing — price tables, tier semantics
  ("该请求的所有 Token 均按对应阶梯的单价结算"), Batch 50 % (not combinable with cache discounts).

Host (primary, installed build):
- pi 1.0.4 `dist/core/cache-warmer.js` (all constants and the decision formula),
  `dist/core/cache-warmer.d.ts` (event/status shapes), `dist/core/sdk.js:181,214,259`
  (construction, `before_provider_request` payload replacement, start at dispatch),
  `dist/core/extensions/types.d.ts:672-685` (`before_provider_request`, `before_provider_headers`).
- pi-ai `dist/api/openai-responses.js:17,192,243-246` (16-token floor, `model.headers`,
  `prompt_cache_key`, `store:false`), `dist/api/openai-responses-shared.js:441-452` (usage mapping),
  `dist/api/anthropic-messages.js:31-39,1176-1282` (`cache_control` injection, 1h only with
  `supportsLongCacheRetention`).
- pi docs: `settings.md#cache-warming`, `models.md#prompt-cache-lifetimes`,
  `extensions.md#cache_warming_decision`, `custom-provider.md` (reuse vs custom streaming).

Local:
- `~/.pi/agent/sessions/**/*.jsonl` (2026-06-15 → 2026-10-07): 146 `cache_warm` usage entries,
  646 cold misses ≥ 20k tokens, per-day/per-format hit rates, wall-time distributions.
- `~/.pi/agent/alibaba-models.cache.json` (snapshot 2026-10-07T02:49Z) vs the live catalog —
  the 72-model price divergence.
- `~/.pi/agent/settings.json`: `cacheWarming: "idle"`, `showCacheMissNotices: true`,
  `defaultModel: qwen3.8-max-0902`.
- `~/.pi-debi/pi-debi.log` (turn-metrics miss↔idle correlation).
