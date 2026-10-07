#!/usr/bin/env python3
"""DashScope input/output cap probe — measures what the endpoint really accepts.

Companion to 2026-10-07-dashscope-input-caps.md. Reads the Cloud key from
~/.pi/agent/auth.json and the bound domain from ~/.pi/agent/alibaba-config.json
(neither is printed) and appends one JSON line per request to --out.

Three measurements, in increasing cost:

  request   Oversized payload to Chat Completions and to the Anthropic shape.
            Rejected *before billing*, and the 400 text quotes the exact cap
            ("Range of input length should be [1, N]"). Free, ~4 s per model.
  output    max_tokens above the catalog's max_output_tokens with thinking on.
            Also free: the 400 quotes "Range of max_tokens should be [1, N]".
  responses The Responses endpoint does not reject, it silently truncates and
            reports the truncated size in usage.input_tokens — so one oversized
            request *is* the measurement, and it costs cap x input price
            (0.02-10 CNY depending on the family).

Payload text is real content (a repo, pi's docs, session logs), not synthesized
filler, so the token/char ratio matches a real transcript.

Usage:
  python3 2026-10-07-dashscope-input-caps-probe.py --models qwen3.8-max-0902,glm-5.1
  python3 ... --mode request,output          # free measurements only (default)
  python3 ... --mode responses --models qwen3.5-plus   # costs one truncated request
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import ssl
import time
import urllib.error
import urllib.request

try:
    import certifi
    SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:  # pragma: no cover
    raise SystemExit("this probe needs certifi: python3 -m pip install certifi")

HOME = os.path.expanduser("~")
# pi's own override, so the probe can be pointed at a scratch agent dir.
AGENT_DIR = os.environ.get("PI_CODING_AGENT_DIR") or f"{HOME}/.pi/agent"
CORPUS_ROOTS = [
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    AGENT_DIR + "/sessions",
]
CHARS_PER_TOKEN = 4.2  # overshoots on purpose: the point is to exceed the cap


def credentials() -> tuple[str, str]:
    key = json.load(open(f"{AGENT_DIR}/auth.json"))["alibaba-cloud"]["key"]
    domain = json.load(open(f"{AGENT_DIR}/alibaba-config.json"))["cloudDomain"]
    return key, domain


def catalog() -> dict:
    """`model_info` rows from the private snapshot: context windows and output caps."""
    try:
        blob = json.load(open(f"{AGENT_DIR}/alibaba-models.cache.json"))
    except Exception:
        return {}
    entries = (blob.get("cloud") or {}).get("catalog")
    if not isinstance(entries, dict):
        return {}
    return {mid: (entry or {}).get("limits") or {} for mid, entry in entries.items()}


def corpus(chars: int) -> str:
    parts, total, files = [], 0, []
    for root in CORPUS_ROOTS:
        for p in glob.glob(root + "/**/*", recursive=True):
            if os.path.isfile(p) and p.endswith((".md", ".ts", ".js", ".jsonl")) and os.path.getsize(p) < 3_000_000:
                files.append(p)
    files.sort(key=lambda p: -os.path.getsize(p))
    for p in files:
        try:
            chunk = open(p, encoding="utf-8", errors="ignore").read()
        except Exception:
            continue
        parts.append(chunk)
        total += len(chunk)
        if total >= chars:
            break
    text = "".join(parts)
    if not text:
        raise SystemExit(f"no corpus found under {CORPUS_ROOTS}")
    while len(text) < chars:
        text += text
    return text[:chars]


def post(url: str, body: dict, key: str, headers: dict | None = None, timeout: int = 1200):
    h = {"Content-Type": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=h)
    started = time.time()
    try:
        with urllib.request.urlopen(req, context=SSL, timeout=timeout) as r:
            return json.loads(r.read()), round(time.time() - started, 1), None
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            parsed = json.loads(raw)
            msg = parsed.get("message") or parsed.get("error", {}).get("message") or raw
        except Exception:
            msg = raw
        return None, round(time.time() - started, 1), f"HTTP {e.code}: {msg}"[:260]
    except Exception as e:  # network/timeout
        return None, round(time.time() - started, 1), f"{type(e).__name__}: {e}"[:200]


def quoted_range(err: str | None) -> int | None:
    if not err:
        return None
    m = re.search(r"\[1,\s*(\d+)\]", err)
    return int(m.group(1)) if m else None


def probe_request(model: str, ctx: int, key: str, domain: str, out) -> None:
    """Enforced input cap on both rejecting shapes, read from the 400 text."""
    text = corpus(int(ctx * 1.15 * CHARS_PER_TOKEN)) + "\nReply: ok"
    for shape, url, body, headers in [
        ("completions", f"https://{domain}/compatible-mode/v1/chat/completions",
         {"model": model, "messages": [{"role": "user", "content": text}], "max_tokens": 8, "stream": False},
         {"Authorization": f"Bearer {key}"}),
        ("anthropic", f"https://{domain}/apps/anthropic/v1/messages",
         {"model": model, "max_tokens": 16, "messages": [{"role": "user", "content": text}]},
         {"x-api-key": key, "anthropic-version": "2023-06-01"}),
    ]:
        j, s, err = post(url, body, key, headers)
        cap = quoted_range(err)
        rec = {"model": model, "mode": "request", "shape": shape, "ctx": ctx, "cap": cap,
               "s": s, "err": err, "tokens": ((j or {}).get("usage") or {}).get("prompt_tokens")
               or ((j or {}).get("usage") or {}).get("input_tokens")}
        out.write(json.dumps(rec, ensure_ascii=False) + "\n"); out.flush()
        print(f"  {model:<24} {shape:<12} ctx={ctx:<9} cap={cap or 'ACCEPTED (raise --mult)'} "
              f"tokens={rec['tokens']} ({s}s)", flush=True)


def probe_output(model: str, max_out: int, key: str, domain: str, out) -> None:
    """Is reasoning_max_output_tokens a hard cap? Send the catalog max with thinking on."""
    body = {"model": model, "messages": [{"role": "user", "content": "Reply with the single word: ok"}],
            "max_tokens": max_out, "stream": False, "enable_thinking": True}
    j, s, err = post(f"https://{domain}/compatible-mode/v1/chat/completions", body, key,
                     {"Authorization": f"Bearer {key}"})
    cap = quoted_range(err)
    out.write(json.dumps({"model": model, "mode": "output", "sent": max_out, "cap": cap, "s": s,
                          "err": err, "ok": err is None}, ensure_ascii=False) + "\n"); out.flush()
    print(f"  {model:<24} output       max_tokens={max_out:<8} → "
          f"{'accepted' if err is None else f'cap={cap}'} ({s}s)", flush=True)


def probe_responses(model: str, ctx: int, key: str, domain: str, out) -> None:
    """The Responses truncation point: what an oversized request reports as input."""
    text = corpus(int(ctx * 1.15 * CHARS_PER_TOKEN)) + "\nReply: ok"
    body = {"model": model, "input": [{"role": "user", "content": [{"type": "input_text", "text": text}]}],
            "max_output_tokens": 16, "stream": False, "store": False}
    j, s, err = post(f"https://{domain}/compatible-mode/v1/responses", body, key,
                     {"Authorization": f"Bearer {key}", "x-dashscope-session-cache": "enable"})
    u = (j or {}).get("usage") or {}
    cap = u.get("input_tokens")
    out.write(json.dumps({"model": model, "mode": "responses", "ctx": ctx, "cap": cap, "s": s,
                          "err": err}, ensure_ascii=False) + "\n"); out.flush()
    print(f"  {model:<24} responses  ctx={ctx:<9} sent~{int(ctx * 1.15)} → input_tokens={cap} ({s}s)"
          f"{' COSTS: billed on the truncated input' if cap else ''}", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default="qwen3.8-max-0902")
    ap.add_argument("--mode", default="request,output", help="request,output,responses")
    ap.add_argument("--out", default="/tmp/dashscope-caps.jsonl")
    args = ap.parse_args()

    key, domain = credentials()
    limits = catalog()
    modes = {m.strip() for m in args.mode.split(",")}
    print(f"# domain {domain}  models={args.models}  modes={sorted(modes)}")
    if "responses" in modes:
        print("# warning: every responses probe pays for one truncated request")
    with open(args.out, "a") as out:
        for model in [m.strip() for m in args.models.split(",") if m.strip()]:
            info = limits.get(model) or {}
            ctx = info.get("contextWindow") or 262_144
            if not limits.get(model):
                print(f"# {model}: no catalog row locally, assuming ctx={ctx} (pass a real one via the snapshot)")
            if "request" in modes:
                probe_request(model, ctx, key, domain, out)
            if "output" in modes and info.get("maxOutput"):
                probe_output(model, info["maxOutput"], key, domain, out)
            if "responses" in modes:
                probe_responses(model, ctx, key, domain, out)


if __name__ == "__main__":
    main()
