#!/usr/bin/env python3
"""DashScope context-cache probe — reproducible provider data for
docs/notes/2026-10-07-long-session-cache-provider-data-and-options.md.

Reads the Cloud key from ~/.pi/agent/auth.json and the bound workspace domain
from ~/.pi/agent/alibaba-config.json (never printed). Sends ~18 small requests
(~90k tokens total, well under 0.5 CNY at qwen3.8-max-0902 list prices) and
appends one JSON line per request to --out.

Phases
  C1..C4  session cache ON: create, hit, renewal chain at +4.5/+9.5 min,
          expiry check 5.5 min after the last hit
  C5..C6  implicit (header OFF): create/hit, 128-token block granularity
  C7..C8  Chat Completions + cache_control marker: create/hit
  C9..C12 scope: same bytes with a different prompt_cache_key, then with the
          header absent / disabled (explicit and implicit are separate stores)
  C13..C15 control: a brand-new unique prefix under implicit caching, to prove
          implicit hits are exact-prefix (one earlier run reported a hit for a
          never-sent prefix; see the note, §1.3)

Usage:  python3 2026-10-07-dashscope-cache-probe.py [--model ID] [--out FILE]
        [--skip-ttl]     # skip the ~15 min renewal/expiry chain
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import ssl
import time
import urllib.error
import urllib.request
import uuid

try:
    import certifi
except ImportError:  # pragma: no cover
    raise SystemExit("this probe needs certifi: python3 -m pip install certifi")

HOME = os.path.expanduser("~")
RESPONSES_PATH = "/compatible-mode/v1/responses"
COMPLETIONS_PATH = "/compatible-mode/v1/chat/completions"
QUESTION = "Reply with the single word: ok"
FILLER = (
    "Context caching reduces repeated prefill work when consecutive requests share a long prefix. "
    "The probe paragraph below is deterministic filler used only to cross the 1024-token minimum. "
)


def credentials() -> tuple[str, str]:
    key = json.load(open(f"{HOME}/.pi/agent/auth.json"))["alibaba-cloud"]["key"]
    domain = json.load(open(f"{HOME}/.pi/agent/alibaba-config.json"))["cloudDomain"]
    return key, domain


def prompt(tag: str, paragraphs: int = 60) -> str:
    """~4.5k tokens of stable text; the tag makes each variant a different prefix."""
    return "\n".join(
        f"{i:04d} [{tag}] {FILLER}"
        f"Block {i} of the synthetic prefix; it never changes between probe requests, "
        f"so any cache hit must come from the shared prefix rather than the question tail."
        for i in range(paragraphs)
    )


def unique_prompt(nonce: str, paragraphs: int = 60) -> str:
    return "\n".join(
        f"{i:04d} nonce-{nonce}-{i:04d} The quick brown fox jumps over the lazy dog while "
        f"a completely unrelated sentence about maritime logistics and the price of copper "
        f"follows it, ensuring this prefix was never sent to the endpoint before."
        for i in range(paragraphs)
    )


class Probe:
    def __init__(self, model: str, out: str):
        self.key, self.domain = credentials()
        self.model = model
        self.out = out
        self.ctx = ssl.create_default_context(cafile=certifi.where())
        self.nonce = uuid.uuid4().hex

    def post(self, path: str, payload: dict, headers: dict, timeout: int = 180):
        hdrs = {"Authorization": f"Bearer {self.key}", "Content-Type": "application/json", **headers}
        req = urllib.request.Request(
            f"https://{self.domain}{path}", data=json.dumps(payload).encode(), headers=hdrs, method="POST"
        )
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self.ctx) as resp:
                raw, err = resp.read().decode(), None
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            err = f"HTTP {e.code}: {raw[:200]}"
        except Exception as e:
            raw, err = "", f"{type(e).__name__}: {e}"
        return self.usage(raw), err, round(time.time() - t0, 1)

    @staticmethod
    def usage(raw: str):
        """Last usage object in an SSE stream (Responses nests it under `response`)."""
        usage = None
        for line in raw.splitlines():
            if not line.startswith("data:"):
                continue
            chunk = line[5:].strip()
            if not chunk or chunk == "[DONE]":
                continue
            try:
                ev = json.loads(chunk)
            except Exception:
                continue
            if isinstance(ev, dict):
                if ev.get("usage"):
                    usage = ev["usage"]
                nested = ev.get("response")
                if isinstance(nested, dict) and nested.get("usage"):
                    usage = nested["usage"]
        return usage

    def responses(self, text: str, cache_key: str, header: str | None) -> tuple[dict, dict]:
        payload = {
            "model": self.model,
            "input": [
                {"role": "system", "content": [{"type": "input_text", "text": text}]},
                {"role": "user", "content": [{"type": "input_text", "text": QUESTION}]},
            ],
            "stream": True,
            "store": False,  # what pi-ai sends
            "prompt_cache_key": cache_key,
            "max_output_tokens": 16,  # pi-ai's OPENAI_RESPONSES_MIN_OUTPUT_TOKENS floor
            "reasoning": {"effort": "low", "summary": "auto"},
        }
        headers = {"x-dashscope-session-cache": header} if header else {}
        return payload, headers

    def completions(self, text: str) -> tuple[dict, dict]:
        payload = {
            "model": self.model,
            "stream": True,
            "stream_options": {"include_usage": True},
            "max_tokens": 16,
            "messages": [
                {"role": "system", "content": [
                    {"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]},
                {"role": "user", "content": QUESTION},
            ],
        }
        return payload, {}

    def record(self, phase: str, usage, err, dur: float, note: str = "") -> None:
        u = usage or {}
        details = u.get("input_tokens_details") or {}
        xdetails = ((u.get("x_details") or [{}])[0]).get("prompt_tokens_details") or {}
        prompt_details = u.get("prompt_tokens_details") or {}
        row = {
            "phase": phase,
            "at": datetime.datetime.now(datetime.UTC).isoformat(),
            "model": self.model,
            "request_s": dur,
            "error": err,
            "note": note,
            "input_tokens": u.get("input_tokens", u.get("prompt_tokens")),
            "output_tokens": u.get("output_tokens", u.get("completion_tokens")),
            "cached_top": details.get("cached_tokens"),
            "cached_prompt_details": prompt_details.get("cached_tokens", xdetails.get("cached_tokens")),
            "creation": prompt_details.get("cache_creation_input_tokens",
                                           xdetails.get("cache_creation_input_tokens")),
            "cache_type": xdetails.get("cache_type", prompt_details.get("cache_type")),
            "raw_usage": u,
        }
        with open(self.out, "a") as fh:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(f"{phase:<22} in={row['input_tokens']} cached={row['cached_top']}/"
              f"{row['cached_prompt_details']} creation={row['creation']} "
              f"type={row['cache_type']} {dur}s {err or ''}", flush=True)

    def shoot(self, phase: str, path: str, payload: dict, headers: dict, note: str = "") -> None:
        self.record(phase, *self.post(path, payload, headers), note=note)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="qwen3.8-max-0902")
    ap.add_argument("--out", default="/tmp/ds-probe.jsonl")
    ap.add_argument("--skip-ttl", action="store_true", help="skip the ~15 min renewal/expiry chain")
    args = ap.parse_args()

    p = Probe(args.model, args.out)
    a, b, c = prompt("A"), prompt("B"), prompt("C")

    # C1-C2: session cache creates an exact explicit block and hits it
    p.shoot("C1-session-create", RESPONSES_PATH, *p.responses(a, "probe-a1", "enable"))
    time.sleep(25)
    p.shoot("C2-session-hit", RESPONSES_PATH, *p.responses(a, "probe-a1", "enable"))

    if not args.skip_ttl:
        # C3-C4: TTL is reset on hit — C4 is 9.5 min after creation and must still hit
        time.sleep(250)
        p.shoot("C3-renew-4.5m", RESPONSES_PATH, *p.responses(a, "probe-a1", "enable"))
        time.sleep(280)
        p.shoot("C4-renew-9.5m", RESPONSES_PATH, *p.responses(a, "probe-a1", "enable"))
        # C5: 5.5 min after the last hit the block is gone and is re-created
        time.sleep(330)
        p.shoot("C5-expire-15m", RESPONSES_PATH, *p.responses(a, "probe-a1", "enable"))

    # C6-C7: implicit cache (header off) — block-quantized, own store
    p.shoot("C6-implicit-create", RESPONSES_PATH, *p.responses(b, "probe-b1", "disable"),
            note="first ever request of this prefix: cached must be 0")
    time.sleep(25)
    p.shoot("C7-implicit-hit", RESPONSES_PATH, *p.responses(b, "probe-b2", "disable"))

    # C8-C9: explicit cache_control through Chat Completions
    p.shoot("C8-cc-create", COMPLETIONS_PATH, *p.completions(a))
    time.sleep(25)
    p.shoot("C9-cc-hit", COMPLETIONS_PATH, *p.completions(a))

    # C10-C12: scope — cache key and header do not scope the explicit store
    p.shoot("C10-other-cache-key", RESPONSES_PATH, *p.responses(a, "probe-other-key", "enable"),
            note="hit here proves the cache is prefix-scoped, not key-scoped")
    time.sleep(25)
    p.shoot("C11-no-header", RESPONSES_PATH, *p.responses(a, "probe-other-key", None))
    time.sleep(25)
    p.shoot("C12-header-disable", RESPONSES_PATH, *p.responses(a, "probe-key-z", "disable"))

    # C13-C15: control for the C6 anomaly — a never-sent prefix must report 0
    uniq = unique_prompt(p.nonce)
    p.shoot("C13-unique-implicit-1st", RESPONSES_PATH, *p.responses(uniq, f"probe-{p.nonce}-1", None))
    time.sleep(25)
    p.shoot("C14-unique-implicit-2nd", RESPONSES_PATH, *p.responses(uniq, f"probe-{p.nonce}-2", None))
    time.sleep(5)
    p.shoot("C15-unique-session-1st", RESPONSES_PATH, *p.responses(uniq, f"probe-{p.nonce}-3", "enable"))
    time.sleep(25)
    p.shoot("C16-unique-session-2nd", RESPONSES_PATH, *p.responses(uniq, f"probe-{p.nonce}-4", "enable"))
    p.record("DONE", None, None, 0.0)


if __name__ == "__main__":
    main()
