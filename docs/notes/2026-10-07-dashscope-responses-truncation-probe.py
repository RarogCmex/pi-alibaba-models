#!/usr/bin/env python3
"""What survives the Responses endpoint's silent truncation?

Companion to 2026-10-07-dashscope-input-caps.md §2. Unique (non-repetitive)
lines, three markers (head/middle/tail), same text sent
to Completions (honest count) and Responses (suspected truncation), at four
sizes. The model reports which markers it can see.
"""
import json, os, random, ssl, time, urllib.error, urllib.request
try:
    import certifi; SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL = ssl.create_default_context()
HOME=os.path.expanduser("~")
AGENT_DIR=os.environ.get("PI_CODING_AGENT_DIR") or f"{HOME}/.pi/agent"
KEY=json.load(open(f"{AGENT_DIR}/auth.json"))["alibaba-cloud"]["key"]
DOMAIN=json.load(open(f"{AGENT_DIR}/alibaba-config.json"))["cloudDomain"]
RESP=f"https://{DOMAIN}/compatible-mode/v1/responses"
CC=f"https://{DOMAIN}/compatible-mode/v1/chat/completions"
MODEL="qwen3.5-35b-a3b"
M_HEAD, M_MID, M_TAIL = "AAHEAD-11", "BBMID-22", "CCTAIL-33"
rnd = random.Random(20261007)

def post(url, body, headers=None, timeout=900):
    h={"Authorization":f"Bearer {KEY}","Content-Type":"application/json"}; h.update(headers or {})
    req=urllib.request.Request(url,data=json.dumps(body).encode(),headers=h)
    t=time.time()
    try:
        with urllib.request.urlopen(req,context=SSL,timeout=timeout) as r:
            return json.loads(r.read()), round(time.time()-t,1), None
    except urllib.error.HTTPError as e:
        raw=e.read().decode()
        try: msg=json.loads(raw).get("error",{}).get("message","")[:200]
        except Exception: msg=raw[:200]
        return None, round(time.time()-t,1), f"HTTP {e.code}: {msg}"

def build(n_lines, mid_at):
    out=[f"Marker one: {M_HEAD}. Read all the lines below, then report every marker you can see."]
    for i in range(n_lines):
        if i == mid_at: out.append(f"Marker two: {M_MID}.")
        out.append(f"{i:06d} {rnd.randbytes(6).hex()} unique line content for sizing the probe payload accurately")
    out.append(f"Marker three: {M_TAIL}.")
    out.append(f"Question: which of {M_HEAD}, {M_MID}, {M_TAIL} appear above? Answer with only the codes you can actually see.")
    return "\n".join(out)

def ask(url, kind, text, label):
    if kind == "cc":
        body={"model":MODEL,"messages":[{"role":"user","content":text}],"max_tokens":64,"stream":False}
    else:
        body={"model":MODEL,"input":[{"role":"user","content":[{"type":"input_text","text":text}]}],
              "max_output_tokens":64,"stream":False,"store":False}
    j,s,err=post(url,body)
    u=(j or {}).get("usage") or {}
    if kind == "cc":
        pt=u.get("prompt_tokens"); out=((j or {}).get("choices") or [{}])[0].get("message",{}).get("content","")
    else:
        pt=u.get("input_tokens")
        out="".join((o.get("content") or [{}])[0].get("text","") for o in (j or {}).get("output") or [] if o.get("type")=="message")
    seen=[m for m in (M_HEAD,M_MID,M_TAIL) if m in (out or "")]
    print(f"  {label:<26} {kind:<10} {s:>6}s tokens={pt} seen={','.join(seen) or '-'} reply={(out or '')[:70]!r} {err or ''}", flush=True)
    return pt

for target, per_line in [(50_000, 17), (100_000, 17), (150_000, 17), (215_000, 17)]:
    n = target // per_line
    text = build(n, n // 2)
    print(f"# target ~{target} tokens ({n} unique lines, {len(text)} chars)")
    true_pt = ask(CC, "cc", text, f"~{target//1000}k true size")
    ask(RESP, "resp", text, f"~{target//1000}k on Responses")
    if true_pt: print(f"  → responses kept {'' }")
