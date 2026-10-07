#!/usr/bin/env python3
"""Does DashScope prompt caching work outside the qwen* line?

For each model, sends the shape this extension actually registers (Responses +
session-cache header, or Chat Completions + cache_control markers) plus, where
interesting, the same shape with the cache opt-in removed. Same unique prefix,
repeated, and reports what the provider billed: cached_tokens / cache_creation.
"""
import json, os, ssl, sys, time, urllib.error, urllib.request, uuid
try:
    import certifi; SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL = ssl.create_default_context()
HOME = os.path.expanduser("~")
KEY = json.load(open(f"{HOME}/.pi/agent/auth.json"))["alibaba-cloud"]["key"]
DOMAIN = json.load(open(f"{HOME}/.pi/agent/alibaba-config.json"))["cloudDomain"]
RESP = f"https://{DOMAIN}/compatible-mode/v1/responses"
CC = f"https://{DOMAIN}/compatible-mode/v1/chat/completions"
FILLER = ("Prompt caching removes repeated prefill work when consecutive requests share a long prefix. "
          "This deterministic filler exists only to push the prompt over the provider's caching minimum. ")
OUT = open(sys.argv[1] if len(sys.argv) > 1 else "/tmp/family-probe.jsonl", "a")

def text(tag, n=45):
    return "\n".join(f"{i:04d} [{tag}] {FILLER}" for i in range(n))

def post(url, body, headers=None):
    h = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=h)
    t = time.time()
    try:
        with urllib.request.urlopen(req, context=SSL, timeout=180) as r:
            return json.loads(r.read()), round(time.time() - t, 1), None
    except urllib.error.HTTPError as e:
        return None, round(time.time() - t, 1), f"HTTP {e.code}: {e.read().decode()[:220]}"
    except Exception as e:
        return None, round(time.time() - t, 1), f"{type(e).__name__}: {e}"

def usage_of(api, j):
    u = (j or {}).get("usage") or {}
    if api == "responses":
        d = ((u.get("x_details") or [{}])[0]).get("prompt_tokens_details") or {}
        return {"prompt": u.get("input_tokens"), "cached": (u.get("input_tokens_details") or {}).get("cached_tokens"),
                "creation": d.get("cache_creation_input_tokens"), "type": d.get("cache_type")}
    d = u.get("prompt_tokens_details") or {}
    return {"prompt": u.get("prompt_tokens"), "cached": d.get("cached_tokens"),
            "creation": d.get("cache_creation_input_tokens"), "type": d.get("cache_type")}

def responses_body(model, tag):
    return {"model": model, "instructions": "You are a terse assistant.",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": text(tag) + "\nReply with one word: ok"}]}],
            "max_output_tokens": 32, "stream": False, "store": False, "prompt_cache_key": f"probe-{tag}"}

def cc_body(model, tag, marker):
    sysmsg = {"role": "system", "content": ([{"type": "text", "text": "You are a terse assistant.",
              **({"cache_control": {"type": "ephemeral"}} if marker else {})}] if marker else "You are a terse assistant.")}
    user = {"role": "user", "content": ([{"type": "text", "text": text(tag) + "\nReply with one word: ok",
            **({"cache_control": {"type": "ephemeral"}} if marker else {})}] if marker else text(tag) + "\nReply with one word: ok")}
    return {"model": model, "messages": [sysmsg, user], "max_tokens": 32, "stream": False}

def run(model, shape, repeats, gap=15):
    tag = uuid.uuid4().hex[:8]
    rec = {"model": model, "shape": shape, "tag": tag, "at": time.strftime("%H:%M:%S"), "calls": []}
    for i in range(repeats):
        if i: time.sleep(gap)
        if shape.startswith("responses"):
            hdr = {} if shape == "responses-noheader" else {"x-dashscope-session-cache": "enable"}
            if shape == "responses-disable": hdr = {"x-dashscope-session-cache": "disable"}
            j, s, err = post(RESP, responses_body(model, tag), hdr)
        else:
            marker = shape == "completions-markers"
            j, s, err = post(CC, cc_body(model, tag, marker))
        u = usage_of("responses" if shape.startswith("responses") else "cc", j)
        rec["calls"].append({"i": i, "s": s, "err": err, **u})
        print(f"  {model:<24} {shape:<22} #{i} {s:>5}s prompt={u['prompt']} cached={u['cached']} creation={u['creation']} type={u['type']}"
              + (f" ERR {err}" if err else ""), flush=True)
        if err and i == 0:
            break  # unsupported shape: no point repeating
    OUT.write(json.dumps(rec, ensure_ascii=False) + "\n"); OUT.flush()
    return rec

PLAN = [
    # (model, shape, repeats) — shape is what the extension registers for it
    ("glm-5.3",              "responses-header",   3),
    ("glm-5.3",              "responses-disable",  2),
    ("glm-4.6",              "responses-header",   3),
    ("kimi-k3",              "responses-header",   3),
    ("deepseek-v4.1-flash",  "responses-header",   3),
    ("deepseek-v4-pro",      "responses-header",   3),
    ("MiniMax-M2.1",         "responses-header",   3),
    ("glm-5.1",              "completions-markers",2),
    ("kimi-k2.5",            "completions-markers",2),
    ("kimi-k2.7-code",       "completions-markers",2),
    ("deepseek-v3.2",        "completions-markers",2),
    ("MiniMax/MiniMax-M2.5", "completions-plain",  3),
    ("qwen3.8-flash",        "responses-header",   2),
]
print(f"# domain {DOMAIN}\n# {len(PLAN)} model/shape pairs", flush=True)
for model, shape, n in PLAN:
    run(model, shape, n)
print("# done")

# ── follow-ups ──────────────────────────────────────────────────────────
def big_text(tag, n=190):
    return "\n".join(f"{i:04d} [{tag}] {FILLER}" for i in range(n))

if os.environ.get("FOLLOWUP"):
    print("\n# FOLLOWUP 1: MiniMax with a ~8k-token prefix (implicit caching may need more)", flush=True)
    orig = globals()["text"]
    globals()["text"] = big_text
    run("MiniMax-M2.1", "responses-header", 3)
    run("MiniMax-M2.1", "completions-plain", 3)
    run("kimi-k3", "responses-header", 2)   # control at the same size
    globals()["text"] = orig

    print("\n# FOLLOWUP 2: explicit-cache TTL on a non-qwen family (kimi-k2.5, markers)", flush=True)
    tag = uuid.uuid4().hex[:8]
    def call(label):
        j, s, err = post(CC, cc_body("kimi-k2.5", tag, True))
        u = usage_of("cc", j)
        print(f"  {label:<28} {s:>5}s cached={u['cached']} creation={u['creation']} type={u['type']}" + (f" ERR {err}" if err else ""), flush=True)
        OUT.write(json.dumps({"model": "kimi-k2.5", "shape": "ttl", "label": label, **u}, ensure_ascii=False) + "\n"); OUT.flush()
    call("t0 create")
    time.sleep(25); call("t+25s")
    time.sleep(255); call("t+4.7min (renew?)")
    time.sleep(320); call("+5.3min after hit (expire?)")
