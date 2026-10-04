// Model-facing presentation shared by the two Alibaba tools: the one namespace
// that groups them in the codemode listing, their MCP-style annotations, the
// Sidecar's output schema, and the register-tool type aliases both registration
// sites use. Kept out of alibaba.ts so the provider/catalog code and the tool
// surfaces can change for their own reasons.

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Groups both tools under one heading in the codemode listing. */
export const ALIBABA_NAMESPACE = {
  name: "alibaba",
  description:
    "Alibaba DashScope tools: a billed Qwen sidecar (web search, page extraction, " +
    "sandbox computation, image search) and DashScope image generation/editing.",
  instructions:
    "alibaba_tools runs a separate billed Qwen sidecar request (Cloud key required). " +
    "Use action=search for quick current-web lookups, action=research for page extraction " +
    "or multi-source synthesis (slower, costlier), action=code for a sandbox, action=image " +
    "for image search. It is not for local files or shell commands.\n" +
    "alibaba_image generates or edits an image with a DashScope image model; prefer the " +
    "qwen-image-* family. Pass 0–3 local reference images to edit; pass `save` to persist " +
    "the bytes (nothing is written otherwise). Images generated from codemode are not " +
    "persisted unless `save` is set.",
};

export const ALIBABA_TOOLS_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

// `save` can overwrite a file, so the image tool is destructive where the
// Sidecar is not.
export const ALIBABA_IMAGE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export const ALIBABA_TOOLS_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    action: { type: "string" as const },
    result: { type: "string" as const },
    sources: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          url: { type: "string" as const },
          title: { type: "string" as const },
          snippet: { type: "string" as const },
        },
      },
    },
    calls: { type: "array" as const, items: { type: "string" as const } },
    retries: { type: "number" as const },
  },
  required: ["action", "result", "sources", "calls", "retries"],
};

export type RegisterToolDef = Parameters<ExtensionAPI["registerTool"]>[0];
export type ToolExecuteParams = Parameters<RegisterToolDef["execute"]>;
export type ToolUpdate = ToolExecuteParams[3];
export type ToolCtx = ToolExecuteParams[4];
export type ToolResult = AgentToolResult;
