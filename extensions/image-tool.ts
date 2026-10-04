// The image surface without codemode: the `alibaba_image` tool and the
// `/alibaba image` subcommand. Both go through `generateImage`, so parameter
// mapping, editor validation, the registry call, and the save/summary behaviour
// cannot drift between them. Kept out of alibaba.ts so the image surface and
// the provider/catalog code change for their own reasons.

import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  ALIBABA_IMAGE_OUTPUT_SCHEMA,
  ALIBABA_IMAGE_PARAMETERS,
  DEFAULT_IMAGE_MODEL,
  imageMetadataFrom,
  parseImageCommand,
  pickImageModel,
  resolveImageReferences,
  saveAndSummarize,
  validateEditorReferences,
  validateImageReferences,
  type ImageToolParams,
} from "./image.ts";
import {
  ALIBABA_IMAGE_ANNOTATIONS,
  ALIBABA_NAMESPACE,
  type RegisterToolDef,
  type ToolCtx,
  type ToolUpdate,
} from "./tool-presentation.ts";

/** How the image surface reads config and the curated catalogue. */
export interface ImageToolDeps {
  /** Fresh config; only `imageModel` is read. */
  loadConfig(): { imageModel?: string };
  /** Curated image model ids the Cloud provider currently registers. */
  imageCatalogIds(): string[];
}

interface GeneratedImage {
  type: "image";
  data: string;
  mimeType: string;
}

type GenerateImageResult =
  | { modelId: string; images: GeneratedImage[]; texts: string[]; usage?: { input: number; output: number; totalTokens: number }; error?: undefined }
  | { modelId: string; images: GeneratedImage[]; texts: string[]; usage?: undefined; error: string };

// Shared by the tool and the command: resolve the model, validate the
// reference count against what that model accepts, call the registry, and
// return the image blocks (or a clear error string).
async function generateImage(
  ctx: Pick<ExtensionCommandContext, "modelRegistry" | "signal">,
  opts: { params: ImageToolParams; prompt: string; references: string[] },
  deps: ImageToolDeps,
): Promise<GenerateImageResult> {
  const modelId = pickImageModel({
    requested: opts.params.model,
    defaultModel: deps.loadConfig().imageModel,
    catalogIds: deps.imageCatalogIds(),
  });
  const editorError = validateEditorReferences(modelId, opts.references.length);
  if (editorError) return { modelId, images: [], texts: [], error: editorError };
  const model = ctx.modelRegistry.findOfType("image", "alibaba-cloud", modelId);
  if (!model) {
    return {
      modelId,
      images: [],
      texts: [],
      error: `image model "${modelId}" is not registered (Cloud image models need a Cloud key; see /alibaba → Status).`,
    };
  }
  let refs: { data: string; mimeType: string }[];
  try {
    refs = resolveImageReferences(opts.references);
  } catch (e) {
    return { modelId, images: [], texts: [], error: e instanceof Error ? e.message : String(e) };
  }
  const result = await ctx.modelRegistry.generateImages(
    model,
    {
      input: [
        { type: "text", text: opts.prompt },
        ...refs.map((r) => ({ type: "image" as const, data: r.data, mimeType: r.mimeType })),
      ],
    },
    { metadata: imageMetadataFrom(opts.params), signal: ctx.signal },
  );
  const images = result.output.filter((b) => b.type === "image") as GeneratedImage[];
  const texts = result.output.filter((b) => b.type === "text") as { type: "text"; text: string }[];
  if (result.stopReason !== "stop") {
    return { modelId, images: [], texts: [], error: result.errorMessage || `image generation ${result.stopReason}` };
  }
  if (!images.length) return { modelId, images: [], texts: [], error: "the model returned no image." };
  const usage = result.usage
    ? { input: result.usage.input, output: result.usage.output, totalTokens: result.usage.totalTokens }
    : undefined;
  return { modelId, images, texts: texts.map((t) => t.text), usage };
}

// `content` so a direct caller and the TUI see the image, `structuredContent`
// because a codemode script receives only structured content from a nested
// call — image blocks in `content` never reach the script.
function imageErrorResult(modelId: string, size: string | undefined, error: string): AgentToolResult {
  return {
    content: [{ type: "text", text: `alibaba_image failed: ${error}` }],
    structuredContent: { images: [], model: modelId, ...(size ? { size } : {}), error },
    details: { model: modelId, error },
    isError: true,
  };
}

/** Register `alibaba_image` at the given exposure (never called with `off`). */
export function registerImageTool(
  pi: ExtensionAPI,
  exposure: "codemode" | "direct" | "deferred",
  deps: ImageToolDeps,
): void {
  pi.registerTool({
    name: "alibaba_image",
    label: "Alibaba image",
    description:
      "Generate or edit an image with a DashScope image model (Cloud key). Takes a prompt, " +
      "0–3 reference images, size/n/seed/negative prompt, watermark and prompt-extension " +
      "toggles, and an optional save path. Prefer qwen-image-* models.",
    promptSnippet:
      "alibaba_image: DashScope image generation/editing; prompt + optional 0–3 references; prefer qwen-image-*.",
    promptGuidelines: [
      "Use alibaba_image only when an image is actually wanted; it spends money per call.",
      "Prefer qwen-image-* for image generation; qwen-image-edit-* for edits.",
    ],
    parameters: ALIBABA_IMAGE_PARAMETERS,
    executionMode: "parallel",
    exposure,
    namespace: ALIBABA_NAMESPACE,
    annotations: ALIBABA_IMAGE_ANNOTATIONS,
    outputSchema: ALIBABA_IMAGE_OUTPUT_SCHEMA,
    async execute(
      _toolCallId: string,
      rawParams: ImageToolParams,
      _signal: AbortSignal | undefined,
      onUpdate: ToolUpdate,
      ctx: ToolCtx,
    ): Promise<AgentToolResult> {
      const params = (rawParams ?? {}) as ImageToolParams;
      const task = typeof params.task === "string" ? params.task.trim() : "";
      if (!task) throw new Error("alibaba_image requires a non-empty task (the prompt).");
      const references = params.images ?? [];
      const tooMany = validateImageReferences(references.length);
      if (tooMany) throw new Error(tooMany);
      const size = typeof params.size === "string" && params.size ? params.size : undefined;
      const modelId = pickImageModel({
        requested: params.model,
        defaultModel: deps.loadConfig().imageModel,
        catalogIds: deps.imageCatalogIds(),
      });
      onUpdate?.({
        content: [{ type: "text", text: `Generating image with ${modelId}…` }],
        details: { model: modelId, partial: true },
      });
      const out = await generateImage(ctx, { prompt: task, references, params: { ...params, model: params.model ?? modelId } }, deps);
      if (out.error) return imageErrorResult(out.modelId, size, out.error);
      const { saved, summary } = saveAndSummarize({ images: out.images, modelId: out.modelId, size, save: params.save });
      return {
        content: [{ type: "text", text: summary }, ...out.images, ...out.texts.map((text) => ({ type: "text" as const, text }))],
        structuredContent: {
          images: out.images.map((b) => ({ type: "image", data: b.data, mimeType: b.mimeType })),
          model: out.modelId,
          ...(size ? { size } : {}),
          ...(out.usage ? { usage: out.usage } : {}),
        },
        details: { model: out.modelId, ...(size ? { size } : {}), count: out.images.length, saved },
      };
    },
  } as RegisterToolDef);
}

/**
 * `/alibaba image <prompt> [flags]` — the no-codemode path. Calls the model
 * registry directly, reports progress while the model works (6–57 s measured),
 * and shows the result as a custom message carrying image content.
 */
export async function runImageCommand(
  pi: ExtensionAPI,
  rawArgs: string,
  ctx: ExtensionCommandContext,
  deps: ImageToolDeps,
): Promise<void> {
  const parsed = parseImageCommand(rawArgs);
  if ("error" in parsed) {
    ctx.ui.notify(parsed.error, "error");
    return;
  }
  const modelId = pickImageModel({ requested: parsed.model, defaultModel: deps.loadConfig().imageModel, catalogIds: deps.imageCatalogIds() });
  const started = Date.now();
  const label = () => `Generating image with ${modelId}… ${Math.round((Date.now() - started) / 1000)}s (up to a minute)`;
  ctx.ui.setStatus("alibaba-image", label());
  const timer = setInterval(() => ctx.ui.setStatus("alibaba-image", label()), 1000);
  let out: GenerateImageResult;
  try {
    out = await generateImage(ctx, {
      prompt: parsed.prompt,
      references: parsed.images ?? [],
      params: {
        model: parsed.model,
        size: parsed.size,
        n: parsed.n,
        seed: parsed.seed,
        negative_prompt: parsed.negativePrompt,
        watermark: parsed.watermark,
        prompt_extend: parsed.promptExtend,
        prompt_extend_mode: parsed.promptExtendMode,
        enable_thinking: parsed.enableThinking,
      },
    }, deps);
  } finally {
    clearInterval(timer);
    ctx.ui.setStatus("alibaba-image", undefined);
  }
  if (out.error) {
    ctx.ui.notify(`Image generation failed: ${out.error}`, "error");
    return;
  }
  const { saved, summary } = saveAndSummarize({ images: out.images, modelId: out.modelId, size: parsed.size, save: parsed.save });
  await pi.sendMessage({
    customType: "alibaba-image",
    content: [{ type: "text", text: summary }, ...out.images],
    display: true,
    details: { model: out.modelId, size: parsed.size, saved, prompt: parsed.prompt },
  });
  ctx.ui.notify(summary, "info");
}
