# The host's model-config export surface, measured (2026-10-03, re-verified 2026-10-11)

Question: why does this repo name its own `ChatModelConfig` (`extensions/alibaba.ts`) and
`ImageModelConfig` (`extensions/image.ts`) instead of importing `ProviderChatModelConfig` and
`ProviderImageModelConfig` from `@earendil-works/pi-coding-agent`? The aliases look like
self-indulgence, so the answer is written down here once, with the evidence.

Answer: **the union's members are not reachable through any supported import specifier.** Only the
union itself is public. First measured 2026-10-03 on two pi 1.0.0 installs (`~/.local` and the nvm
prefix, byte-identical `dist/index.d.ts`, one of the runs by an independent subagent); re-verified
2026-10-11 against the installed **1.1.0** — nothing changed but the line numbers.

## What is exported where (pi 1.1.0)

1. **The members exist and are exported — from an internal module.**
   `dist/core/extensions/types.d.ts` declares and exports `ProviderChatModelConfig` (1462),
   `ProviderImageModelConfig` (1480), `ProviderClassifierModelConfig` (1486) and the union
   `ProviderModelConfig` (1492). The same four are duplicated in `dist/core/provider-composer.d.ts`
   (25 / 37 / 42 / 47). `ProviderModelConfigBase` is **not** exported (plain `interface`, 1443 and
   15). Line numbers drift per release — grep by name, not by number.
2. **The public surface re-exports only the union.** `dist/core/extensions/index.d.ts:9` and
   `dist/index.d.ts:8` both list `ProviderConfig, ProviderModelConfig` and no member:
   `grep -c ProviderChatModelConfig dist/index.d.ts` → `0`.
3. **No specifier reaches the internal module.** The package's `exports` map has four entries: `.`,
   `./rpc-entry` (no `types` condition), `./client` and `./experimental/plugin` (both with a single
   `source` condition, so they do not resolve in the published package at all — `src/` is not in
   `files`). Anything under `/dist/...` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`; `./client` fails
   with `ERR_MODULE_NOT_FOUND`.
4. **TypeScript says the same thing.** Importing the member from the root, compiled 2026-10-11 with
   tsc 6.0.3 under this repo's `tsconfig.json`:

   ```
   error TS2724: '"@earendil-works/pi-coding-agent"' has no exported member named
   'ProviderChatModelConfig'. Did you mean 'ProviderModelConfig'?
   ```
5. **The neighbouring libraries do not help.** `@earendil-works/pi-ai`, `pi-agent-core` and `pi-tui`
   (all 1.1.0) neither declare nor re-export the members
   (`grep -rl ProviderChatModelConfig */dist` → empty). pi-ai's narrowing helpers cover **resolved
   `Model` objects** only — `isModelType`, `assertChatModel`, `assertImageModel`,
   `assertClassifierModel` in `@earendil-works/pi-ai/utils/model-operations`, itself a supported
   subpath — and there is no equivalent for the config union:
   `grep -rEoh '\b(is|assert)[A-Za-z]*ModelConfig\b' dist` → empty.

## Consequence for this repo

Two options work today, and both are in use:

- name the shape locally, or
- cut it out of the exported union: `Extract<ProviderModelConfig, { type?: "chat" }>` (chat, in
  `alibaba.ts`) and `Extract<ProviderModelConfig, { type: "image" }>` (image, in `image.ts`).

Since 2.0.0 the repo uses `Extract`, which is why the host floor is pi 1.0.0: on a pre-1.0.0 host
the config type has no `type` discriminant and `Extract` collapses to `never` (measured while
shipping 1.5.3 — see `docs/adr/0001-drop-pre-1.0.0-hosts.md` and
`docs/specs/2.0.0-pi-1.0-frontier.md`, "Host floor and the model-config type").

If the host ever re-exports the members from the package root, or ships an `isChatModelConfig()`-style
helper for configs, each alias collapses into one import. Both are single, adjacent lines, so the
change is one edit per file — and `docs/TODO.md` keeps an eye on it.

## Reproducing

```sh
P=$(npm root -g)/@earendil-works/pi-coding-agent      # or node_modules/@earendil-works/...
grep -n "Provider\(Chat\|Image\|Classifier\)ModelConfig\|ProviderModelConfig\b" \
  "$P/dist/core/extensions/types.d.ts" "$P/dist/core/provider-composer.d.ts"
grep -c ProviderChatModelConfig "$P/dist/index.d.ts"                       # → 0
node -e 'console.log(JSON.stringify(require(process.argv[1]).exports,null,1))' "$P/package.json"
node --input-type=module -e \
  'await import("@earendil-works/pi-coding-agent/dist/core/extensions/types.js")'  # → ERR_PACKAGE_PATH_NOT_EXPORTED
grep -rEoh '\b(is|assert)[A-Za-z]*ModelConfig\b' "$P/dist" | sort -u       # → empty
# TS2724: put `import type { ProviderChatModelConfig } from "@earendil-works/pi-coding-agent";`
# in a scratch file and compile it with a tsconfig that extends this repo's and includes it.
```
