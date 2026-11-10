#!/usr/bin/env python3
"""
LLM lanes for the prompt_edit job — free, self-owned only (house rule).

Lane order (verified live from this VM, 2026-11-04):
  1. FreeLLMAPI gateway at 127.0.0.1:3001 (OpenAI-compatible). The unified
     API key comes from the FREELLMAPI_KEY env var when set, else is read
     (read-only) from the gateway's own settings DB — the key is never
     written into this file, a job payload, or a log line.
  2. NVIDIA NIM via the connector helper (nvidia_api.py chat). Models
     there need a one-time "Try this API" activation on build.nvidia.com;
     unactivated models 404 and the lane simply falls through.

chat_json() returns (parsed_json, lane_name) or raises RuntimeError with a
plain reason. A lane that answers with non-JSON is a failed lane, not a
partial result — callers never see half an answer.
"""
import json, os, sqlite3, subprocess, urllib.request, urllib.error

GATEWAY_URL = os.environ.get("FREELLMAPI_URL", "http://127.0.0.1:3001")
GATEWAY_DB = os.path.expanduser("~/freellmapi/server/data/freeapi.db")
NVIDIA_HELPER = os.path.expanduser(
    "~/workspace/custom-connectors/custom.nvidia/bin/nvidia_api.py")
# Gateway models tried in order (bare ids). "auto" is NOT used: the
# gateway's auto-router resolves to a stale alias (gemini/gemini-3-flash)
# that 404s as MODEL_NOT_CONFIGURED. Probe-verified against the live
# gateway 2026-11-04: gemini-3.5-flash served a ~3 KB prompt in 14 s;
# gemini-3-flash-preview served small prompts (200) but aborted once on
# a full-project payload under upstream load. gemini-2.5-flash is
# retired upstream ("no longer available to new users") — do not use.
FREELLMAPI_MODELS = ["gemini-3.5-flash", "gemini-3-flash-preview"]
# First NVIDIA model tried; all need build.nvidia.com activation (see header).
NVIDIA_MODELS = ["meta/llama-3.3-70b-instruct",
                 "mistralai/mistral-large-2-instruct",
                 "nvidia/nemotron-3-super-120b-a12b"]


def _gateway_key():
    env = os.environ.get("FREELLMAPI_KEY")
    if env:
        return env
    try:
        db = sqlite3.connect(f"file:{GATEWAY_DB}?mode=ro", uri=True)
        row = db.execute(
            "SELECT value FROM settings WHERE key = 'unified_api_key'").fetchone()
        db.close()
        return row[0] if row else None
    except Exception:  # noqa: BLE001 - lane just reports unavailable
        return None


def _extract_json(text):
    """LLMs wrap JSON in fences and prose; take the outermost object."""
    if not text:
        raise ValueError("empty reply")
    start = text.find("{")
    if start < 0:
        raise ValueError("no JSON object in reply")
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return json.loads(text[start:i + 1])
    raise ValueError("unbalanced JSON in reply")


def _lane_freellmapi(system, user, timeout):
    key = _gateway_key()
    if not key:
        raise RuntimeError("FreeLLMAPI key not available")
    last_err = None
    for model in FREELLMAPI_MODELS:
        body = json.dumps({
            "model": model,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
            "temperature": 0.2,
        }).encode()
        req = urllib.request.Request(
            GATEWAY_URL + "/v1/chat/completions", data=body, method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {key}"})
        # The gateway is on localhost and MUST be reached directly: the
        # worker service exports HTTP(S)_PROXY for upstream calls, and
        # urllib would otherwise route 127.0.0.1 through the egress
        # proxy, where the request hangs until the connection drops
        # (observed live 2026-11-04: relay-run jobs hung at 0 CPU while
        # direct shell runs succeeded in seconds).
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(req, timeout=timeout) as resp:
                data = json.loads(resp.read())
            content = data["choices"][0]["message"]["content"]
            return _extract_json(content)
        except Exception as e:  # noqa: BLE001 - try the next model
            last_err = e
    raise RuntimeError(f"FreeLLMAPI lane failed: {last_err}")


def _lane_nvidia(system, user, timeout):
    prompt = f"{system}\n\n{user}"
    last = None
    for model in NVIDIA_MODELS:
        try:
            out = subprocess.run(
                ["python3", NVIDIA_HELPER, "chat", model, prompt, "8000"],
                capture_output=True, text=True, timeout=timeout)
            if out.returncode != 0:
                last = (out.stderr or out.stdout or "")[-200:]
                continue
            return _extract_json(out.stdout)
        except Exception as e:  # noqa: BLE001 - try the next model
            last = str(e)
    raise RuntimeError(f"NVIDIA lane unavailable: {last}")


def chat_json(system, user, timeout=600):
    """Try each lane in order; return (obj, lane). Raises RuntimeError
    listing every lane's failure when none answer."""
    failures = []
    for name, fn in (("freellmapi", _lane_freellmapi),
                     ("nvidia", _lane_nvidia)):
        try:
            return fn(system, user, timeout), name
        except Exception as e:  # noqa: BLE001 - fall through to the next lane
            failures.append(f"{name}: {e}")
    raise RuntimeError("no LLM lane answered — " + " | ".join(failures))
