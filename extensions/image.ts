// DashScope image generation, registered as a pi image model on the Cloud
// provider. Everything here is measured against the synchronous endpoint
// (2026-10-03):
//
//   POST https://{Domain}/api/v1/services/aigc/multimodal-generation/generation
//   { "model": "<id>",
//     "input": { "messages": [ { "role": "user", "content": [ {text}, {image} ] } ] },
//     "parameters": { size, n, seed, negative_prompt, watermark,
//                     prompt_extend, prompt_extend_mode, enable_thinking } }
//
// The response's `output.choices[0].message.content[]` carries
// `{ "type": "image", "image": "<url>" }`, and the URL is short-lived (24h),
// so the implementation downloads it and returns an image content block.
//
// Pure functions (catalogue parsing, the curated filter, the card builder,
// the request-body builder, the response parser, the tool-call mapping) are
// exported for tests; only the network, the download, and the file write are
// impure.

import fs from "node:fs";
import path from "node:path";
import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// The host does not re-export the union members (`ProviderImageModelConfig`
// and friends) from the package root — measured on two pi 1.0.0 installs — so
// the image member is named locally through the exported union, exactly like
// the chat member in alibaba.ts.
export type ImageModelConfig = Extract<ProviderModelConfig, { type: "image" }>;

// The implementation contract is reached through the exported ProviderConfig
// instead of importing @earendil-works/pi-ai, which is not a direct dependency
// and has no supported subpath from an extension.
type ImagesImpl = NonNullable<NonNullable<ProviderConfig["images"]>[string]>;
export type ImagesModelArg = Parameters<ImagesImpl["generateImages"]>[0];
export type ImagesContextArg = Parameters<ImagesImpl["generateImages"]>[1];
export type ImagesOptionsArg = Parameters<ImagesImpl["generateImages"]>[2];
export type AssistantImagesResult = Awaited<ReturnType<ImagesImpl["generateImages"]>>;

/** Image API key the Cloud provider registers its implementation under. */
export const IMAGE_API = "dashscope-images";

/** Path (without the trailing `/generation`) every curated model shares. */
export const IMAGE_ENDPOINT = "/api/v1/services/aigc/multimodal-generation";

/** Marker appended to the recommended `qwen-image-*` family's display name. */
export const IMAGE_RECOMMENDED_MARKER = " (recommended)";

/** Fallback when no image model is configured and none was requested. */
export const DEFAULT_IMAGE_MODEL = "qwen-image-plus";

// Curated allow-list. Only prompt-driven generators and editors are
// registered; vertical products (virtual try-on, face chains, word art) and
// third-party ids never are. A model on both lists can generate and edit.
const TEXT_TO_IMAGE_IDS = [
  "qwen-image-3.0-pro",
  "qwen-image-3.0",
  "qwen-image-max",
  "qwen-image-plus",
  "qwen-image",
  "qwen-image-2.0",
  "z-image-turbo",
  "wan2.7-image-pro",
  "wan2.6-t2i",
] as const;

const IMAGE_EDIT_IDS = [
  "qwen-image-3.0-pro",
  "qwen-image-3.0",
  "qwen-image-edit-max",
  "qwen-image-edit-plus",
  "qwen-image-edit",
] as const;

// Deterministic registration order: the generators first, then the
// editors that are not already generators.
const CURATED_ORDER: string[] = [
  ...TEXT_TO_IMAGE_IDS,
  ...IMAGE_EDIT_IDS.filter((id) => !(TEXT_TO_IMAGE_IDS as readonly string[]).includes(id)),
];

/** A generator takes text only; an editor additionally takes reference images. */
export function curatedImageInput(id: string): ("text" | "image")[] {
  return isImageEditModel(id) ? ["text", "image"] : ["text"];
}

export function isImageEditModel(id: string): boolean {
  return (IMAGE_EDIT_IDS as readonly string[]).includes(id);
}

/** The recommended family is the one the system-prompt section points at. */
export function isRecommendedImageModel(id: string): boolean {
  return /^qwen-image/i.test(id);
}

export interface ImageCatalogRow {
  id: string;
  name?: string;
}

/** Parse a Cloud `/api/v1/models?capabilities=IG` response into rows. */
export function parseImageCatalog(json: unknown): ImageCatalogRow[] {
  const output = (json as { output?: { models?: unknown } } | null | undefined)?.output;
  const models = Array.isArray(output?.models) ? (output!.models as unknown[]) : [];
  const rows: ImageCatalogRow[] = [];
  for (const raw of models) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as { model?: unknown; name?: unknown };
    if (typeof m.model !== "string" || !m.model) continue;
    rows.push({ id: m.model, name: typeof m.name === "string" && m.name ? m.name : undefined });
  }
  return rows;
}

/** Keep only the curated prompt-driven ids, in the allow-list's own order. */
export function filterCuratedImageModels(rows: ImageCatalogRow[]): ImageCatalogRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return CURATED_ORDER.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
}

/** A stable display name, with the recommended family marked. */
export function imageCardName(id: string, catalogName?: string): string {
  const base = catalogName?.trim() || id;
  const pretty = base === id ? prettyImageName(id) : base;
  if (pretty.endsWith(IMAGE_RECOMMENDED_MARKER)) return pretty; // already marked (stored snapshot)
  return isRecommendedImageModel(id) ? `${pretty}${IMAGE_RECOMMENDED_MARKER}` : pretty;
}

function prettyImageName(id: string): string {
  return id
    .replace(/^qwen-image/i, "Qwen Image")
    .replace(/^z-image/i, "Z-Image")
    .replace(/^wan/i, "Wan")
    .replace(/-/g, " ")
    .replace(/\b([a-z])/g, (s) => s.toUpperCase())
    .replace(/\bT2i\b/g, "t2i");
}

/** Build the provider's image-model cards from the curated catalogue rows. */
export function buildImageModels(rows: ImageCatalogRow[], domain: string): ImageModelConfig[] {
  return rows.map((row) => ({
    type: "image" as const,
    id: row.id,
    name: imageCardName(row.id, row.name),
    api: IMAGE_API,
    baseUrl: `https://${domain}${IMAGE_ENDPOINT}`,
    input: curatedImageInput(row.id),
    output: ["image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
}

// ── Request building ──────────────────────────────────────────────────

export interface ImageRequestOptions {
  model: string;
  prompt: string;
  /** Reference images, each a URL or a `data:` URL. 0–3 items. */
  references?: string[];
  size?: string;
  n?: number;
  seed?: number;
  negativePrompt?: string;
  watermark?: boolean;
  promptExtend?: boolean;
  promptExtendMode?: "direct" | "agent";
  enableThinking?: boolean;
}

/**
 * Build the request body exactly as DashScope sees it. Unset parameters are
 * omitted rather than sent as empty strings, so the model keeps its own default.
 */
export function buildImageRequest(opts: ImageRequestOptions): Record<string, unknown> {
  const content: Record<string, unknown>[] = [{ text: opts.prompt }];
  for (const reference of opts.references ?? []) content.push({ image: reference });

  const parameters: Record<string, unknown> = {};
  if (opts.size) parameters.size = opts.size;
  if (typeof opts.n === "number" && Number.isFinite(opts.n)) parameters.n = opts.n;
  if (typeof opts.seed === "number" && Number.isFinite(opts.seed)) parameters.seed = opts.seed;
  if (opts.negativePrompt) parameters.negative_prompt = opts.negativePrompt;
  if (typeof opts.watermark === "boolean") parameters.watermark = opts.watermark;
  if (typeof opts.promptExtend === "boolean") parameters.prompt_extend = opts.promptExtend;
  if (opts.promptExtendMode) parameters.prompt_extend_mode = opts.promptExtendMode;
  if (typeof opts.enableThinking === "boolean") parameters.enable_thinking = opts.enableThinking;

  return {
    model: opts.model,
    input: { messages: [{ role: "user", content }] },
    parameters,
  };
}

// ── Response parsing ─────────────────────────────────────────────────

export interface ParsedImageResponse {
  /** Short-lived (24h) image URLs, in response order. */
  urls: string[];
  /** Text blocks some models return alongside the image. */
  texts: string[];
  /** pi-shaped usage, only when the model reported token counts. */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseImageGenerationResponse(json: unknown): ParsedImageResponse {
  const root = asRecord(json) ?? {};
  const output = asRecord(root.output) ?? {};
  const choices = Array.isArray(output.choices) ? output.choices : [];
  const message = asRecord(asRecord(choices[0])?.message);
  const content = message?.content;

  const urls: string[] = [];
  const texts: string[] = [];

  if (typeof content === "string" && content) texts.push(content);
  if (Array.isArray(content)) {
    for (const raw of content) {
      const block = asRecord(raw);
      if (!block) continue;
      if (typeof block.image === "string" && block.image) urls.push(block.image);
      else if (typeof block.text === "string" && block.text) texts.push(block.text);
    }
  }

  return { urls, texts, usage: parseImageUsage(root.usage) };
}

/**
 * DashScope's `usage` is heterogeneous across models: `{ image_count, width,
 * height }`, `{ image_count, input_tokens, output_tokens, total_tokens, size }`,
 * or `{ output_width, output_image_count, ... }`. Map token counts when they
 * exist; return undefined otherwise, because pi prices per token and DashScope
 * bills images per image.
 */
export function parseImageUsage(usage: unknown): ParsedImageResponse["usage"] | undefined {
  const u = asRecord(usage);
  if (!u) return undefined;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  const i = input ?? 0;
  const o = output ?? 0;
  const total = num(u.total_tokens) ?? i + o;
  return { input: i, output: o, cacheRead: 0, cacheWrite: 0, totalTokens: total };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// ── The provider implementation ──────────────────────────────────────

export interface ImageProviderMetadata {
  /** Index signature so the object can travel as provider `metadata`. */
  [key: string]: unknown;
  size?: string;
  n?: number;
  seed?: number;
  negativePrompt?: string;
  watermark?: boolean;
  promptExtend?: boolean;
  promptExtendMode?: "direct" | "agent";
  enableThinking?: boolean;
}

/** Join the context's text blocks into the single prompt DashScope expects. */
export function promptFromContext(context: ImagesContextArg): string {
  const parts: string[] = [];
  for (const item of context.input ?? []) {
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n").trim();
}

/** Turn the context's image blocks into `data:` references. */
export function referencesFromContext(context: ImagesContextArg): string[] {
  const out: string[] = [];
  for (const item of context.input ?? []) {
    if (item.type === "image" && typeof item.data === "string" && item.data) {
      out.push(`data:${item.mimeType || "image/png"};base64,${item.data}`);
    }
  }
  return out;
}

function metadataFromOptions(options: ImagesOptionsArg | undefined): ImageProviderMetadata {
  return readImageMetadata(options?.metadata);
}

/** The one reader/validator for image metadata, wherever it arrives from. */
export function readImageMetadata(raw: unknown): ImageProviderMetadata {
  const meta = asRecord(raw);
  if (!meta) return {};
  const mode = meta.promptExtendMode === "direct" || meta.promptExtendMode === "agent" ? meta.promptExtendMode : undefined;
  return {
    size: typeof meta.size === "string" ? meta.size : undefined,
    n: num(meta.n),
    seed: num(meta.seed),
    negativePrompt: typeof meta.negativePrompt === "string" ? meta.negativePrompt : undefined,
    watermark: typeof meta.watermark === "boolean" ? meta.watermark : undefined,
    promptExtend: typeof meta.promptExtend === "boolean" ? meta.promptExtend : undefined,
    promptExtendMode: mode,
    enableThinking: typeof meta.enableThinking === "boolean" ? meta.enableThinking : undefined,
  };
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

export interface ResolvedReference {
  data: string;
  mimeType: string;
}

/**
 * Resolve one user-supplied reference (a `data:` URL or a local file path) into
 * a base64 image block — what pi's image context can carry. Remote URLs are
 * rejected with a clear error: the host's image input is base64-only.
 */
export function resolveImageReference(value: string): ResolvedReference {
  const ref = value.trim();
  if (/^data:/i.test(ref)) {
    const m = ref.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/is);
    if (!m || !m[2]) throw new Error("unsupported data: URL");
    return { mimeType: m[1] || "image/png", data: m[2] };
  }
  if (/^https?:\/\//i.test(ref)) {
    throw new Error("remote image URLs are not supported; download the image and pass a local path");
  }
  const bytes = fs.readFileSync(ref);
  const mimeType = MIME_BY_EXT[path.extname(ref).toLowerCase()] ?? "image/png";
  return { data: bytes.toString("base64"), mimeType };
}

/** Resolve a tool/command reference list; throws a clear error on a bad path. */
export function resolveImageReferences(values: readonly string[] | undefined): ResolvedReference[] {
  return (values ?? []).map((v) => {
    try {
      return resolveImageReference(v);
    } catch (e) {
      throw new Error(`could not read reference image ${JSON.stringify(v)}: ${e instanceof Error ? e.message : e}`);
    }
  });
}

/** Download one short-lived URL and return base64 bytes plus a MIME type. */
export async function downloadImage(
  url: string,
  signal?: AbortSignal,
): Promise<{ data: string; mimeType: string }> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
  const mimeType = (res.headers.get("content-type") || "image/png").split(";")[0].trim() || "image/png";
  const bytes = Buffer.from(await res.arrayBuffer());
  return { data: bytes.toString("base64"), mimeType };
}

function errorResult(model: ImagesModelArg, message: string, aborted: boolean): AssistantImagesResult {
  return {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: aborted ? "aborted" : "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

/**
 * The registered `images[IMAGE_API].generateImages` implementation. Never
 * rejects: a provider failure arrives as `stopReason: "error"` with an
 * `errorMessage`, which the tool turns into an error result.
 */
export async function generateDashScopeImages(
  model: ImagesModelArg,
  context: ImagesContextArg,
  options?: ImagesOptionsArg,
): Promise<AssistantImagesResult> {
  const aborted = () => Boolean(options?.signal?.aborted);
  try {
    const apiKey = options?.apiKey;
    if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);

    const meta = metadataFromOptions(options);
    const body = buildImageRequest({
      model: model.id,
      prompt: promptFromContext(context),
      references: referencesFromContext(context),
      ...meta,
    });

    const res = await fetch(`${model.baseUrl}/generation`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const detail = text ? `: ${text.slice(0, 500)}` : "";
      throw new Error(`DashScope image HTTP ${res.status}${detail}`);
    }

    const parsed = parseImageGenerationResponse(await res.json());
    const result: AssistantImagesResult = {
      api: model.api,
      provider: model.provider,
      model: model.id,
      output: [],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    if (parsed.usage) {
      result.usage = { ...parsed.usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    }
    for (const url of parsed.urls) {
      const image = await downloadImage(url, options?.signal);
      result.output.push({ type: "image", data: image.data, mimeType: image.mimeType });
    }
    for (const text of parsed.texts) result.output.push({ type: "text", text });
    if (!parsed.urls.length && !parsed.texts.length) {
      result.stopReason = "error";
      result.errorMessage = "DashScope returned no image and no text.";
    }
    return result;
  } catch (e: unknown) {
    return errorResult(model, e instanceof Error ? e.message : String(e), aborted());
  }
}

// ── Tool helpers (pure) ──────────────────────────────────────────────

function indexedPath(p: string, index: number): string {
  const ext = path.extname(p);
  return ext ? `${p.slice(0, -ext.length)}-${index}${ext}` : `${p}-${index}`;
}

/**
 * The extension's only file write: one explicit `save` path. Variants beyond
 * the first get a numeric suffix so `n > 1` does not silently drop images.
 */
export function writeImageFiles(images: { data: string }[], savePath: string): string[] {
  return images.map((image, i) => {
    const target = i === 0 ? savePath : indexedPath(savePath, i + 1);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(image.data, "base64"));
    return target;
  });
}

/**
 * One result line + the optional save, shared by `alibaba_image` and
 * `/alibaba image` so the two surfaces cannot drift apart.
 */
export function saveAndSummarize(opts: {
  images: { data: string }[];
  modelId: string;
  size?: string;
  save?: string;
}): { saved: string[]; summary: string } {
  const saved = opts.save ? writeImageFiles(opts.images, opts.save) : [];
  const count = opts.images.length;
  const summary = `Generated ${count} image${count === 1 ? "" : "s"} with ${opts.modelId}` +
    `${opts.size ? ` at ${opts.size}` : ""}${saved.length ? ` — saved to ${saved.join(", ")}` : ""}.`;
  return { saved, summary };
}

export const ALIBABA_IMAGE_PARAMETERS = {
  type: "object" as const,
  properties: {
    model: {
      type: "string" as const,
      description:
        "DashScope image model id (default: the configured image model, else qwen-image-plus). " +
        "Editors (qwen-image-edit-*, qwen-image-3.0*) need 1–3 reference images; generators do not.",
    },
    task: {
      type: "string" as const,
      description: "The image prompt (required).",
    },
    images: {
      type: "array" as const,
      items: { type: "string" as const },
      description:
        "0–3 reference images for an edit: local file paths or data: URLs (remote URLs are not supported).",
    },
    size: {
      type: "string" as const,
      description: "Output size as <width>*<height>, e.g. \"1024*1024\". Default depends on the model.",
    },
    n: {
      type: "number" as const,
      description: "Number of images to generate (default 1).",
    },
    seed: {
      type: "number" as const,
      description: "Random seed for reproducible results.",
    },
    negative_prompt: {
      type: "string" as const,
      description: "What to exclude from the image.",
    },
    watermark: {
      type: "boolean" as const,
      description: "Whether to add the model watermark (default true).",
    },
    prompt_extend: {
      type: "boolean" as const,
      description: "Whether to rewrite the prompt before generation (default true).",
    },
    prompt_extend_mode: {
      type: "string" as const,
      enum: ["direct", "agent"],
      description: "Prompt-rewrite mode where the model supports it.",
    },
    enable_thinking: {
      type: "boolean" as const,
      description: "Whether the model may think before generating (where supported).",
    },
    save: {
      type: "string" as const,
      description:
        "Optional path to write the generated image bytes to. When omitted, nothing is written.",
    },
  },
  required: ["task"],
};

export const ALIBABA_IMAGE_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    images: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          type: { type: "string" as const },
          data: { type: "string" as const },
          mimeType: { type: "string" as const },
        },
        required: ["type", "data", "mimeType"],
      },
    },
    model: { type: "string" as const },
    size: { type: "string" as const },
    error: { type: "string" as const },
    usage: {
      type: "object" as const,
      properties: {
        input: { type: "number" as const },
        output: { type: "number" as const },
        totalTokens: { type: "number" as const },
      },
    },
  },
  required: ["images", "model"],
};

export interface ImageToolParams {
  model?: string;
  task?: string;
  images?: string[];
  size?: string;
  n?: number;
  seed?: number;
  negative_prompt?: string;
  watermark?: boolean;
  prompt_extend?: boolean;
  prompt_extend_mode?: "direct" | "agent";
  enable_thinking?: boolean;
  save?: string;
}

/**
 * Pick the image model for a call: the explicit request, else the configured
 * default, else the documented fallback when the catalogue has it, else the
 * first recommended family, else the first catalogue entry. Pure.
 */
export function pickImageModel(opts: {
  requested?: string;
  defaultModel?: string;
  catalogIds: string[];
}): string {
  for (const candidate of [opts.requested, opts.defaultModel]) {
    if (candidate && candidate.trim()) return candidate.trim();
  }
  if (opts.catalogIds.includes(DEFAULT_IMAGE_MODEL)) return DEFAULT_IMAGE_MODEL;
  return opts.catalogIds.find((id) => isRecommendedImageModel(id)) ?? opts.catalogIds[0] ?? DEFAULT_IMAGE_MODEL;
}

/** Map tool parameters (snake_case) onto the provider's metadata shape. Pure. */
export function imageMetadataFrom(params: ImageToolParams): ImageProviderMetadata {
  return readImageMetadata({
    size: params.size,
    n: params.n,
    seed: params.seed,
    negativePrompt: params.negative_prompt,
    watermark: params.watermark,
    promptExtend: params.prompt_extend,
    promptExtendMode: params.prompt_extend_mode,
    enableThinking: params.enable_thinking,
  });
}

/** Reject reference counts no curated model accepts, before spending a call. Pure. */
export function validateImageReferences(count: number): string | undefined {
  if (count > 3) return `at most 3 reference images are accepted (got ${count}).`;
  return undefined;
}

/** Editors reject a call without 1–3 reference images; surface that early. Pure. */
export function validateEditorReferences(modelId: string, count: number): string | undefined {
  if (isImageEditModel(modelId) && count < 1) {
    return `"${modelId}" is an image editor and needs 1–3 reference images (pass images).`;
  }
  return undefined;
}

// ── Command parsing (pure) ───────────────────────────────────────────

export interface ImageCommandArgs {
  prompt: string;
  model?: string;
  images?: string[];
  size?: string;
  n?: number;
  seed?: number;
  negativePrompt?: string;
  watermark?: boolean;
  promptExtend?: boolean;
  promptExtendMode?: "direct" | "agent";
  enableThinking?: boolean;
  save?: string;
}

/** Split a command line into tokens, honoring single/double quotes. */
export function tokenizeImageArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; hasToken = true; continue; }
    if (/\s/.test(ch)) {
      if (hasToken) { tokens.push(current); current = ""; hasToken = false; }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/**
 * Parse `/alibaba image <prompt> [flags]`. The first non-flag token is the
 * prompt; remaining non-flag tokens are appended. Unknown flags are errors so
 * a typo is loud rather than silently ignored.
 */
export function parseImageCommand(input: string): ImageCommandArgs | { error: string } {
  const tokens = tokenizeImageArgs(input);
  const args: ImageCommandArgs = { prompt: "" };
  const promptParts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eq >= 0 ? token.slice(0, eq) : token;
    const inline = eq >= 0 ? token.slice(eq + 1) : undefined;
    const value = () => inline ?? tokens[++i];
    switch (flag) {
      case "--model": { const v = value(); if (!v) return { error: "--model needs a value" }; args.model = v; break; }
      case "--image": { const v = value(); if (!v) return { error: "--image needs a value" }; (args.images ??= []).push(v); break; }
      case "--size": { const v = value(); if (!v) return { error: "--size needs a value" }; args.size = v; break; }
      case "--n": { const v = value(); if (!v || !Number.isFinite(Number(v))) return { error: "--n needs a number" }; args.n = Number(v); break; }
      case "--seed": { const v = value(); if (!v || !Number.isFinite(Number(v))) return { error: "--seed needs a number" }; args.seed = Number(v); break; }
      case "--negative": { const v = value(); if (!v) return { error: "--negative needs a value" }; args.negativePrompt = v; break; }
      case "--save": { const v = value(); if (!v) return { error: "--save needs a value" }; args.save = v; break; }
      case "--prompt-extend-mode": {
        const v = value();
        if (v !== "direct" && v !== "agent") return { error: "--prompt-extend-mode must be direct or agent" };
        args.promptExtendMode = v;
        break;
      }
      case "--watermark": args.watermark = true; break;
      case "--no-watermark": args.watermark = false; break;
      case "--prompt-extend": args.promptExtend = true; break;
      case "--no-prompt-extend": args.promptExtend = false; break;
      case "--thinking": args.enableThinking = true; break;
      case "--no-thinking": args.enableThinking = false; break;
      default:
        if (flag.startsWith("--")) return { error: `unknown option ${flag}` };
        promptParts.push(token);
    }
  }
  args.prompt = promptParts.join(" ").trim();
  if (!args.prompt) return { error: "a prompt is required: /alibaba image <prompt> [flags]" };
  const tooMany = validateImageReferences(args.images?.length ?? 0);
  if (tooMany) return { error: tooMany };
  return args;
}
