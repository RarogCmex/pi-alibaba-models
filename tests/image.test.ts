import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ALIBABA_IMAGE_PARAMETERS,
  buildImageModels,
  buildImageRequest,
  DEFAULT_IMAGE_MODEL,
  downloadImage,
  filterCuratedImageModels,
  generateDashScopeImages,
  imageCardName,
  imageMetadataFrom,
  isImageEditModel,
  parseImageCatalog,
  parseImageCommand,
  parseImageGenerationResponse,
  parseImageUsage,
  pickImageModel,
  readImageMetadata,
  resolveImageReference,
  resolveImageReferences,
  tokenizeImageArgs,
  validateEditorReferences,
  validateImageReferences,
  type ImageCatalogRow,
} from "../extensions/image.ts";

const rawCatalog = {
  output: {
    total: 4,
    models: [
      { model: "qwen-image-plus", name: "qwen-image-plus" },
      { model: "wordart-something", name: "WordArt" },
      { model: "qwen-image-edit-max", name: "qwen-image-edit-max" },
      { model: "aitryon-plus", name: "AI Try On" },
    ],
  },
};

describe("image catalogue parsing + curated filter", () => {
  it("parses the native IG listing into id/name rows", () => {
    const rows = parseImageCatalog(rawCatalog);
    assert.deepEqual(rows.map((r) => r.id), ["qwen-image-plus", "wordart-something", "qwen-image-edit-max", "aitryon-plus"]);
    assert.equal(rows[0].name, "qwen-image-plus");
  });

  it("ignores junk shapes", () => {
    assert.deepEqual(parseImageCatalog(null), []);
    assert.deepEqual(parseImageCatalog({ output: { models: "nope" } }), []);
    assert.deepEqual(parseImageCatalog({ output: { models: [{ name: "no id" }, 42] } }), []);
  });

  it("keeps only prompt-driven generators and editors, in allow-list order", () => {
    const rows = filterCuratedImageModels(parseImageCatalog(rawCatalog));
    assert.deepEqual(rows.map((r) => r.id), ["qwen-image-plus", "qwen-image-edit-max"]);
  });

  it("never registers vertical or third-party ids", () => {
    const ids = parseImageCatalog({
      output: { models: ["aitryon-plus", "facechain-fusion", "virtualmodel", "wordart-something", "qwen-mt-image", "kling/kolors", "vidu/v2"].map((model) => ({ model })) },
    });
    assert.deepEqual(filterCuratedImageModels(ids), []);
  });
});

describe("image model cards", () => {
  const rows: ImageCatalogRow[] = [
    { id: "qwen-image-plus", name: "Qwen Image Plus" },
    { id: "z-image-turbo", name: "Z-Image Turbo" },
    { id: "qwen-image-edit-max", name: "Qwen Image Edit Max" },
  ];

  it("declares type image, the image api, and the synchronous endpoint", () => {
    const [card] = buildImageModels([rows[0]], "dashscope.example");
    assert.equal(card.type, "image");
    assert.equal(card.api, "dashscope-images");
    assert.equal(card.baseUrl, "https://dashscope.example/api/v1/services/aigc/multimodal-generation");
    assert.deepEqual(card.output, ["image"]);
    assert.deepEqual(card.input, ["text"]);
    assert.deepEqual(card.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("tells generators from editors by their input modalities", () => {
    const cards = buildImageModels(rows, "dashscope.example");
    assert.deepEqual(cards[0].input, ["text"]); // generator
    assert.deepEqual(cards[2].input, ["text", "image"]); // editor
  });

  it("marks the recommended qwen-image family and is idempotent over a stored name", () => {
    assert.equal(imageCardName("qwen-image-plus", "Qwen Image Plus"), "Qwen Image Plus (recommended)");
    assert.equal(imageCardName("z-image-turbo", "Z-Image Turbo"), "Z-Image Turbo");
    assert.equal(imageCardName("qwen-image-plus", "Qwen Image Plus (recommended)"), "Qwen Image Plus (recommended)");
  });
});

describe("image request body", () => {
  it("builds the exact synchronized-generation payload", () => {
    const body = buildImageRequest({
      model: "qwen-image-plus",
      prompt: "a red fox in the snow",
      references: ["data:image/png;base64,QUJD"],
      size: "1024*1024",
      n: 2,
      seed: 7,
      negativePrompt: "blurry",
      watermark: false,
      promptExtend: true,
      promptExtendMode: "direct",
      enableThinking: false,
    });
    assert.deepEqual(body, {
      model: "qwen-image-plus",
      input: {
        messages: [{
          role: "user",
          content: [{ text: "a red fox in the snow" }, { image: "data:image/png;base64,QUJD" }],
        }],
      },
      parameters: {
        size: "1024*1024",
        n: 2,
        seed: 7,
        negative_prompt: "blurry",
        watermark: false,
        prompt_extend: true,
        prompt_extend_mode: "direct",
        enable_thinking: false,
      },
    });
  });

  it("omits unset parameters so the model keeps its own default", () => {
    const body = buildImageRequest({ model: "qwen-image", prompt: "hi" });
    assert.deepEqual(body.parameters, {});
    assert.deepEqual((body.input as { messages: { content: unknown[] }[] }).messages[0].content, [{ text: "hi" }]);
  });
});

describe("image response parsing", () => {
  it("lifts image and text blocks from output.choices[0].message.content", () => {
    const parsed = parseImageGenerationResponse({
      output: { choices: [{ message: { content: [{ type: "image", image: "https://img/x.png" }, { type: "text", text: "here" }] } }] },
    });
    assert.deepEqual(parsed.urls, ["https://img/x.png"]);
    assert.deepEqual(parsed.texts, ["here"]);
  });

  it("maps token usage when the model reports it, and leaves it unset otherwise", () => {
    assert.deepEqual(parseImageUsage({ input_tokens: 10, output_tokens: 20 }), {
      input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
    });
    assert.equal(parseImageUsage({ total_tokens: 5 }), undefined); // no input/output breakdown -> unset
    assert.equal(parseImageUsage({ image_count: 1, width: 1024, height: 1024 }), undefined);
    assert.equal(parseImageUsage(undefined), undefined);
  });
});

describe("generateDashScopeImages (fake fetch)", () => {
  const model = {
    api: "dashscope-images",
    provider: "alibaba-cloud",
    id: "qwen-image-plus",
    baseUrl: "https://dashscope.example/api/v1/services/aigc/multimodal-generation",
  } as never;
  const originalFetch = globalThis.fetch;

  after(() => { globalThis.fetch = originalFetch; });

  it("posts the body and returns the downloaded image as an image block", async () => {
    const calls: { url: string; body?: string }[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/generation")) {
        calls.push({ url: String(url), body: String(init?.body) });
        return new Response(JSON.stringify({
          output: { choices: [{ message: { content: [{ type: "image", image: "https://img.example/x.png" }] } }] },
          usage: { input_tokens: 10, output_tokens: 20 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      calls.push({ url: String(url) });
      return new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { "content-type": "image/png; charset=binary" } });
    }) as typeof fetch;

    const result = await generateDashScopeImages(
      model,
      { input: [{ type: "text", text: "a fox" }, { type: "image", data: "QUJD", mimeType: "image/jpeg" }] },
      { apiKey: "sk-test", metadata: { size: "1024*1024", n: 1 } },
    );

    assert.equal(result.stopReason, "stop");
    assert.deepEqual(result.output, [{ type: "image", data: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "image/png" }]);
    assert.equal(result.usage?.totalTokens, 30);
    assert.equal(calls[0].url, "https://dashscope.example/api/v1/services/aigc/multimodal-generation/generation");
    assert.deepEqual(JSON.parse(calls[0].body!), {
      model: "qwen-image-plus",
      input: { messages: [{ role: "user", content: [{ text: "a fox" }, { image: "data:image/jpeg;base64,QUJD" }] }] },
      parameters: { size: "1024*1024", n: 1 },
    });
  });

  it("turns an HTTP failure into an error result instead of throwing", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const result = await generateDashScopeImages(model, { input: [{ type: "text", text: "x" }] }, { apiKey: "sk-test" });
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /HTTP 500/);
    assert.deepEqual(result.output, []);
  });

  it("reports a missing key as an error result", async () => {
    const result = await generateDashScopeImages(model, { input: [{ type: "text", text: "x" }] }, {});
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /No API key/);
  });

  it("reports a response with no image and no text as an error", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ output: { choices: [] } }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const result = await generateDashScopeImages(model, { input: [{ type: "text", text: "x" }] }, { apiKey: "sk-test" });
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /no image and no text/);
  });

  it("downloadImage fails loudly on a non-ok download", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    await assert.rejects(() => downloadImage("https://img.example/x.png"), /HTTP 404/);
  });
});

describe("tool parameter mapping", () => {
  it("picks the requested model, else the configured default, else the recommended family", () => {
    assert.equal(pickImageModel({ requested: "z-image-turbo", defaultModel: "qwen-image-plus", catalogIds: [] }), "z-image-turbo");
    assert.equal(pickImageModel({ defaultModel: "qwen-image-max", catalogIds: [] }), "qwen-image-max");
    assert.equal(pickImageModel({ catalogIds: ["z-image-turbo", "qwen-image-plus"] }), "qwen-image-plus");
    assert.equal(pickImageModel({ catalogIds: ["z-image-turbo"] }), "z-image-turbo");
    assert.equal(pickImageModel({ catalogIds: [] }), DEFAULT_IMAGE_MODEL);
  });

  it("prefers the documented qwen-image-plus fallback over a bigger qwen-image family id", () => {
    // The tool schema and README promise qwen-image-plus; the curated order
    // starts with qwen-image-3.0-pro, so the fallback must be explicit.
    assert.equal(pickImageModel({ catalogIds: ["qwen-image-3.0-pro", "qwen-image-plus"] }), "qwen-image-plus");
  });

  it("names the editor models that need reference images", () => {
    assert.equal(isImageEditModel("qwen-image-edit-plus"), true);
    assert.equal(isImageEditModel("qwen-image-3.0"), true);
    assert.equal(isImageEditModel("qwen-image-plus"), false);
    assert.equal(validateEditorReferences("qwen-image-edit-plus", 1), undefined);
    assert.match(validateEditorReferences("qwen-image-edit-plus", 0) ?? "", /image editor and needs 1–3 reference images/);
    assert.equal(validateEditorReferences("qwen-image-plus", 0), undefined);
  });

  it("validates metadata in one shared reader", () => {
    assert.deepEqual(readImageMetadata(undefined), {});
    assert.deepEqual(readImageMetadata({}), {
      size: undefined, n: undefined, seed: undefined, negativePrompt: undefined,
      watermark: undefined, promptExtend: undefined, promptExtendMode: undefined, enableThinking: undefined,
    });
    const meta = readImageMetadata({ size: "1*1", n: "not a number", promptExtendMode: "bogus", watermark: false });
    assert.equal(meta.size, "1*1");
    assert.equal(meta.n, undefined);
    assert.equal(meta.promptExtendMode, undefined);
    assert.equal(meta.watermark, false);
  });

  it("maps snake_case tool parameters onto the provider metadata", () => {
    assert.deepEqual(imageMetadataFrom({
      size: "1024*1024",
      n: 2,
      seed: 3,
      negative_prompt: "blurry",
      watermark: false,
      prompt_extend: true,
      prompt_extend_mode: "agent",
      enable_thinking: true,
    }), {
      size: "1024*1024",
      n: 2,
      seed: 3,
      negativePrompt: "blurry",
      watermark: false,
      promptExtend: true,
      promptExtendMode: "agent",
      enableThinking: true,
    });
    assert.deepEqual(imageMetadataFrom({}), {
      size: undefined, n: undefined, seed: undefined, negativePrompt: undefined,
      watermark: undefined, promptExtend: undefined, promptExtendMode: undefined, enableThinking: undefined,
    });
  });

  it("rejects more than three references before spending a call", () => {
    assert.equal(validateImageReferences(3), undefined);
    assert.match(validateImageReferences(4) ?? "", /at most 3/);
  });

  it("declares parameters the tool actually reads", () => {
    assert.deepEqual(ALIBABA_IMAGE_PARAMETERS.required, ["task"]);
    for (const key of ["model", "task", "images", "size", "n", "seed", "negative_prompt", "watermark", "prompt_extend", "prompt_extend_mode", "enable_thinking", "save"]) {
      assert.ok(key in ALIBABA_IMAGE_PARAMETERS.properties, `missing parameter ${key}`);
    }
  });
});

describe("reference resolution", () => {
  let tmp: string;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-alibaba-img-")); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("reads a local file as base64 with a MIME type by extension", () => {
    const file = path.join(tmp, "ref.png");
    fs.writeFileSync(file, Buffer.from([9, 8, 7]));
    const ref = resolveImageReference(file);
    assert.equal(ref.mimeType, "image/png");
    assert.equal(ref.data, Buffer.from([9, 8, 7]).toString("base64"));
  });

  it("parses a data: URL", () => {
    assert.deepEqual(resolveImageReference("data:image/webp;base64,QUJD"), { mimeType: "image/webp", data: "QUJD" });
  });

  it("rejects a remote URL, which the host's image input cannot carry", () => {
    assert.throws(() => resolveImageReference("https://example.com/x.png"), /remote image URLs/);
    assert.throws(() => resolveImageReferences([path.join(tmp, "missing.png")]), /could not read reference image/);
  });
});

describe("/alibaba image argument parsing", () => {
  it("tokenizes quoted arguments", () => {
    assert.deepEqual(tokenizeImageArgs('a "b c" --size \'1024*1024\''), ["a", "b c", "--size", "1024*1024"]);
  });

  it("parses the prompt and every supported flag", () => {
    const parsed = parseImageCommand('a red fox --model qwen-image-plus --size 1024*1024 --n 2 --seed 7 --negative blurry --no-watermark --prompt-extend-mode agent --thinking --save out.png');
    assert.ok(!("error" in parsed));
    if ("error" in parsed) return;
    assert.equal(parsed.prompt, "a red fox");
    assert.equal(parsed.model, "qwen-image-plus");
    assert.equal(parsed.size, "1024*1024");
    assert.equal(parsed.n, 2);
    assert.equal(parsed.seed, 7);
    assert.equal(parsed.negativePrompt, "blurry");
    assert.equal(parsed.watermark, false);
    assert.equal(parsed.promptExtendMode, "agent");
    assert.equal(parsed.enableThinking, true);
    assert.equal(parsed.save, "out.png");
  });

  it("joins multiple prompt tokens and supports --flag=value", () => {
    const parsed = parseImageCommand('two cats "--size=512*512"');
    assert.ok(!("error" in parsed));
    if ("error" in parsed) return;
    assert.equal(parsed.prompt, "two cats");
    assert.equal(parsed.size, "512*512");
  });

  it("refuses an empty prompt and unknown flags", () => {
    assert.ok("error" in parseImageCommand(""));
    assert.ok("error" in parseImageCommand("--nope x"));
    assert.ok("error" in parseImageCommand("a cat --n abc"));
    assert.ok("error" in parseImageCommand('a cat --prompt-extend-mode fast'));
  });

  it("collects up to three --image references and refuses more", () => {
    const parsed = parseImageCommand("edit it --image a.png --image b.png --image c.png");
    assert.ok(!("error" in parsed));
    if ("error" in parsed) return;
    assert.deepEqual(parsed.images, ["a.png", "b.png", "c.png"]);
    assert.ok("error" in parseImageCommand("edit --image a --image b --image c --image d"));
  });
});
