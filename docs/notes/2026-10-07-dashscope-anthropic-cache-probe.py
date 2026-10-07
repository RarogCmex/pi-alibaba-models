#!/usr/bin/env python3
"""Does DashScope's Anthropic-compatible endpoint honour cache_control?
pi-ai injects markers on that shape, and 2.1.0 declares explicit cache prices
for it — both are wrong if the endpoint ignores them."""
import json, os, ssl, time, urllib.error, urllib.request, uuid, sys
try:
    import certifi; SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL = ssl.create_default_context()
HOME = os.path.expanduser("~")
KEY = json.load(open(f"{HOME}/.pi/agent/auth.json"))["alibaba-cloud"]["key"]
DOMAIN = json.load(open(f"{HOME}/.pi/agent/alibaba-config.json"))["cloudDomain"]
URL = f"https://{DOMAIN}/apps/anthropic/v1/messages"
FILLER = ("Prompt caching removes repeated prefill work when consecutive requests share a long prefix. "
          "This deterministic filler exists only to push the prompt over the provider's caching minimum. ")

def call(model, tag, marker):
    text = "\n".join(f"{i:04d} [{tag}] {FILLER}" for i in range(45))
    sysblk = {"type": "text", "text": "You are a terse assistant."}
    userblk = {"type": "text", "text": text + "\nReply with one word: ok"}
    if marker: userblk["cache_control"] = {"type": "ephemeral"}
    body = {"model": model, "max_tokens": 32, "system": [sysblk],
            "messages": [{"role": "user", "content": [userblk]}]}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={
        "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    t = time.time()
    try:
        with urllib.request.urlopen(req, context=SSL, timeout=180) as r:
            j = json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f"  {model:<20} marker={marker!s:<5} HTTP {e.code}: {e.read().decode()[:200]}", flush=True); return
    u = j.get("usage") or {}
    print(f"  {model:<20} marker={marker!s:<5} {round(time.time()-t,1):>4}s in={u.get('input_tokens')} "
          f"cache_creation={u.get('cache_creation_input_tokens')} cache_read={u.get('cache_read_input_tokens')} "
          f"out={u.get('output_tokens')}", flush=True)

for model in sys.argv[1:] or ["qwen3.8-max-0902", "glm-5.3"]:
    tag = uuid.uuid4().hex[:8]
    print(f"# {model} (anthropic shape)", flush=True)
    call(model, tag, True); time.sleep(20); call(model, tag, True)
    tag2 = uuid.uuid4().hex[:8]
    call(model, tag2, False); time.sleep(20); call(model, tag2, False)
