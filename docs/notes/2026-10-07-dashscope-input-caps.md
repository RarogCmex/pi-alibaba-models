# DashScope input and output caps, measured per model (2026-10-07)

Question: what does the endpoint **actually** accept, per model and per wire shape — and is the
catalog's `context_window` (which is what this extension used to declare) the right number?

Answer: no. There are three separate limits, none of them equal to the context window, and only one of
them is derivable from the catalog.

| Limit | Shape | Behaviour above it | Discoverable from the catalog? |
|---|---|---|---|
| request cap | Chat Completions, Anthropic | `400 Range of input length should be [1, N]` | no — it matches a different field per model |
| Responses cap | Responses | **silent truncation**: keeps head and tail, drops the middle | no — the doc's "≈80 %" is wrong for a whole generation |
| output cap | all | `400 Range of max_tokens should be [1, N]` when thinking is on | partly: `reasoning_max_output_tokens` |

Method (three probes, all committed next to this note):

1. **Request cap — free.** An oversized request is rejected *before* billing and the 400 text quotes
   the exact range. One request per model, ~4 s each, zero cost.
   [`-input-caps-probe.py`](2026-10-07-dashscope-input-caps-probe.py)
2. **Responses cap — one truncated request per model.** The endpoint does not reject; it reports the
   truncated size in `usage.input_tokens`, so sending ~1.15 × the window and reading that number
   *is* the measurement. Cost is the truncated input, i.e. cap × input price (0.02–10 CNY per model
   depending on the family). Marker experiment for the truncation *shape*:
   [`-responses-truncation-probe.py`](2026-10-07-dashscope-responses-truncation-probe.py)
3. **Output cap — free.** Send `max_tokens` above the advertised value with thinking on and read the
   range out of the 400.

Payload text is real content (this repo, pi's docs, session logs), not synthesized filler.

## 1. Request caps (Completions and Anthropic — measured identical on both)

`sent` is ~1.15 × the catalog window; `cap` is the number quoted by the 400.

| Model | ctx | `max_input` | `reasoning_max_input` | **measured cap** | cap equals |
|---|---|---|---|---|---|
| qwen3.8-max-0902 | 1 000 000 | 991 808 | 983 616 | **983 616** | reasoning_max_input |
| qwen3.8-flash | 1 000 000 | 991 808 | 983 616 | **983 616** | reasoning_max_input |
| qwen3.7-plus | 1 000 000 | 991 808 | 983 616 | **983 616** | reasoning_max_input |
| qwen-plus | 1 000 000 | 997 952 | 995 904 | **1 000 000** | ctx (above both!) |
| qwen3-max | 262 144 | 258 048 | 258 048 | **258 048** | both |
| qwen3.5-35b-a3b | 262 144 | 260 096 | 258 048 | **258 048** | reasoning_max_input |
| qwen3-30b-a3b | 131 072 | 98 304 | — | **98 304** | max_input |
| glm-5.3 | 1 000 000 | 1 048 576 | 1 048 576 | **1 048 576** | above ctx |
| glm-5.1 | 202 745 | 202 745 | 169 984 | **202 745** | ctx (not reasoning_max_input) |
| glm-4.6 | 202 752 | — | — | **169 984** | neither |
| kimi-k3 | 1 000 000 | 1 048 576 | 1 048 576 | **1 048 576** | above ctx |
| kimi-k2.6 | 262 144 | 229 376 | — | **262 144** | ctx (not max_input) |
| deepseek-v4.1-flash | 1 000 000 | 1 000 000 | 1 000 000 | **1 000 000** | all three |
| deepseek-v3.2 | 131 072 | 98 304 | — | **131 072** | ctx (not max_input) |
| MiniMax-M2.1 | 204 800 | 172 032 | — | **172 032** | max_input |

Anthropic shape verified separately on `deepseek-v3.2` (131 072), `MiniMax-M2.1` (172 032),
`glm-4.6` (169 984) and `qwen3-30b-a3b` (98 304) — the same numbers, and its error arrives as
`{"code":"InvalidParameter","message":"Range of input length should be [1, N]"}` rather than the
OpenAI-shaped envelope.

**No single catalog field predicts the cap.** `min(ctx, max_input, reasoning_max_input)` is *never
above* the measurement (so it is safe as a fallback) but understates it by 25 % on `deepseek-v3.2`,
16 % on `glm-5.1` and 12.5 % on `kimi-k2.6` — which is why the measured table exists and the
derivation is only a fallback.

## 2. Responses caps (silent truncation)

| Model | ctx | request cap | **measured Responses cap** | share of window |
|---|---|---|---|---|
| qwen3.8-flash | 1 000 000 | 983 616 | **800 056** | 80.0 % |
| qwen3.8-max-0902 | 1 000 000 | 983 616 | **792 945** | 79.3 % |
| qwen3.7-plus | 1 000 000 | 983 616 | **792 907** | 79.3 % |
| qwen3.7-flash | 1 000 000 | 983 616 | **792 907** | 79.3 % |
| qwen3.6-flash | 1 000 000 | 983 616 | **792 907** | 79.3 % |
| deepseek-v4.1-flash | 1 000 000 | 1 000 000 | **754 977** | 75.5 % |
| qwen3.5-flash | 1 000 000 | 983 616 | **89 127** | **8.9 %** |
| qwen3.5-35b-a3b | 262 144 | 258 048 | **~90 000** | **34.3 %** |

The documented rule ("approximately 80 % of the model's context window") holds for qwen3.6/3.7/3.8 and
roughly for deepseek-v4 (75.5 %). It is **wildly wrong for the qwen3.5 generation**, which sits on a
flat ~90 000-token budget regardless of a 1 M window — two models measured, 89 127 and 90 000/90 004/
90 006 across repeated runs. `qwen3.5-27b` returned HTTP 200 with `input_tokens: 0` (the shape
DashScope uses for a backend failure), so it is unmeasured and takes the generation rule.

### Truncation keeps head and tail, and drops the middle

`qwen3.5-35b-a3b`, unique (non-repetitive) lines, three markers — head, middle, tail — and a question
asking which markers are visible:

| sent (Completions count) | Responses `input_tokens` | markers the model could see |
|---|---|---|
| 80 524 | 80 560 | head, middle, tail |
| 160 835 | 90 006 | head, tail — **middle gone** |
| 240 858 | 90 000 | head, tail — **middle gone** |
| >258 048 | 90 004 | head, tail (Completions 400'd on the same text) |

So an over-budget Responses request does not fail and does not lose the newest messages: it **hollows
out the conversation** and answers confidently. Two consequences: the model silently reasons over a
transcript with a hole in it, and the cached prefix is destroyed, so every following turn is cold.
This is the strongest argument for declaring the cap on the card and letting pi compact instead.

## 3. Output caps

| Model | `max_output` | `reasoning_max_output` | `max_tokens` with thinking on |
|---|---|---|---|
| qwen3-max (+ `-2026-01-23`, `-preview`) | 65 536 | 32 768 | 65 536 → **400 `Range of max_tokens should be [1, 32768]`**; 32 768 → OK |
| qwen3.8-max-0902 | 131 072 | 131 072 | 131 072 → OK; 131 073 → 400 |

Only the three `qwen3-max` cards differ, and before this measurement they declared 65 536 — a hard
400 on every turn with thinking on. A card cannot express "unless the level is off", so the lower
ceiling is declared.

## What the extension does with this

`extensions/model-limits.ts`:

- `MEASURED_INPUT_CAPS` — the tables above, per model, dated, with the probe to re-measure.
- Request cap fallback for unmeasured models: `min(ctx, max_input, reasoning_max_input)` — never
  above a measurement in the sample, so it errs toward compacting early rather than toward a 400.
- Responses cap fallback: `0.78 × min(requestCap, ctx)` (measured caps land at 79.3–80.0 %, so this
  keeps a margin), except `^qwen3.5-` which takes the flat 90 000 and `^deepseek-v4` which takes
  0.755 — both measured.
- `resolveContextWindow()` returns the number **and its source** (`measured` / `derived` / `override` /
  `catalog`), which `/alibaba → Status` prints, so an unmeasured model is visibly a guess.
- Measurements propagate through the catalog's own `equivalent_snapshot` links (both directions), so
  a dated snapshot inherits its alias's measurement instead of falling back to a derived cap:
  `qwen3.7-plus-2026-05-26` declares 792 907 like `qwen3.7-plus`, not 767 220.
- For the qwen3.7/3.8 generations the derived request cap happens to be **exact** — `min(ctx,
  max_input, reasoning_max_input)` = 983 616, the measured value — and the derived Responses cap is
  767 220 against measured 792 907–800 056, i.e. 3–4 % conservative: compaction comes slightly
  early, truncation never does.
- `resolveOutputCap()` folds `reasoning_max_output_tokens` into the declared `maxTokens`.
- A `Context Window — Override` still wins outright, and `responsesInputGuard: false` re-declares the
  full window for users who would rather see the catalog number.

Open items: the caps are per-deployment and can drift; nothing re-measures them at runtime. The cheap
version of self-healing is to parse `Range of input length should be [1, N]` from a 400 and persist N
(the same trick this note uses), which is on `docs/TODO.md`.

## Sources

- Probes: [`-input-caps-probe.py`](2026-10-07-dashscope-input-caps-probe.py) (request caps + Responses
  saturation, raw lines in [`-input-caps-results.jsonl`](2026-10-07-dashscope-input-caps-results.jsonl)),
  [`-responses-truncation-probe.py`](2026-10-07-dashscope-responses-truncation-probe.py) (markers),
  plus the `max_tokens` range probe inlined in §3. Run against
  `llm-….cn-beijing.maas.aliyuncs.com` with the bound Cloud key; total spend ≈ 25 CNY, almost all of
  it the four 1 M-window Responses measurements.
- `GET /api/v1/models?capabilities=TG` — `model_info.{context_window,max_input_tokens,
  reasoning_max_input_tokens,max_output_tokens,reasoning_max_output_tokens}` for all 154 models.
- alibabacloud.com/help/en/model-studio/qwen-api-via-openai-responses (rev. 2026-09-23) — the
  "approximately 80 % … automatically truncated without raising an error" statement, and the list of
  models the Responses endpoint fully supports.
