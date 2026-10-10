# Cache warming: blind replays, and statistics that hid them (2026-10-11)

Trigger: «прогревы кэша, которые добавляли в 2.1.0, иногда не работают» plus a pointer at
`pi --session 01a126a9-517e-7442-8502-3b870f33864d`. Everything below is measured from
`~/.pi/agent/alibaba-cache.jsonl` (4 021 records, 2026-10-07T06:57Z → 2026-10-10T22:21Z),
from the session files under `~/.pi/agent/sessions/`, and from live probes against
`llm-9e7vq8x8m7v8ofw3.cn-beijing.maas.aliyuncs.com` on 2026-10-11.

## 1. The session that was pointed at has no Cloud turns in it

`01a126a9` (cwd `~/pi-plugins/pi-reformboss-internal`, 16:33:13Z → 21:17:57Z, 4.75 h) ran
135 turns on `nvidia`, 19 on `reformboss`, 1 on `xiaomi-token-plan-ams`. It switched away from
`alibaba-cloud/qwen3.8-max-0902` 46 s after starting and never made a Cloud request, so it has
no warm statistics of its own. What its *window* does contain is 755 Cloud records written by
four other pi processes running at the same time:

| Session | cwd | Cloud model | Started |
|---|---|---|---|
| `01a126d2` | `~/pi-plugins/pi-nvidia-plus` | qwen3.8-max-0902 | 17:18:27Z |
| `01a126d6-66a8` | `~/pi-evals/xapi-1` | qwen3.8-max-0902 | 17:22:27Z |
| `01a126d6-fe37` | `~/pi-evals/xapi-1` | qwen3.8-max-0902 | 17:23:06Z |
| `01a126f8` | `~/pi-plugins/pi-alibaba-models` | qwen3.8-max-0902 | 18:00:12Z |
| (unnamed) | `~/freedom4/escape-bot-wt-prior-art` | qwen3.8-max-0902 | 20:49:15Z |

Records carry no session or context identity, so attributing a miss meant reconstructing
contexts by prompt size and timestamp. That is now recorded (`ctx`, §5).

## 2. Whole-log picture: warming works, one model excepted

| Model | Turns | Turn miss % | Median turn `cached/prompt` | Warms | Hits | Rewrites | Failed | **Blind** |
|---|---|---|---|---|---|---|---|---|
| qwen3.8-max-0902 | 2 539 | 4.5 % | 0.990 | 1 107 | 1 081 (97.7 %) | 12 | 14 | **0** |
| glm-5.3 | 138 | 0.7 % | 0.997 | 31 | 31 (100 %) | 0 | 0 | **0** |
| deepseek-v4.1-flash | 174 | 4.6 % | 0.994 | 31 | 2 (6.5 %) | 0 | 0 | **29** |
| qwen3.8-flash | 1 | — | — | 0 | — | — | — | — |

"Blind" = the provider answered 200 and reported neither a hit worth the name nor any creation
tokens, i.e. nothing says the block is alive for the next turn. The 29 blind deepseek probes re-sent
**10.46 M tokens** that the cache did not serve. The separation is total, which is what makes a
threshold safe:

- every real hit on qwen3.8-max-0902 (1 081, minimum 99.99 % of the prompt) and glm-5.3
  (31, minimum 99.98 %) covered essentially the whole prefix;
- the deepseek probes that reported anything reported **0–1.09 %** (0, 1 024, 2 048 or 4 096
  tokens of 149 794–376 453) — nothing, or the first block to four, with the rest re-prefilled.

`BLIND_HIT_FRACTION = 0.05` sits in the empty band between.

The qwen turn misses are not warming failures: the 3 misses in the one attributable session
(`01a126f8`, 122 turns, 119 hits) were the first turn of the session and the two turns
immediately after a compaction (19:09:43Z, 22:19:10Z) — a rewritten prefix has nothing to hit,
which is why `session_before_compact` invalidates the template. The rest of the window's misses
were contexts under the 20 000-token floor (4 096 / 6 232 / 11 134 / 12 751 / 17 032 / 18 752
tokens), i.e. the documented "cold start costs seconds, not a minute" case.

## 3. The failure: 27 replays of a dead block, and no real request waiting for it

`deepseek-v4.1-flash`, one context of **376 453 tokens**, last real turn 18:05:27Z on
2026-10-09 — and no Cloud turn for that model ever followed it. The engine then replayed the
context every 216 s from 18:12:39Z to 19:46:15Z: **27 probes, 1 h 34 m, 10.15 M tokens the cache
did not serve, 889 s of provider compute**.

```
18:05:27 turn pt=376453 cached=374784 (99.6 %)   ← the last real request
18:09:03 warm pt=376453 cached=375424 ms=13887 ← the last hit
18:12:39 warm pt=376453 cached=     0 ms=26952
18:16:15 warm pt=376453 cached=     0 ms=42467
18:19:51 warm pt=376453 cached=  1024 ms=31624
…  (216 s apart, 27 probes, cached ∈ {0, 1 024, 2 048, 4 096}, 22–50 s each)
19:46:15 warm pt=376453 cached=     0 ms=30425
```

Two earlier probes on the same model behaved the same way at 149 794 and 153 353 tokens
(17:02:26Z `cached: 1 024`, 17:08:33Z `cached: 0`), and there the next real turn missed too
(17:11:02Z, `cached: 0`) — so the replay had not left anything behind.

`MAX_WARM_FAILURES` never fired because nothing failed: every probe was HTTP 200. The engine
counted hits and rewrites, and a probe that was neither simply went uncounted.

## 4. Why the statistics looked fine

- `summarizeCacheLog()` classified every hit-less successful probe as a **rewrite**
  (`else s.warmRewrites++`), a word that claims the probe re-created an expired block. A rewrite
  is only *known* when the provider reports creation tokens — DashScope often does not
  (`x_details[].prompt_tokens_details.cache_creation_input_tokens` was absent on every blind
  probe). So `/alibaba → Cache statistics` reported 27 useless probes as 27 successes.
- The engine's own counters (`hits`, `rewrites`, `failures`) left them invisible: the panel read
  `31 warms: 2 hits, 0 late, 0 failed`, with 27 unaccounted for.

## 5. What changed (2.1.3)

| Change | Where |
|---|---|
| A replay that reports neither a hit ≥ 5 % of the prompt nor a creation is **blind**; `MAX_BLIND_WARMS = 3` in a row end the run until the next real request | `isBlindWarm()`, `planWarm()`, engine |
| Blind probes are counted and named separately from rewrites, in the roll-up and on both panels | `CacheSummary.warmBlind`, `cacheStatusLines()`, `cacheWarmMenu()` |
| Every record carries `ctx`: a sha1/8 of the cached prefix head (`instructions`/`system`, first two messages, tool names), so a miss can be attributed to a context | `contextId()`, `CacheLogRecord.ctx` |
| A prompt size reported by a *different* context no longer lowers the estimate — a child agent's 4 k turn used to be able to push a 150 k context under `minPromptTokens` and stop its warming | `notePromptTokens(n, ctx)` |
| The host-floor error reads its own version from the manifest instead of hardcoding it (it said 2.1.1 while the package was 2.1.2) | `SELF_VERSION` |

The guard is measured to be silent where warming works: replayed over the whole log it would
have fired only on deepseek-v4.1-flash, and there it would have cut that chain from 27 probes
to 3.

## 6. Live probes, 2026-10-11: neither the replay shape nor the size is the problem

Same payload sent four times per model — one streaming (the shape of a real turn), then three
warm-shaped (`stream: false`, `max_output_tokens: 16`) at 330 s / 216 s / 216 s, unique nonce per
model so nothing could ride an earlier block:

| Model | Prompt tokens | A (stream) | B (+330 s) | C (+216 s) | D (+216 s) |
|---|---|---|---|---|---|
| deepseek-v4.1-flash | 6 350 | 200, 2.1 s | `incomplete`, cached 6 144, 2.5 s | cached 6 144, 2.5 s | cached 6 144, 2.3 s |
| deepseek-v4.1-flash | **356 560** | 200, 12.2 s | `completed`, cached 356 352, 11.8 s | cached 356 352, 11.6 s | cached 356 352, 12.6 s |
| qwen3.8-max-0902 | 7 378 | 200, 2.7 s | `incomplete`, cached 7 168, 2.8 s | cached 7 168, 3.4 s | cached 7 168, 3.4 s |

Three things follow, all of them against the obvious explanations:

- **The parser was never blind.** Every warm-shaped response carries
  `usage.input_tokens_details.cached_tokens`, and `x_details[0].prompt_tokens_details` was there
  too (without `cache_creation_input_tokens`, which is why a re-creation is unreportable).
- **The 16-token cap is harmless.** It makes reasoning models answer `status: "incomplete"`
  (sometimes `completed`), and the block is cached and renewed anyway — D hit 13.6 min after the
  only real request.
- **Size is not the trigger.** The 356 560-token deepseek context — within 5 % of the 376 453 that
  went blind in production, on the same model, same endpoint, same replay shape — renewed twice,
  at 11.6–12.6 s per probe. The blind probes of 2026-10-09 took 22–50 s each: those were cold
  prefills, these are hits.

## 7. Open: what made that one context unwarmable

With shape and size excluded by §6, what remains is a transient provider-side condition on
2026-10-09 — the block went away between 18:09:03Z and 18:12:39Z and 26 replays could not bring
it back, while a real turn two hours earlier had held it at 99.6 %. Candidates, none established:

- **Cache mode.** `deepseek-v4.1-flash` and `glm-5.3` have no explicit-cache rows in the catalog,
  so they run on implicit caching, which the provider documents as probabilistic with no published
  TTL; `qwen3.8-max-0902` uses the session cache (deterministic, 300 s, reset on hit). But
  `glm-5.3` renewed **31 of 31** probes at 265 259 tokens over hours, and deepseek renewed at
  356 560 in the live probe — so implicit caching is a risk factor, not a verdict.
- **Eviction or routing.** A 376k block may be evicted first under pressure, or a non-streaming
  replay may land on an instance that never held it. Not observable from outside.
- **The one measurable consequence:** at 17:08:33Z a blind probe was followed by a real turn that
  also missed (17:11:02Z, `cached: 0`), so a blind replay really does leave nothing behind — it is
  not a reporting artefact of a block that got renewed quietly.

This is why the fix is a streak counter and not a per-model blocklist: the condition is transient
and unattributable, so the engine can only stop paying for what it can observe is not working, and
let the next real request — which does re-create the block — start a fresh run.

## 8. Deliberately unchanged

- **Horizon stays 240 min.** Idle periods that ended with a returning turn, across the log:
  16 in 5–15 min, 9 in 15–30 min, 2 in 30–60 min, 1 in 1–2 h, 4 in 2–4 h, 6 over 4 h (biased
  low — interleaved processes shorten apparent gaps). Cutting the horizon to 60 min would abandon
  ~29 % of real returns. The workspace key is not token-metered (catalog `cost` rows are 0), so
  the cost of a probe is quota and provider compute, not money; one probe did hit `HTTP 429`
  (2026-10-08T22:39Z), which is the real contention to watch.
- **`minPromptTokens` stays 20 000.** The sub-floor misses above are the documented trade.
- **One template per process.** Warming several contexts of one process (parent + child agents)
  needs per-context slots; before building that, the new `ctx` field should show whether one
  process really does serve several Cloud contexts — see `docs/TODO.md`.

## 9. Reproducing

```bash
# Per-model roll-up, blind probes, streaks:
node -e 'const fs=require("fs");const L=fs.readFileSync(process.env.HOME+"/.pi/agent/alibaba-cache.jsonl","utf8").trim().split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const blind=e=>e.kind==="warm"&&e.ok&&!(e.creation>0)&&(!e.cached||e.cached/e.promptTokens<0.05);
for(const m of [...new Set(L.map(e=>e.model))]){const W=L.filter(e=>e.model===m&&e.kind==="warm"&&e.ok);
console.log(m,"warms",W.length,"blind",W.filter(blind).length);}'

# The chain itself:
grep '"model":"deepseek-v4.1-flash"' ~/.pi/agent/alibaba-cache.jsonl | grep '"kind":"warm"'
```
