# pi-alibaba-models

A pi extension that registers Alibaba's model services as chat providers and adds a billed
DashScope sidecar tool. This glossary fixes the vocabulary the code, README and CHANGELOG share.

## Language

### Providers

**Plan**:
The `alibaba-plan` provider: a Model Studio Coding Plan subscription reached with a pasted token.
_Avoid_: subscription, coding plan, plan mode

**Cloud**:
The `alibaba-cloud` provider: pay-per-token DashScope reached with an API key from `/login` or `$DASHSCOPE_API_KEY`.
_Avoid_: DashScope (that is the host, not the provider), API mode, payg

### Cloud addressing

**Domain**:
The single Cloud host every Cloud request goes to, chosen by the user.
_Avoid_: endpoint, region, base URL

**Shared regional domain**:
One of Alibaba's common Cloud hosts — `dashscope.aliyuncs.com`, `dashscope-intl.aliyuncs.com`,
`dashscope-us.aliyuncs.com`, or Hong Kong — which serves keys from any workspace.
_Avoid_: public domain, default endpoint

**Workspace domain**:
A Cloud host of the form `{WorkspaceId}.{region}.maas.aliyuncs.com`, tied to one business space.
_Avoid_: corporate endpoint, private domain

**Key binding**:
The recorded pairing of the current Cloud key with the domain derived for that key. A key the
extension has not seen before invalidates the binding and forces re-derivation.
_Avoid_: key fingerprint (that is the field that stores the binding), rebind

Plan keeps two base URLs — Anthropic and OpenAI — and neither is called a "domain".

### Catalogs

**Catalog snapshot**:
The private, versioned `alibaba-models.cache.json`, written only after a real fetch, that seeds
provider registration at boot with no network. A seed, never proof of freshness.
_Avoid_: cache, model cache

**Freshness stamp**:
The shared timestamp in `alibaba-config.json` that decides whether a fetch is due. A catalog
snapshot does not carry one.
_Avoid_: TTL

### Sidecar

**Sidecar**:
A DashScope request this extension makes on its own, outside pi's chat stream, on behalf of
`alibaba_tools`. Its wire shape is independent of the Cloud format.
_Avoid_: built-in tools, DashScope tools, plugin tools

**Sidecar action**:
What a sidecar call does: `search`, `research`, `code`, or `image`.
_Avoid_: mode, operation

**Sidecar transport**:
The DashScope API shape a sidecar call uses: `responses` or `completions`.
_Avoid_: format (that word belongs to the Cloud chat API)

**Cloud format**:
The chat wire format of the Cloud provider: `openai-responses`, `anthropic-messages`, or
`openai-completions`.
_Avoid_: transport, protocol, API mode

### Images

**Image model**:
A `type: "image"` model registered on the Cloud provider and served by the synchronous
`/api/v1/services/aigc/multimodal-generation/generation` endpoint. Curated to prompt-driven
generators and editors; vertical products and third-party ids are never registered.
_Avoid_: vision model (that is a chat model that accepts image input)

**Generator / editor**:
A generator takes text only (`qwen-image-plus`, `z-image-turbo`, …); an editor additionally takes
1–3 reference images (`qwen-image-edit-*`, and the `qwen-image-3.0` / `qwen-image-3.0-pro` pair).
The distinction is the model's `input` modalities.
_Avoid_: t2i model, i2i model

**Recommended family**:
The `qwen-image-*` ids, marked `(recommended)` in their display name and preferred by the
system-prompt section. `z-image-*` and `wan*-image` are registered but not preferred.
_Avoid_: default family

### Tools

**Exposure**:
How a tool reaches the model: `codemode` (default; callable from scripts, not declared every
turn), `direct`, `deferred` (tool search), or `off` (not registered). Both Alibaba tools share the
`alibaba` namespace.
_Avoid_: visibility, mode

**Prompt section**:
The one `before_agent_start` section, present only while an Alibaba tool is codemode-exposed, that
tells the model the tools are callable from scripts and to prefer `qwen-image-*`.
_Avoid_: prompt snippet (that is a per-tool declaration rendered only while a tool is active)

### Host

**Host floor**:
The oldest pi version this package supports.
_Avoid_: minimum version, peer version
