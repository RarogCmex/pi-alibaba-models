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
