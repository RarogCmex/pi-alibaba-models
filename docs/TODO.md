# TODO — deferred frontier work

Recorded 2026-10-03 alongside the 2.0.0 release (`docs/specs/2.0.0-pi-1.0-frontier.md`).
Each item states what it is, why it is deferred, and what would unblock it.

## Classifier models on the Cloud provider

**What.** pi 1.0.0 has a first-class `classifier` model type (`ProviderClassifierModelConfig`,
`ctx.modelRegistry.classify()`, `models.classify()` in codemode). DashScope's compatible-mode
chat completions can return `logprobs`, which is enough to build a real classifier implementation
(`{ choice, probabilities, confidence }`) instead of asking a chat model for JSON. Registering one
(or a small family) would let codemode scripts sort/score structured state without a chat turn.

**Why deferred.** The `logprobs` behaviour was only probed, not turned into an implementation: the
response-shape mapping from DashScope's `logprobs.content[].top_logprobs[]` to pi's every
`ClassifierAnswer` variant (`choice` / `score` / `bool`, with named `criteria`) needs a design pass,
and a classifier is only useful if the model's probabilities are meaningful for the question shapes
pi defines. Spending a release on it without that check risks a classifier that returns numbers
nobody should trust.

**What would unblock it.** One live experiment on a Cloud key: send a handful of representative
`ClassifierContext` questions (a 3-way choice, an ordered score, a bool) to a logprobs-capable
model, and confirm the top-logprob projection reproduces the same labels as a plain chat call. If it
does, implement `classifiers: { "dashscope-classify": { classify } }` on the Cloud provider with a
small `ClassifierModel` list, in the same mixed `models` array as chat and image.

## Virtual models / a router

**What.** pi's `registerVirtualModel()` lets one selectable catalog entry route each request to a
physical model by state. For this extension the natural use is a "cheap by default, escalate when
hard" router over the Alibaba catalog.

**Why deferred.** A useful router needs a signal for "this request is hard", and the cheapest such
signal is a classifier — which is the item above. Building the router first would mean inventing a
heuristic router (keyword/length based) that would be replaced the moment the classifier lands.

**What would unblock it.** A working classifier model on this provider, then a `route()` that
classifies the request (task type, difficulty) and maps it to a physical Cloud/Plan model. Until
then, `/model` plus the per-model thinking levels already cover the manual version.

## Not deferred, but worth watching

- **Video models.** Wan and HappyHorse video models are in the Alibaba catalogue; pi has no video
  model type. Blocked upstream, not here.
- **Asynchronous image endpoints.** `/text2image/image-synthesis`, the async
  `/image-generation/generation`, and the OpenAI-compatible `/compatible-mode/v1/images/generations`
  all work; the synchronous endpoint covers every curated model, so they stay unused.
- **Generation parameters through pi's own `models.generateImages()`.** The host's codemode API
  accepts a model and a context only. The dedicated `alibaba_image` tool exists precisely because of
  it; unblocked only by a host change.

## Cache work from the 2026-10-07 long-session research

Option IDs are those of `docs/notes/2026-10-07-long-session-cache-provider-data-and-options.md`.
Implemented in **2.1.0** (`docs/specs/2.1.0-cache-warming-and-prices.md`): P0-A/B/C (exact price
rows, cache read/write declarations, currency), P1-D/E (refresh interval as a setting, latency rule
in `cache_warming_decision`), P1-F (cache telemetry), P2-J/L (per-model economics in Status,
Responses input guard), P3-M (extension-owned warm engine) and P3-N (`cache_control` markers on
Completions). What is left is decisions and other people's code:

### P2-K — Adaptive session-cache header: decided against "Auto"

**Decision.** The header stays a manual on/off. The arithmetic (note §4, P2-K) only favours
`disable` for a *whole burst* of ≤ 6 turns, never for the single request after a gap: modes are
exclusive per request, so a burst that starts implicit and flips to explicit pays the 125 % creation
twice. And once the warm engine keeps the explicit block alive, determinism is worth more than the
12.5 %-vs-8.3 % read spread. Revisit only for human-chat usage (a few turns per burst, long gaps),
and only with the implicit-TTL curve below in hand.

### P2-G / P2-H — Prefix stability and rewrite timing: review rules, not code

**What.** Tool definitions ride in the system message, so any change to them invalidates the whole
prefix; compaction, context edits and persona switches do the same. Together that is 38 % of measured
cold-miss spend, and no warmer can fix it.

**Why not code.** The only enforceable part is ours: the `before_agent_start` section stays static
(no timestamps, counters or volatile strings) — that is a review rule for this repo, and the codemode
exposure default (2.0.0) already removed two tool declarations from every request. The rest lives in
pi-debi (role/persona switches) and in user habits (compact right after a long idle, when the cache is
already dead, rather than mid-run).

### P2-I — Child/fork prefix alignment (upstream: pi-subagents)

**What.** The cache is prefix-scoped, not session-scoped (probe C10), so a subagent whose system
prompt + tool block + transcript prefix is byte-identical to its parent's could inherit the parent's
block instead of paying a cold create. Measured: 47 of 51 "first big request of a session" cases were
cold on Responses (~32k tokens each for the pi-subagents children of Oct 2), while the 4
Anthropic-format ones hit.

**Why here and not there.** The fork path that would keep the prefix identical belongs to
pi-subagents. The experiment to run first is in the note (§6.5): two children, one with the parent's
exact system prompt and tools, one with a modified section, compare `cached_tokens` on the first
request — now cheap to read, because 2.1.0's telemetry records creation and cached tokens per turn.

### P3-O — Server-side context (`previous_response_id`) and PTU

**What.** DashScope's Responses endpoint stores responses for 7 days and can rebuild context
server-side; PTU (预置吞吐) deployment supports context cache with discount coefficients.

**Why deferred.** pi-ai hardcodes `store: false` and rebuilds the full context every turn (compaction,
branching and context edits all assume it), so `previous_response_id` is an upstream conversation, not
an extension change. PTU is a purchasing decision — worth pricing once the telemetry shows a stable
monthly token volume.

### Watch list (needs data, not design)

- **Warm rewrites.** A nonzero `arrived after expiry` count in `/alibaba → Cloud — Cache Warming →
  Cache statistics` means the refresh interval is too long for that prompt size. If it shows up on
  500k+ prompts, scale the interval with the prompt estimate instead of using one constant.
- **Implicit-TTL survival curve** (note §6.6): one fixed prefix, header `disable`, re-sent after
  6/10/20/40/60 min. Decides whether P2-K is worth reopening.
- **Quota-aware interval.** `/alibaba → Rate limits (Cloud)` already reads `usage_limit` per model;
  the engine could stay under a fraction of it instead of relying on 429 backoff.

## New host surfaces worth adopting (pi 1.0.1 / 1.0.2)

- **`samplingParamsByThinkingLevel`** (pi 1.0.2) is now accepted on `ProviderChatModelConfig`, so
  `buildCloudModels` could set per-thinking-level `temperature`/`top_p` for the DashScope
  OpenAI-compatible families. Not adopted: the spec never asked for sampling control, the right
  values are model-specific and unmeasured, and the field is optional (unset = current behaviour).
  Unblocked by a measurement pass over the families that accept sampling.
- **`pi.registerToolRenderer()`** (pi 1.0.1) draws calls to tools that are not registered. The
  `/alibaba image` result already renders through its custom message and the default image renderer,
  so this is polish only.
- **pi 1.0.1 retries "Selected model is at capacity" provider errors** on its own. That complements
  this extension's wording-based rewrites rather than replacing them; no code change follows.
