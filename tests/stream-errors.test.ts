import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyStreamError,
  isStreamErrorEvent,
  rewriteFromStreamError,
  streamErrorPrefix,
} from "../extensions/stream-errors.ts";

describe("classifyStreamError — structure, not wording", () => {
  it("classifies an explicit HTTP 429 marker", () => {
    assert.equal(classifyStreamError({ type: "error", _httpStatus: 429, error: { message: "nope" } }), "rate_limit");
    assert.equal(classifyStreamError({ type: "response.failed", response: { status: 429 } }), "rate_limit");
  });

  it("classifies the wrapped `<429>` server_error DashScope sends over HTTP 200", () => {
    assert.equal(
      classifyStreamError({ type: "server_error", message: "InternalError.Algo: <429> Too many requests." }),
      "rate_limit",
    );
  });

  it("classifies rate-limit phrasings DashScope has used", () => {
    assert.equal(classifyStreamError({ type: "error", error: { code: "Throttling.RateQuota" } }), "rate_limit");
    assert.equal(classifyStreamError({ type: "error", error: { code: "limit_requests" } }), "rate_limit");
    assert.equal(classifyStreamError({ type: "error", message: "The request rate limit has been reached" }), "rate_limit");
  });

  it("classifies the backend buffer overflow family as a backend error", () => {
    assert.equal(classifyStreamError({ type: "error", message: "Backend buffer overflow." }), "backend_error");
    assert.equal(classifyStreamError({ type: "server_error", message: "backend buffer overflow" }), "backend_error");
  });

  it("classifies a 5xx status as a backend error", () => {
    assert.equal(classifyStreamError({ type: "error", _httpStatus: 503 }), "backend_error");
    assert.equal(classifyStreamError({ type: "response.failed", response: { status: 500 } }), "backend_error");
  });

  it("never classifies a permanent InvalidParameter error as retryable", () => {
    assert.equal(
      classifyStreamError({ type: "error", message: "InternalError.Algo.InvalidParameter: <429> bad field" }),
      undefined,
    );
  });

  it("ignores successful stream events even when their text mentions a number", () => {
    assert.equal(classifyStreamError({ type: "response.output_text.delta", delta: "call 429 now" }), undefined);
    assert.equal(classifyStreamError({ type: "response.output_text.delta", delta: "too many requests" }), undefined);
    assert.equal(classifyStreamError(undefined), undefined);
    assert.equal(classifyStreamError("nope"), undefined);
  });

  it("recognizes the failures that look like errors at all", () => {
    assert.equal(isStreamErrorEvent({ type: "error" }), true);
    assert.equal(isStreamErrorEvent({ type: "response.failed" }), true);
    assert.equal(isStreamErrorEvent({ type: "response.output_text.delta" }), false);
  });
});

describe("rewriteFromStreamError", () => {
  it("prefixes only when the wording-based matchers would not recognize the message", () => {
    assert.equal(streamErrorPrefix("rate_limit"), "429 ");
    assert.equal(streamErrorPrefix("backend_error"), "server_error ");
    assert.equal(rewriteFromStreamError("something odd happened", "rate_limit"), "429 something odd happened");
    assert.equal(rewriteFromStreamError("something odd happened", "backend_error"), "server_error something odd happened");
  });

  it("does not double-prefix or touch already-retryable text", () => {
    assert.equal(rewriteFromStreamError("429 already prefixed", "rate_limit"), undefined);
    assert.equal(rewriteFromStreamError("server_error already marked", "backend_error"), undefined);
    assert.equal(rewriteFromStreamError("something odd", undefined), undefined);
    assert.equal(rewriteFromStreamError("", "rate_limit"), undefined);
  });
});
