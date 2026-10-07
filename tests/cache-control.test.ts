import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { injectCacheControl } from "../extensions/cache-control.ts";

const EPHEMERAL = { type: "ephemeral" };

// A transcript shaped like pi's Completions payload: system prompt (which is
// where DashScope serializes the tool definitions), history, and a tool result
// as the newest message.
function payload(messages: unknown[], extra: Record<string, unknown> = {}) {
  return { model: "kimi-k2.6", messages, max_tokens: 8192, stream: true, ...extra };
}

const markers = (result: unknown): number =>
  JSON.stringify(result ?? {}).split("cache_control").length - 1;

describe("injectCacheControl", () => {
  it("marks the system message and the last markable message", () => {
    const res = injectCacheControl(payload([
      { role: "system", content: "You are pi." },
      { role: "user", content: "Read the file." },
      { role: "assistant", content: "Done." },
      { role: "user", content: "Now the tests." },
    ]));
    assert.equal(res?.markers, 2);
    const messages = (res?.payload as { messages: any[] }).messages;
    assert.deepEqual(messages[0].content, [{ type: "text", text: "You are pi.", cache_control: EPHEMERAL }]);
    assert.deepEqual(messages[3].content, [{ type: "text", text: "Now the tests.", cache_control: EPHEMERAL }]);
    // Everything else is untouched.
    assert.equal(messages[1].content, "Read the file.");
    assert.equal((res?.payload as any).max_tokens, 8192);
    assert.equal((res?.payload as any).stream, true);
  });

  it("marks the last part of content that is already a part array", () => {
    const res = injectCacheControl(payload([
      { role: "system", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      { role: "user", content: [{ type: "text", text: "q" }] },
    ]));
    const messages = (res?.payload as { messages: any[] }).messages;
    assert.deepEqual(messages[0].content[1], { type: "text", text: "b", cache_control: EPHEMERAL });
    assert.equal("cache_control" in messages[0].content[0], false);
  });

  it("skips tool results: array content is not documented for that role", () => {
    const res = injectCacheControl(payload([
      { role: "system", content: "sys" },
      { role: "user", content: "run it" },
      { role: "assistant", content: "ok" },
      { role: "tool", tool_call_id: "c1", content: "output" },
    ]));
    const messages = (res?.payload as { messages: any[] }).messages;
    assert.equal(messages[3].content, "output");
    assert.deepEqual(messages[2].content, [{ type: "text", text: "ok", cache_control: EPHEMERAL }]);
    assert.equal(res?.markers, 2);
  });

  it("marks only the system message when nothing else is markable", () => {
    const res = injectCacheControl(payload([{ role: "system", content: "sys" }]));
    assert.equal(res?.markers, 1);
    // An image-only tail cannot carry a marker either.
    const image = injectCacheControl(payload([
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:…" } }] },
    ]));
    assert.equal(image?.markers, 1);
  });

  it("never stacks markers on a payload that already has one", () => {
    const already = payload([
      { role: "system", content: [{ type: "text", text: "sys", cache_control: EPHEMERAL }] },
      { role: "user", content: "hi" },
    ]);
    assert.equal(injectCacheControl(already), undefined);
  });

  it("stays under the provider's four-marker cap", () => {
    const res = injectCacheControl(payload([
      { role: "system", content: "sys" },
      ...Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` })),
    ]));
    assert.equal(res?.markers, 2);
    assert.equal(markers(res?.payload), 2);
  });

  it("leaves payloads it cannot read alone", () => {
    assert.equal(injectCacheControl(undefined), undefined);
    assert.equal(injectCacheControl({ model: "x" }), undefined);
    assert.equal(injectCacheControl(payload([])), undefined);
    assert.equal(injectCacheControl(payload([{ role: "user", content: 42 }])), undefined);
  });

  it("does not mutate the payload pi handed over", () => {
    const original = payload([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    const snapshot = JSON.stringify(original);
    injectCacheControl(original);
    assert.equal(JSON.stringify(original), snapshot);
  });
});
