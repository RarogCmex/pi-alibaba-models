// Cache-renewal probe — reproducible provider data for
// docs/notes/2026-10-11-cache-warm-blind-probes.md §6.
//
// Question: does a *warm replay* (the shape extensions/cache-warm.ts sends —
// `stream: false`, `max_output_tokens: 16`, otherwise the captured request
// verbatim) renew a DashScope cache block, or only ride one that a real
// streaming turn left behind? Production telemetry could not answer it: 27
// replays of a 376 453-token deepseek-v4.1-flash context all reported
// cached_tokens 0–4 096 on 2026-10-09, and no real turn followed to test
// whether anything had been left behind.
//
// Reads the Cloud key from ~/.pi/agent/auth.json and the bound workspace domain
// from ~/.pi/agent/alibaba-config.json (neither is printed). Appends one JSON
// line per request to --out (default
// docs/notes/2026-10-11-cache-warm-renewal-results.jsonl).
//
// Phases, one payload per (model, size) built once so every call in a phase is
// byte-identical, with a unique nonce so a phase cannot ride an earlier block:
//   A  streaming request — the shape of a real turn; creates the block
//   B  warm replay +330 s — past the documented 300 s TTL: does A's block
//      survive, and does the replay report cached_tokens at all?
//   C  warm replay +216 s — the engine's own refresh interval: did **B** renew?
//   D  warm replay +216 s — did **C** renew? This is the question.
//
// Sizes: `shape` ≈ 4–7k tokens and no waiting — it only asks whether each wire
// shape reports cache counters at all (two non-streaming calls 3 s apart, then
// one streaming call); `small` ≈ 6–7k tokens on deepseek-v4.1-flash,
// glm-5.3 and qwen3.8-max-0902 (≈ 84k tokens total); `big` ≈ 356k tokens on
// deepseek-v4.1-flash (≈ 1.43 M tokens — the size that went blind in
// production). Wall time is the cost that matters for the renewal phases: 14 min
// per model, because the sleeps are the experiment.
//
//   node docs/notes/2026-10-11-cache-warm-renewal-probe.mjs --size shape
//   node docs/notes/2026-10-11-cache-warm-renewal-probe.mjs --size small
//   node docs/notes/2026-10-11-cache-warm-renewal-probe.mjs --size big --out /tmp/big.jsonl
//
// Reading the result: C and D hit ⇒ a warm replay renews, so a blind streak in
// production is a provider-side condition, not the replay shape (this is what
// the 2026-10-11 run found at both sizes). C or D missing while B hit ⇒ the
// replay rides a block but cannot recreate it, and warming that context is
// structurally useless — which is what MAX_BLIND_WARMS assumes.

import fs from "node:fs";
import path from "node:path";

const HOME = process.env.HOME;
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const SIZE = opt("size", "small");
const OUT = opt("out", path.join(path.dirname(new URL(import.meta.url).pathname), "2026-10-11-cache-warm-renewal-results.jsonl"));

const auth = JSON.parse(fs.readFileSync(path.join(HOME, ".pi/agent/auth.json"), "utf8"));
const key = auth["alibaba-cloud"]?.key;
if (!key) throw new Error("no alibaba-cloud key in ~/.pi/agent/auth.json");
const cfg = JSON.parse(fs.readFileSync(path.join(HOME, ".pi/agent/alibaba-config.json"), "utf8"));
const base = `https://${cfg.cloudDomain}/compatible-mode/v1/responses`;

const record = (o) => {
  fs.appendFileSync(OUT, `${JSON.stringify(o)}\n`);
  console.log(JSON.stringify(o));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One payload per phase, reused by every call in it.
const payloadFor = (model, repeats, nonce) => ({
  model,
  stream: false,
  max_output_tokens: 16,
  input: [{
    role: "user",
    content: `Reply with the single word OK.\n\nRenewal probe ${nonce} ${model}. `
      + `Cache probe filler with enough tokens to be worth caching. `.repeat(repeats),
  }],
});

async function call(body, phase, model, size, startedAt) {
  const t0 = Date.now();
  const res = await fetch(base, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  let usage, status, created;
  if (body.stream) {
    // The Responses stream ends in response.completed, or response.incomplete
    // when the 16-token cap cuts a reasoning model off; usage rides either.
    for (const line of (await res.text()).split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const d = JSON.parse(line.slice(5).trim());
        if (d.type === "response.completed" || d.type === "response.incomplete") {
          usage = d.response?.usage;
          status = d.response?.status;
        }
      } catch { /* keep-alive and partial frames */ }
    }
  } else {
    const j = await res.json().catch(() => null);
    usage = j?.usage;
    status = j?.status;
  }
  created = usage?.x_details?.[0]?.prompt_tokens_details?.cache_creation_input_tokens;
  record({
    ts: startedAt, phase, model, size, http: res.status, ms, status,
    promptTokens: usage?.input_tokens ?? null,
    cached: usage?.input_tokens_details?.cached_tokens ?? null,
    created: created ?? null,
    hitRatio: usage?.input_tokens ? Number(((usage.input_tokens_details?.cached_tokens ?? 0) / usage.input_tokens).toFixed(4)) : null,
  });
}

async function phase(model, size, repeats) {
  const nonce = `${size}-${Date.now()}`;
  const fixed = payloadFor(model, repeats, nonce);
  const startedAt = Date.now();
  await call({ ...fixed, stream: true, stream_options: { include_usage: true } }, "A-stream", model, size, Date.now());
  await sleep(330_000);                                    // past the documented 300 s TTL
  await call(fixed, "B-warm+330s", model, size, Date.now());
  await sleep(216_000);                                    // the engine's refresh interval
  await call(fixed, "C-warm+216s", model, size, Date.now());
  await sleep(216_000);
  await call(fixed, "D-warm+216s", model, size, Date.now());
  return startedAt;
}

// Which wire shapes report cache counters at all: create (non-streaming), hit
// (non-streaming, 3 s later — the warm shape), and one streaming call for
// comparison. No waiting, so nothing here says anything about renewal.
async function shapePhase(model, repeats) {
  const size = "shape";
  const nonce = `${size}-${Date.now()}`;
  const fixed = payloadFor(model, repeats, nonce);
  await call(fixed, "S1-create", model, size, Date.now());
  await sleep(3_000);
  await call(fixed, "S2-warm-shape", model, size, Date.now());
  await sleep(1_500);
  await call({ ...fixed, stream: true, stream_options: { include_usage: true } }, "S3-stream", model, size, Date.now());
  await sleep(1_500);
}

if (SIZE === "shape" || SIZE === "both") {
  for (const model of ["deepseek-v4.1-flash", "glm-5.3", "qwen3.8-max-0902"]) {
    await shapePhase(model, 330);
  }
}

if (SIZE === "small" || SIZE === "both") {
  for (const model of ["deepseek-v4.1-flash", "glm-5.3", "qwen3.8-max-0902"]) {
    await phase(model, "small", 330);                      // ≈ 6–7k tokens
  }
}
if (SIZE === "big" || SIZE === "both") {
  await phase("deepseek-v4.1-flash", "big", 15_500);       // ≈ 356k tokens
}
console.log(`done → ${OUT}`);
