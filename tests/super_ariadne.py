"""The Supercomputer chat on the Ariadne engine, against a stand-in Ariadne agent.

Runner: own-server. `python3 tests/run.py tests/super_ariadne.py` calls this file as
`super_ariadne.py <app-root> <data-dir> <port>`. It starts a small fake of Ariadne's serve
(`/v1/chat/completions` streamed, `ariadne_tool_call` and `ariadne_tool_result` inside
`choices[0].delta`, one turn at a time) in this process, then the app with SUPER_ENGINE=ariadne
pointed at it. The fake calls the app's tools back over MCP the way Ariadne's own MCP client
does: initialize, the notification, tools/list, then tools/call with the turn key inside the
arguments. Nothing leaves this machine and nothing is spent.

Called as `--fake <port> <record-file>` this same file is the fake as its own process, which is
what a per-chat lane starts. That half answers `/health` and `/v1/chat/completions` and records
what a lane was asked to do and what its environment held; it does not call tools back, because
the shared-endpoint half already proves the tool path.
"""
import http.cookiejar
import http.server
import itertools
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

try:
    import yaml  # PyYAML: the lane-config checks parse the merged file, not just grep it
except ImportError:
    yaml = None

FAKE_MODE = "--fake" in sys.argv
if FAKE_MODE:
    FAKE_PORT, RECORD = int(sys.argv[2]), sys.argv[3]
    APP = DATA = PORT = ""
    BASE = ""
else:
    APP, DATA, PORT = sys.argv[1], sys.argv[2], sys.argv[3]
    BASE = f"http://127.0.0.1:{PORT}"
    FAKE_PORT = int(PORT) + 11
    RECORD = ""

AGENT_KEY = "fake-agent-key-" + "k" * 20
ENGINE_TOKEN = "fake-engine-token-" + "e" * 20
MCP = "parallax"
results = []
ids = itertools.count(1)


def check(name, ok, detail=""):
    ok = bool(ok)
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)


# --- the app's tool endpoint, as the agent calls it ---------------------------------

def mcp(method, params=None, *, token=ENGINE_TOKEN, accept="application/json, text/event-stream", notify=False, headers=None, raw=None, verb="POST"):
    msg = {"jsonrpc": "2.0", "method": method}
    if not notify:
        msg["id"] = next(ids)
    if params is not None:
        msg["params"] = params
    h = {"Content-Type": "application/json", "Accept": accept}
    if token:
        h["Authorization"] = f"Bearer {token}"
    h.update(headers or {})
    data = None if verb != "POST" else (raw if raw is not None else json.dumps(msg).encode())
    req = urllib.request.Request(BASE + "/api/super/mcp", data=data, method=verb, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=180) as res:
            status, hdrs, body = res.status, res.headers, res.read().decode()
    except urllib.error.HTTPError as err:
        status, hdrs, body = err.code, err.headers, err.read().decode()
    out = {"status": status, "ctype": hdrs.get("Content-Type", ""), "headers": hdrs, "raw": body, "json": None}
    if "text/event-stream" in out["ctype"]:
        data_lines = [line[6:] for line in body.split("\n") if line.startswith("data: ")]
        out["json"] = json.loads(data_lines[-1]) if data_lines else None
    elif body:
        try:
            out["json"] = json.loads(body)
        except ValueError:
            pass
    return out


# --- a stand-in Ariadne agent --------------------------------------------------------

class Fake:
    requests = []      # every /v1/chat/completions body the app sent
    calls = []         # every tool call the fake made back, with its result
    handshake = None
    tools = []
    disconnects = 0
    keys = []          # turn keys, oldest first
    bad_auth = 0
    busy_left = 0      # how many 409s the next [busy] message should see


def tool(name, args):
    """Calls one of the app's tools and returns (text, is_error)."""
    t0 = time.time()
    r = mcp("tools/call", {"name": name, "arguments": args})
    res = (r["json"] or {}).get("result") or {}
    text = "".join(c.get("text", "") for c in res.get("content", []))
    Fake.calls.append({"tool": name, "status": r["status"], "ctype": r["ctype"], "isError": res.get("isError"), "text": text,
                       "pings": r["raw"].count(": ping"), "working": ": working" in r["raw"], "seconds": time.time() - t0, "rpc": r["json"]})
    return text, res.get("isError")


class Out:
    """Writes one streamed answer the way Ariadne's serve does: chunks in `choices[0].delta`."""

    def __init__(self, handler):
        self.h, self.n = handler, 0

    def chunk(self, delta, finish=None):
        body = {"id": "chatcmpl-ariadne-1", "object": "chat.completion.chunk", "created": 1, "model": "ariadne",
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        self.h.wfile.write(f"data: {json.dumps(body)}\n\n".encode())
        self.h.wfile.flush()

    def say(self, s, pause=0.0):
        self.chunk({"content": s})
        if pause:
            time.sleep(pause)

    def tool_call(self, name, args):
        self.n += 1
        cid = f"call_{self.n}"
        self.chunk({"ariadne_tool_call": {"id": cid, "name": name, "arguments": json.dumps(args)}})
        return cid

    def tool_result(self, cid, content, truncated=False):
        self.chunk({"ariadne_tool_result": {"id": cid, "content": content, "truncated": truncated}})

    def ours(self, name, args, key):
        """Announce one of the app's tools, call it for real, close it."""
        full = f"{MCP}_{name}"
        cid = self.tool_call(full, args)
        text, _ = tool(name, {**args, "turn": key})
        self.tool_result(cid, text)
        return text

    def finish(self, failed=None):
        if failed:
            self.chunk({"content": f"\n[ariadne: {failed}]"})
            self.chunk({}, finish="error")
        else:
            self.chunk({}, finish="stop")
        self.h.wfile.write(b"data: [DONE]\n\n")
        self.h.wfile.flush()


class Agent(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps({"status": "ok", "agent": "ariadne"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        want = os.environ.get("DD_SERVE_KEY", "") if FAKE_MODE else AGENT_KEY
        if self.path != "/v1/chat/completions" or self.headers.get("Authorization") != f"Bearer {want}":
            Fake.bad_auth += 1
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"missing or wrong bearer token","type":"auth_error"}}')
            return

        if FAKE_MODE:
            # A lane: record what it was asked to do and what it was given, then answer plainly.
            content = (body.get("messages") or [{}])[-1].get("content") or ""
            with open(RECORD, "a") as f:
                f.write(json.dumps({"port": FAKE_PORT, "model": body.get("model"), "stream": body.get("stream"),
                                    "accept": self.headers.get("Accept"), "auth_ok": True,
                                    "content": content, "env": sorted(os.environ)}) + "\n")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            out = Out(self)
            try:
                out.chunk({"role": "assistant"})
                out.say("Lane reply.")
                out.finish()
            except (BrokenPipeError, ConnectionResetError):
                Fake.disconnects += 1
            return

        Fake.requests.append({**body, "_accept": self.headers.get("Accept")})
        content = (body.get("messages") or [{}])[-1].get("content") or ""
        said = re.search(r"<member-message>\n(.*)\n</member-message>", content, re.S)
        text = said.group(1) if said else ""
        found = re.search(r'"turn": "(t_[0-9a-f]{24})"', content)
        key = found.group(1) if found else None

        if text.startswith("[http-500]"):
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"inner detail that members must not see","type":"agent_error"}}')
            return

        # A real serve answers one turn at a time: a call while one is running is a 409.
        if text.startswith("[busy]") and Fake.busy_left > 0:
            Fake.busy_left -= 1
            self.send_response(409)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"ariadne is in a turn; one turn at a time","type":"busy"}}')
            return

        Fake.keys.append(key)  # one key per answered message; a 409 retry is the same message

        # A real agent connects to its tool servers once, before it answers anything.
        if Fake.handshake is None:
            init = mcp("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "ariadne", "version": "0"}})
            note = mcp("notifications/initialized", notify=True)
            listed = mcp("tools/list")
            Fake.handshake = {"init": init, "note": note["status"], "list": listed}
            Fake.tools = ((listed["json"] or {}).get("result") or {}).get("tools", [])

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        out = Out(self)
        try:
            out.chunk({"role": "assistant"})
            self.answer(out, text, key)
        except (BrokenPipeError, ConnectionResetError):
            Fake.disconnects += 1

    def answer(self, out, text, key):
        if text.startswith("[markup]"):
            # A serving layer that hands the model's tool call back as text. Ariadne runs nothing
            # for it: the markup is split across chunks so the hold-back is exercised too.
            out.say("Let me store that. ")
            out.say("<toolcall><invoke name=\"" + MCP + "_remember\"", 0.1)
            out.say("><parameter name=\"fact\">the kit token is 5</parameter></invoke>")
            out.say(" Done.")
            return out.finish()
        if text.startswith("[markup2]"):
            # The OpenAI-style shape a served model writes: <tool_call> with a function and its
            # parameters inside. The name in it is one the wire never offered, so nothing runs.
            out.say("Let me store that. ")
            out.say("<tool_call><function=parallax_remember>", 0.1)
            out.say("<parameter=fact>the kit token is 5</parameter>")
            out.say("</tool_call>")
            out.say(" Done.")
            return out.finish()
        m = re.match(r"(\[\w[\w-]*\])?\s*generate an? (image|video) of (.+)$", text, re.I)
        if m and m.group(1) == "[race]":
            # The tool call reaches the app before the text that was written ahead of it.
            args = {"kind": m.group(2), "prompt": m.group(3)}
            worker = threading.Thread(target=tool, args=("generate_media", {**args, "turn": key}))
            worker.start()
            time.sleep(0.4)
            out.say("Before the tool. ")
            cid = out.tool_call(f"{MCP}_generate_media", args)
            worker.join()
            out.tool_result(cid, "ok")
            out.say("After the tool.")
            return out.finish()
        if m:
            out.say("Let me set ", 0.15)
            out.say("that up.", 0.05)
            out.ours("generate_media", {"kind": m.group(2), "prompt": m.group(3)}, key)
            out.say(" Here it is.")
            return out.finish()
        m = re.match(r"\[late\] remember (.+)$", text)
        if m:
            # The stream never shows this call starting until it is already over.
            out.say("One. ")
            first, _ = tool("remember", {"fact": m.group(1), "turn": key})
            cid = out.tool_call(f"{MCP}_remember", {"fact": m.group(1)})
            out.tool_result(cid, first)
            out.ours("recall", {"query": ""}, key)
            out.say("Two.")
            return out.finish()
        m = re.match(r"remember (?:that )?(.+)$", text)
        if m:
            out.ours("remember", {"fact": m.group(1)}, key)
            out.say("Noted.")
            return out.finish()
        if "what do you remember" in text:
            got = out.ours("recall", {"query": ""}, key)
            out.say(f"I remember: {got}")
            return out.finish()
        m = re.match(r"ask me (.+)$", text)
        if m:
            got = out.ours("ask_user", {"question": m.group(1), "choices": ["Yes", "No"]}, key)
            out.say(f"You told me: {got}")
            return out.finish()
        if text.startswith("[own-tools]"):
            out.say("Checking. ")
            a = out.tool_call("find", {"query": "terminal"})
            out.tool_result(a, json.dumps({"hits": []}))
            b = out.tool_call("run_terminal", {"command": "echo SECRET_ARG_123"})
            time.sleep(0.3)
            out.tool_result(b, json.dumps({"stdout": "SECRET_OUT_456", "exit": 0}))
            c = out.tool_call("read_file", {"path": "x"})
            out.tool_result(c, json.dumps({"error": "boom"}))
            out.say("All done.")
            return out.finish()
        if text.startswith("[truncated]"):
            # A long tool result is cut by the serve; a cut is not a failure. The tool really
            # runs, so its row is made where it runs, and only the result handed back is cut.
            tool("recall", {"query": "", "turn": key})
            cid = out.tool_call(f"{MCP}_recall", {"query": ""})
            out.tool_result(cid, "a" * 2000, truncated=True)
            out.say("Read it.")
            return out.finish()
        if text.startswith("[keys]"):
            # Wrong, missing and stale keys must all be refused.
            for label, turn_key in (("bad", "t_" + "0" * 24), ("none", None), ("old", Fake.keys[-2] if len(Fake.keys) > 1 else "t_x")):
                args = {"query": ""} if turn_key is None else {"query": "", "turn": turn_key}
                _, err = tool("recall", args)
                out.say(f"{label}={'refused' if err else 'ran'} ")
            return out.finish()
        if text.startswith("[fail]"):
            out.say("Starting. ")
            return out.finish(failed="inner detail that members must not see")
        if text.startswith("[cut]"):
            out.say("Half an ans")
            time.sleep(0.2)
            return None  # the connection just closes
        if text.startswith("[slow]"):
            for _ in range(200):
                out.say(".", 0.1)
            return out.finish()
        if text.startswith("[leak]"):
            out.say("The key is " + key[:9], 0.4)
            out.say(key[9:] + " and that is all.")
            return out.finish()
        if text.startswith("[crlf]"):
            # Windows line ends, cut in the worst places.
            chunks = [json.dumps({"id": "x", "object": "chat.completion.chunk",
                                  "choices": [{"index": 0, "delta": d, "finish_reason": f}]})
                      for d, f in (({"content": "CR"}, None), ({"content": "LF ok"}, None), ({}, "stop"))]
            blob = b"".join(b": keepalive\r\n\r\n" + b"data: " + c.encode() + b"\r\n\r\n" for c in chunks)
            parts = blob.split(b"\r\n\r\n")
            for i, part in enumerate(parts[:-1]):
                head, tail = (b"\r\n\r", b"\n") if i % 2 else (b"\r", b"\n\r\n")
                self.wfile.write(part + head)
                self.wfile.flush()
                time.sleep(0.05)
                self.wfile.write(tail)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return None
        out.say("You said: ", 0.15)
        out.say(text, 0.15)
        out.say(" Bye.")
        return out.finish()


if FAKE_MODE:
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", FAKE_PORT), Agent)
    srv.daemon_threads = True
    srv.serve_forever()
    sys.exit(0)


# --- the app -------------------------------------------------------------------------

def boot(log, **extra):
    env = dict(os.environ, TREG_MODE="mock", SUPER_MODE="mock", MOCK_DELAY_MS="300", PARALLAX_DATA_DIR=DATA, PARALLAX_DEMO_BILLING="1",
               SUPER_ENGINE="ariadne", ARIADNE_URL=f"http://127.0.0.1:{FAKE_PORT}/", SUPER_ENGINE_NAME="Ari", **extra)
    return subprocess.Popen(["node", "node_modules/next/dist/bin/next", "start", "-p", PORT], cwd=APP, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)


def halt(proc):
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)


def wait_port():
    for _ in range(120):
        try:
            urllib.request.urlopen(BASE + "/api/auth/me", timeout=2).read()
            return True
        except urllib.error.HTTPError:
            return True
        except Exception:
            time.sleep(0.25)
    return False


A = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"Content-Type": "application/json"} if data else {})
    try:
        with A.open(req, timeout=60) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as err:
        try:
            return err.code, json.loads(err.read() or b"{}")
        except ValueError:
            return err.code, {}


def wait_for(fn, seconds=30, step=0.2):
    deadline = time.time() + seconds
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(step)
    return None


def latest(chat_id):
    _, out = call("GET", f"/api/super/chats/{chat_id}/rows?after=0")
    by_seq = {r["seq"]: r for r in out.get("rows", [])}
    return [by_seq[k] for k in sorted(by_seq)]


def idle(chat_id):
    _, out = call("GET", f"/api/super/chats/{chat_id}")
    return out.get("chat", {}).get("state") == "idle" and all(t["status"] not in ("queued", "running", "waiting") for t in out.get("turns", []))


def cards(chat_id, card=None, status=None):
    return [r for r in latest(chat_id) if r["kind"] == "card" and (card is None or r["body"].get("card") == card) and (status is None or r["body"].get("status") == status)]


def send(chat_id, text, **extra):
    return call("POST", f"/api/super/chats/{chat_id}/messages", {"text": text, **extra})


def turn(chat_id, text, seconds=30, **extra):
    """Sends one message, waits for the reply to finish, returns the rows it added."""
    before = {r["seq"] for r in latest(chat_id)}
    send(chat_id, text, **extra)
    time.sleep(0.3)
    wait_for(lambda: idle(chat_id), seconds)
    return [r for r in latest(chat_id) if r["seq"] not in before]


def shape(rows):
    """Rows as short labels, in order: what a member would see down the page."""
    out = []
    for r in rows:
        b = r["body"]
        if r["kind"] == "message":
            out.append(f"{b.get('role')}:{b.get('text')}")
        elif r["kind"] == "tool-call":
            out.append(f"tool:{b.get('tool')}:{b.get('status')}")
        elif r["kind"] == "card":
            out.append(f"card:{b.get('card')}:{b.get('status')}")
        elif r["kind"] == "notice":
            out.append(f"notice:{b.get('code')}")
    return out


def balance():
    return call("GET", "/api/auth/me")[1].get("balance")


def alive_ports():
    """The stand-in binaries that are alive, as the loopback port each one serves."""
    out = set()
    for p in os.listdir("/proc"):
        if not p.isdigit():
            continue
        try:
            with open(f"/proc/{p}/cmdline", "rb") as f:
                line = f.read().decode("utf-8", "replace")
        except OSError:
            continue
        line = line.replace("\x00", " ")
        if "--fake" in line:
            found = re.search(r"--fake (\d+) ", line)
            if found:
                out.add(int(found.group(1)))
    return out


shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA)
logs = os.path.join(os.path.dirname(DATA), "logs")
os.makedirs(logs, exist_ok=True)
key_file = os.path.join(os.path.dirname(DATA), "ariadne.key")
with open(key_file, "w") as f:
    f.write(AGENT_KEY + "\n")
os.chmod(key_file, 0o600)

agent = http.server.ThreadingHTTPServer(("127.0.0.1", FAKE_PORT), Agent)
agent.daemon_threads = True
threading.Thread(target=agent.serve_forever, daemon=True).start()

# --- half-set settings fall back to the built-in engine --------------------------------
log0 = open(os.path.join(logs, "ariadne-off.log"), "w")
off = boot(log0, ARIADNE_API_KEY_FILE=key_file, SUPER_ENGINE_TOKEN="too-short")
check("server up (weak engine token)", wait_port())
call("POST", "/api/auth/guest")
s, cfg = call("GET", "/api/super/config")
check("weak token: the built-in engine stays in charge", s == 200 and cfg.get("engine", {}).get("id") == "builtin" and cfg["services"]["llm"] == "mock" and len(cfg["models"]) > 1, str(cfg.get("engine")))
r = mcp("ping", token="too-short")
check("weak token: the tool endpoint does not exist", r["status"] == 404, f"{r['status']}")
halt(off)
log0.close()
with open(os.path.join(logs, "ariadne-off.log")) as f:
    off_log = f.read()
check("weak token: the server says what is missing, without the value", "SUPER_ENGINE_TOKEN" in off_log and "too-short" not in off_log, off_log[-200:])
A = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA)

# --- the Ariadne engine, on a shared endpoint -----------------------------------------
log = open(os.path.join(logs, "ariadne.log"), "w")
server = boot(log, ARIADNE_API_KEY_FILE=key_file, SUPER_ENGINE_TOKEN=ENGINE_TOKEN)
try:
    check("server up (Ariadne engine)", wait_port())
    s, g = call("POST", "/api/auth/guest")
    check("guest account", s == 200, f"{s}")
    s, cfg = call("GET", "/api/super/config")
    check("config: the engine is named", cfg.get("engine") == {"id": "ariadne", "name": "Ari"}, str(cfg.get("engine")))
    check("config: one model choice, named after the engine", [(m["id"], m["name"]) for m in cfg.get("models", [])] == [("auto", "Ari")], str(cfg.get("models")))
    check("config: the assistant counts as live, the rest as stand-ins", cfg.get("services") == {"llm": "live", "computer": "mock", "connectors": "mock"}, str(cfg.get("services")))

    # --- the tool endpoint, called directly ---
    r = mcp("ping", token=None)
    check("endpoint: no token is 401", r["status"] == 401 and "Bearer" in (r["headers"].get("WWW-Authenticate") or ""), f"{r['status']}")
    r = mcp("ping", token="wrong-" + "x" * 30)
    check("endpoint: wrong token is 401", r["status"] == 401 and (r["json"] or {}).get("error", {}).get("code") == "unauthorized", f"{r['status']}")
    r = mcp("ping", token=AGENT_KEY)
    check("endpoint: the agent's own bearer is not the engine token", r["status"] == 401, f"{r['status']}")
    r = mcp("ping", verb="GET")
    check("endpoint: GET is 405", r["status"] == 405 and r["headers"].get("Allow") == "POST", f"{r['status']}")
    r = mcp("ping", headers={"Origin": "https://evil.example"})
    check("endpoint: cross-site call refused", r["status"] == 403, f"{r['status']}")
    r = mcp("ping", raw=b"{not json")
    check("endpoint: bad JSON is a parse error", r["status"] == 400 and r["json"]["error"]["code"] == -32700, f"{r['status']}")
    r = mcp("ping")
    check("endpoint: ping", r["status"] == 200 and r["json"].get("result") == {}, str(r["json"]))
    r = mcp("nope/nothing")
    check("endpoint: unknown method", r["json"]["error"]["code"] == -32601, str(r["json"]))
    r = mcp("server/discover", {"_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28"}})
    check("endpoint: discovery for newer clients", r["status"] == 200 and "2026-07-28" in r["json"]["result"]["supportedVersions"] and r["json"]["result"].get("resultType") == "complete", str(r["json"])[:200])
    r = mcp("tools/call", {"name": "delete_everything", "arguments": {}})
    check("endpoint: unknown tool", r["json"].get("error", {}).get("code") == -32602, str(r["json"])[:160])
    r = mcp("tools/call", {"name": "recall", "arguments": {"query": ""}}, accept="application/json")
    check("endpoint: a call with no turn key is refused, as plain JSON when asked", r["status"] == 200 and "application/json" in r["ctype"] and r["json"]["result"]["isError"] is True, str(r["json"])[:200])
    r = mcp("tools/call", {"name": "recall", "arguments": {"query": "", "turn": "t_" + "a" * 24}})
    check("endpoint: a made-up turn key is refused, as a stream when accepted", "text/event-stream" in r["ctype"] and "event: message" in r["raw"] and r["json"]["result"]["isError"] is True, r["raw"][:200])

    s, out = call("POST", "/api/super/chats", {})
    cid = out["chat"]["id"]

    # --- a plain reply ---
    new = turn(cid, "hello there")
    check("reply: the agent's text is the reply", shape(new) == ["user:hello there", "assistant:You said: hello there Bye."], str(shape(new)))
    reply = [r for r in new if r["body"].get("role") == "assistant"]
    check("reply: it streamed and then settled", reply and reply[0]["updatedSeq"] > reply[0]["seq"] and reply[0]["body"]["streaming"] is False, str(reply)[:200])
    req = Fake.requests[-1]
    check("request: streamed to /v1/chat/completions, one model", req.get("stream") is True and req.get("model") == "ariadne" and "text/event-stream" in (req.get("_accept") or ""), str({k: req.get(k) for k in ("stream", "model")}))
    content = (req.get("messages") or [{}])[-1].get("content") or ""
    # Ariadne registers a server's tools under the names the server lists, so the instructions must
    # name them bare. A prefixed name is a tool the wire never offered: a model that trusts it
    # writes the call out as text and nothing runs.
    check("request: the instructions name our tools bare, never prefixed",
          "generate_media" in content and "remember" in content and f"{MCP}_generate_media" not in content,
          content[:160])
    check("request: a shared endpoint gets the thread as text", "<chat-history>" in content, str(content)[:120])
    check("request: the member's message is marked as theirs", "<member-message>" in content, "")
    check("request: instructions carry a turn key", re.search(r'"turn": "t_[0-9a-f]{24}"', content) and Fake.keys[-1], str(Fake.keys[-1])[:4])
    check("request: the agent's bearer was accepted, nothing else was sent to it", Fake.bad_auth == 0 and ENGINE_TOKEN not in json.dumps(req), f"{Fake.bad_auth}")
    hs = Fake.handshake or {}
    check("handshake: initialize, then the notification gets 202", hs and hs["init"]["json"]["result"]["protocolVersion"] == "2025-06-18" and hs["note"] == 202, str(hs.get("note")))
    names = {t["name"] for t in Fake.tools}
    check("tools: generation, registry, library, memory and questions are offered", {"generate_media", "list_models", "get_model", "quote", "search_library", "get_asset", "remember", "recall", "ask_user"} <= names, str(sorted(names)))
    check("tools: stand-in services are not offered", not any(n.startswith(("computer_", "app_")) or n in ("connect_app", "list_connectors") for n in names), str(sorted(names)))
    check("tools: every one requires the turn key", Fake.tools and all("turn" in t["inputSchema"].get("required", []) and "turn" in t["inputSchema"]["properties"] for t in Fake.tools), "")

    # --- a busy conversation is waited on, not cancelled ---
    Fake.busy_left = 2
    new = turn(cid, "[busy] then answer", 40)
    check("busy: a 409 is retried until the endpoint is free", Fake.busy_left == 0 and shape(new)[1:] == ["assistant:You said: [busy] then answer Bye."], str(shape(new)))

    # --- a tool call the serving layer left as markup ---
    new = turn(cid, "[markup] store the kit token", 40)
    seen = shape(new)
    check("markup: the call never reaches the app", not any(s.startswith("tool:") for s in seen), str(seen))
    check("markup: the member never sees the markup itself", not any("<toolcall" in s or "<invoke" in s for s in seen), str(seen))
    check("markup: the turn says the tool did not run", "notice:tool_markup" in seen, str(seen))

    # The same failure in the <tool_call> shape. A real served model wrote this on a live lane,
    # and the member saw the XML: the block is protocol, not prose.
    seen2 = shape(turn(cid, "[markup2] store the kit token", 40))
    check("markup2: the call never reaches the app", not any(s.startswith("tool:") for s in seen2), str(seen2))
    check("markup2: the member never sees the markup itself",
          not any("<tool_call" in s or "<function=" in s or "<parameter=" in s for s in seen2), str(seen2))
    check("markup2: the turn says the tool did not run", "notice:tool_markup" in seen2, str(seen2))

    # --- generate, asking first ---
    call("POST", "/api/wallet/topup", {"packId": "pack-500"})
    start = balance()
    mark = max(r["seq"] for r in latest(cid))  # only the rows this message adds, nothing before it
    send(cid, "generate an image of a red fox in snow")
    card = wait_for(lambda: cards(cid, "approval", "pending"), 20)
    check("generate(ask): the member gets an approval card", card and "red fox" in card[0]["body"].get("prompt", "") and card[0]["body"].get("price", 0) > 0, str(card[0]["body"] if card else None)[:200])
    check("generate(ask): nothing spent while it waits", balance() == start, "")
    time.sleep(16.5)  # long enough that the open tool call must be kept alive
    price = card[0]["body"]["price"] if card else 0
    if card:
        s, out = call("POST", f"/api/super/approvals/{card[0]['body']['approvalId']}", {"decision": "allow"})
        check("generate(ask): allow accepted", s == 200, f"{s}")
    wait_for(lambda: idle(cid), 60)
    rows = [r for r in latest(cid) if r["seq"] > mark]
    got = shape(rows)
    check("generate(ask): text, then the tool, then its cards, then text", got == ["user:generate an image of a red fox in snow", "assistant:Let me set that up.", "tool:generate_media:done", "card:approval:allowed", "card:result:succeeded", "assistant:Here it is."], str(got))
    check("generate(ask): charged exactly the shown price", price > 0 and balance() == start - price, f"{start} -> {balance()} price={price}")
    gen = [c for c in Fake.calls if c["tool"] == "generate_media"][-1]
    check("generate(ask): the long call was answered as a stream and kept alive", "text/event-stream" in gen["ctype"] and gen["working"] and gen["pings"] >= 1 and gen["seconds"] > 15, f"pings={gen['pings']} seconds={gen['seconds']:.1f}")
    check("generate(ask): the agent got the file ids back, not an error", gen["isError"] is False and "ast_" in gen["text"], gen["text"][:160])
    s, lib = call("GET", "/api/assets?kind=image")
    check("generate(ask): the picture is in the member's library", len(lib.get("assets", [])) == 1, f"{len(lib.get('assets', []))}")

    # --- generate without asking; a denied card ---
    new = turn(cid, "generate an image of a blue heron", 60, mode="auto")
    check("generate(auto): no approval card, straight to the result", shape(new)[1:] == ["assistant:Let me set that up.", "tool:generate_media:done", "card:result:succeeded", "assistant:Here it is."], str(shape(new)))
    before = balance()
    send(cid, "generate an image of a lantern")
    card = wait_for(lambda: cards(cid, "approval", "pending"), 20)
    if card:
        call("POST", f"/api/super/approvals/{card[0]['body']['approvalId']}", {"decision": "deny"})
    wait_for(lambda: idle(cid), 30)
    check("generate(ask): denied means no spend, and the agent is told", balance() == before and "denied" in Fake.calls[-1]["text"].lower(), Fake.calls[-1]["text"][:120])

    # --- row order when the call and the stream race ---
    new = turn(cid, "[race] generate an image of a paper boat", 60, mode="auto")
    check("order: text written before a tool lands before it, even when the call arrives first", shape(new)[1:] == ["assistant:Before the tool.", "tool:generate_media:done", "card:result:succeeded", "assistant:After the tool."], str(shape(new)))
    new = turn(cid, "[late] remember I like teal")
    check("order: a call the stream never announced still runs, in order", shape(new)[1:] == ["assistant:One.", "tool:remember:done", "tool:recall:done", "assistant:Two."], str(shape(new)))
    late = [c for c in Fake.calls if c["tool"] == "remember"][-1]
    check("order: it waited a moment for the stream, not forever", 1.2 < late["seconds"] < 4, f"{late['seconds']:.2f}s")

    # --- a cut-off tool result is not read as a failure ---
    new = turn(cid, "[truncated] read the notes")
    check("tool result: a truncated result closes the step as done", "tool:recall:done" in shape(new)[1:], str(shape(new)))

    # --- memory and questions go through Parallax ---
    new = turn(cid, "what do you remember")
    check("memory: recall reads the member's own notes", any("teal" in r["body"].get("text", "") for r in new if r["kind"] == "message"), str(shape(new)))
    s, mem = call("GET", "/api/super/memory")
    check("memory: saved in Parallax, where the member can see it", any("teal" in m["text"] for m in mem.get("memories", [])), str(mem)[:160])
    send(cid, "ask me whether blue works")
    q = wait_for(lambda: cards(cid, "question", "pending"), 20)
    check("ask_user: a question card with choices", q and q[0]["body"]["choices"] == ["Yes", "No"], str(q[0]["body"] if q else None)[:160])
    if q:
        call("POST", f"/api/super/approvals/{q[0]['body']['approvalId']}", {"choice": "Yes"})
    wait_for(lambda: idle(cid), 20)
    check("ask_user: the answer reaches the agent", "You told me: The member answered" in latest(cid)[-1]["body"].get("text", ""), str(latest(cid)[-1]["body"])[:160])

    # --- the agent's own tools ---
    new = turn(cid, "[own-tools] look around")
    got = shape(new)[1:]
    check("own tools: shown as steps, the harness's own plumbing hidden, failures marked",
          got == ["assistant:Checking.", "tool:engine.run_terminal:done", "tool:engine.read_file:error", "assistant:All done."], str(got))
    own = [r["body"] for r in new if r["kind"] == "tool-call"]
    check("own tools: a readable label, and no input or output kept", own and own[0].get("summary") == "Run terminal" and own[0].get("input") == {} and "SECRET" not in json.dumps(new), str(own)[:200])

    # --- turn keys ---
    new = turn(cid, "[keys] try them")
    check("keys: wrong, missing and last message's keys are all refused", shape(new)[1:] == ["assistant:bad=refused none=refused old=refused"], str(shape(new)))
    check("keys: each message gets a new one", len(set(Fake.keys)) == len(Fake.keys) and all(k and re.fullmatch(r"t_[0-9a-f]{24}", k) for k in Fake.keys), f"{len(Fake.keys)} keys")
    r = mcp("tools/call", {"name": "recall", "arguments": {"query": "", "turn": Fake.keys[-1]}})
    check("keys: a key stops working when its reply ends", r["json"]["result"]["isError"] is True, str(r["json"])[:160])

    events = []

    def listen():
        try:
            with A.open(urllib.request.Request(BASE + "/api/super/events"), timeout=60) as res:
                name = None
                for line in res:
                    line = line.decode("utf8").rstrip("\n")
                    if line.startswith("event: "):
                        name = line[7:]
                    elif line.startswith("data: ") and name:
                        events.append((name, line[6:]))
                        name = None
        except Exception:
            pass

    threading.Thread(target=listen, daemon=True).start()
    wait_for(lambda: any(e[0] == "ready" for e in events), 10)
    new = turn(cid, "[leak] say it")
    leaked = Fake.keys[-1]
    check("keys: one the agent repeats is cut from the reply", shape(new)[1:] == ["assistant:The key is  and that is all."], str(shape(new)))
    writes = [e[1] for e in events if e[0] == "row" and "The key is" in e[1]]
    check("keys: not even half of it shows while the reply streams", len(writes) >= 2 and not any(leaked[:6] in w for w in writes), f"{len(writes)} writes")
    db = b""
    for name in os.listdir(DATA):
        if name.startswith("parallax.db"):
            with open(os.path.join(DATA, name), "rb") as f:
                db += f.read()
    check("keys: none is stored", not any(k.encode() in db for k in Fake.keys), "")

    # --- shapes of the stream ---
    new = turn(cid, "[crlf] go")
    check("stream: other line ends, cut anywhere, still parse", shape(new)[1:] == ["assistant:CRLF ok"], str(shape(new)))

    # --- failures and stopping ---
    new = turn(cid, "[fail] go")
    check("failure: a failed answer keeps its text and posts a plain notice", shape(new)[1:] == ["assistant:Starting.", "notice:turn_failed"] and "inner detail" not in json.dumps(new), str(shape(new)))
    new = turn(cid, "[http-500] go")
    check("failure: an agent that errors posts the same notice", shape(new)[1:] == ["notice:turn_failed"] and "inner detail" not in json.dumps(new), str(shape(new)))
    new = turn(cid, "[cut] go")
    check("failure: an answer that breaks off is a failure, not a reply", shape(new)[1:] == ["assistant:Half an ans", "notice:turn_failed"] and new[1]["body"]["streaming"] is False, str(shape(new)))
    _, detail = call("GET", f"/api/super/chats/{cid}")
    check("failure: the turn is marked failed", [t["status"] for t in detail.get("turns", [])][:3] == ["failed"] * 3, str([t["status"] for t in detail.get("turns", [])][:3]))
    seen = Fake.disconnects
    send(cid, "[slow] take your time")
    time.sleep(1.0)
    s, out = call("POST", f"/api/super/chats/{cid}/stop")
    check("stop: accepted", s == 200 and out.get("stopped") is True, f"{s} {out}")
    wait_for(lambda: idle(cid), 20)
    tail = latest(cid)[-2:]
    check("stop: the reply ends where it was, with a notice", len(tail) == 2 and tail[0]["body"].get("streaming") is False and tail[0]["body"].get("text", "").startswith("..") and tail[1]["body"].get("code") == "stopped", str(shape(tail)))
    check("stop: the agent is cut off too", wait_for(lambda: Fake.disconnects > seen, 5), f"{Fake.disconnects - seen} disconnects")
    new = turn(cid, "still there?")
    check("after all that, the chat still works", shape(new) == ["user:still there?", "assistant:You said: still there? Bye."], str(shape(new)))

    # --- incognito ---
    s, out = call("POST", "/api/super/chats", {"incognito": True})
    icid = out["chat"]["id"]
    turn(icid, "remember that my secret is plum")
    s, mem = call("GET", "/api/super/memory")
    check("incognito: nothing saved, and the agent is told to save nothing either", not any("plum" in m["text"] for m in mem.get("memories", [])) and "incognito" in (Fake.requests[-1].get("messages") or [{}])[-1].get("content", ""), str(mem)[:120])

    # --- guessing the token gets slower, the real engine is not locked out ---
    codes = [mcp("ping", token="guess-%02d-" % i + "x" * 24)["status"] for i in range(24)]
    check("endpoint: repeated wrong tokens are throttled", codes[0] == 401 and codes[-1] == 429, str(codes[-6:]))
    check("endpoint: the engine's own calls are not", mcp("ping")["status"] == 200, "")
finally:
    halt(server)
    log.close()
    agent.shutdown()

with open(os.path.join(logs, "ariadne.log")) as f:
    text = f.read()
check("log: no key, token or turn key is written", not any(x in text for x in [AGENT_KEY, ENGINE_TOKEN] + [k for k in Fake.keys if k]), "")

# --- per-chat lanes --------------------------------------------------------------------
# A lane is a real `ariadne --serve` process per chat. The stand-in is this same file run as
# the binary the launcher names, so the spawn path is the one deploy/start.sh uses.
lane_dir = os.path.join(os.path.dirname(DATA), "lane")
os.makedirs(lane_dir, exist_ok=True)
lane_home = os.path.join(lane_dir, "home")
os.makedirs(lane_home, exist_ok=True)
# A lane config is the operator's config with our entry merged in, so the lane home needs a
# config of its own -- the same file a real `~/ariadne/config.yaml` would be. It carries a tool
# the operator asked for, which the merge must leave alone.
with open(os.path.join(lane_home, "config.yaml"), "w") as f:
    # Written the way a real ~/ariadne/config.yaml is written: one key per line, sequence items at
    # the same depth as their key, and another MCP server present. Written line by line so the
    # fixture is a real file, not a string of escaped text -- which is what let a merge that
    # produces an unparsable config pass this test for as long as it has existed.
    fixture = ["model:",
               "  provider: openai_compat",
               "  base_url: https://example.test/v1",
               "  model: some-model",
               "tool_search:",
               "  enabled: true",
               "  always_load:",
               "  - operator_own_skill",
               "mcp_servers:",
               "  pulse:",
               "    enabled: true",
               "    transport: http",
               '    url: "http://127.0.0.1:20001/mcp"']
    with open(os.path.join(lane_home, "config.yaml"), "w") as f:
        for line in fixture:
            f.write(line + os.linesep)
lane_record = os.path.join(lane_dir, "requests.jsonl")
launcher = os.path.join(lane_dir, "ariadne")
with open(launcher, "w") as f:
    f.write("#!/usr/bin/env bash\n"
            "# Stands in for the real binary: takes --serve 127.0.0.1:PORT and answers it.\n"
            'port=""\nfor a in "$@"; do case "$a" in 127.0.0.1:*) port="${a##*:}" ;; esac; done\n'
            '[ -z "$port" ] && exit 2\n'
            f'exec python3 {os.path.abspath(__file__)} --fake "$port" {lane_record}\n')
os.chmod(launcher, 0o755)

shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA)
Fake.requests, Fake.keys, Fake.calls, Fake.handshake = [], [], [], None
log2 = open(os.path.join(logs, "lanes.log"), "w")
server = boot(log2, ARIADNE_API_KEY=AGENT_KEY, SUPER_ENGINE_TOKEN=ENGINE_TOKEN, ARIADNE_PER_CHAT="1",
              ARIADNE_HOME=lane_home, ARIADNE_BIN=launcher, ARIADNE_PORT_BASE=str(int(PORT) + 40), ARIADNE_MAX_LANES="2",
              ARIADNE_DISABLE_TOOLS="run_terminal,write_file,edit_file,list_dir,read_file")
try:
    check("server up (per-chat lanes)", wait_port())
    call("POST", "/api/auth/guest")
    s, cfg = call("GET", "/api/super/config")
    check("lanes: the engine is still the one the composer shows", cfg.get("engine") == {"id": "ariadne", "name": "Ari"}, str(cfg.get("engine")))

    def records():
        if not os.path.exists(lane_record):
            return []
        with open(lane_record) as f:
            return [json.loads(line) for line in f if line.strip()]

    s, a = call("POST", "/api/super/chats", {})
    c1 = a["chat"]["id"]
    turn(c1, "hello lane one", 40)
    first = wait_for(lambda: records(), 40)
    check("lanes: a chat gets its own serve process", first and first[0]["auth_ok"] and first[0]["stream"] is True and first[0]["model"] == "ariadne", str(first)[:200])
    check("lanes: a lane is not told the shared endpoint's thread", first and "<chat-history>" not in first[0]["content"], "")
    check("lanes: a lane keeps the member's message", "hello lane one" in first[0]["content"], first[0]["content"][:120])
    check("lanes: a lane gets the engine key, not Parallax's keys", "SUPER_ENGINE_TOKEN" not in first[0]["env"] and "TREG_TOKEN" not in first[0]["env"] and "ANTHROPIC_API_KEY" not in first[0]["env"], str(first[0]["env"])[:160])
    check("lanes: the operator's disabled tools reach the lane", "DD_DISABLE_TOOLS" in first[0]["env"], "")
    check("lanes: the chat's reply came from the lane", turn(c1, "again", 40) and "Lane reply." in latest(c1)[-1]["body"].get("text", ""), str(shape(latest(c1)))[:200])

    s, b = call("POST", "/api/super/chats", {})
    c2 = b["chat"]["id"]
    turn(c2, "hello lane two", 40)
    ports = {r["port"] for r in records()}
    check("lanes: two chats, two different loopback ports", len(ports) == 2, str(sorted(ports)))
    rec = records()
    check("lanes: one chat keeps its own lane across messages", rec[0]["port"] == rec[1]["port"], f"ports={rec[0]['port']} then {rec[1]['port']}")
    check("lanes: at most maxLanes processes are alive", len(alive_ports()) <= 2, f"{len(alive_ports())} processes")

    cfg_path = os.path.join(lane_home, "lanes", c1, "config.yaml")
    ok = os.path.exists(cfg_path)
    body = open(cfg_path).read() if ok else ""
    check("lanes: the lane runs from a folder of its own under the engine home", ok and os.path.isdir(os.path.join(lane_home, "lanes", c2)), cfg_path)
    check("lanes: the lane keeps the operator's model settings, so it can answer at all",
          "base_url: https://example.test/v1" in body and "model: some-model" in body, body[:200])
    check("lanes: the lane keeps the tools the operator loaded themselves", "operator_own_skill" in body, "")
    check("lanes: our entry is in the file once, not stacked up each turn",
          body.count("  parallax:") == 1, str(body.count("  parallax:")))
    check("lanes: the lane's own log is written beside its config",
          os.path.exists(os.path.join(lane_home, "lanes", c1, "serve.log")), "")
    check("lanes: the lane config points at our tool endpoint on this app's port", f"http://127.0.0.1:{PORT}/api/super/mcp" in body, body[:160])
    check("lanes: the lane config carries the engine token as a bearer header", f'Authorization: "Bearer {ENGINE_TOKEN}"' in body, "")
    timeout_line = [l for l in body.splitlines() if l.strip().startswith("timeout:")]
    check("lanes: the lane config gives a tool deadline long enough for a render", bool(timeout_line) and int(timeout_line[0].split(":")[1]) >= 300, str(timeout_line))
    check("lanes: the lane config leaves the server's own instructions verbatim", "instructions: verbatim" in body, "")
    check("lanes: the lane config is readable only by the operator", oct(os.stat(cfg_path).st_mode & 0o777) == "0o600", oct(os.stat(cfg_path).st_mode & 0o777))
    # The merge must not break the file. Ariadne parses config.yaml once at boot and reads
    # `mcp_servers:` as nothing if a sequence above it is malformed, so a lane that parses is a
    # lane whose tools actually exist -- and the operator's own servers have to survive it.
    if yaml is not None:
        parsed = None
        try:
            parsed = yaml.safe_load(body)
        except Exception as exc:
            parsed = exc
        check("lanes: the merged lane config parses as YAML", isinstance(parsed, dict), str(parsed)[:200])
        servers = (parsed or {}).get("mcp_servers") if isinstance(parsed, dict) else None
        check("lanes: the operator's other MCP servers survive the merge",
              isinstance(servers, dict) and "pulse" in servers and MCP in servers, str(servers))
        loads = (parsed or {}).get("tool_search", {}).get("always_load") if isinstance(parsed, dict) else None
        check("lanes: always_load holds the operator's own tool and ours, at one indent",
              isinstance(loads, list) and "operator_own_skill" in loads and "generate_media" in loads, str(loads)[:160])
        entry = (servers or {}).get(MCP) if isinstance(servers, dict) else None
        check("lanes: our entry is the one Ariadne will connect to",
              isinstance(entry, dict) and entry.get("enabled") is True and entry.get("transport") == "http"
              and entry.get("timeout", 0) >= 300 and entry.get("instructions") == "verbatim", str(entry)[:200])
    # The two configs read the same because nothing in them is per chat: the isolation is the
    # folder they live in, which is where the agent's tape, logs and memory are written.
    check("lanes: each chat's config sits in its own folder, not one shared file",
          os.path.realpath(os.path.join(lane_home, "lanes", c1, "config.yaml")) != os.path.realpath(os.path.join(lane_home, "lanes", c2, "config.yaml"))
          and os.path.exists(os.path.join(lane_home, "lanes", c2, "config.yaml")), "")

    s, c = call("POST", "/api/super/chats", {})
    c3 = c["chat"]["id"]
    turn(c3, "third chat pushes the oldest out", 40)
    seen = {r["port"] for r in records()}
    oldest, newest = min(seen), max(seen)
    check("lanes: a third chat closes the lane it has not used lately", wait_for(lambda: oldest not in alive_ports() and newest in alive_ports(), 15), f"alive={sorted(alive_ports())} seen={sorted(seen)}")

    call("DELETE", f"/api/super/chats/{c3}")
    check("lanes: deleting a chat closes its process", wait_for(lambda: newest not in alive_ports(), 15), f"alive={sorted(alive_ports())} deleted port={newest}")
finally:
    halt(server)
    log2.close()

with open(os.path.join(logs, "lanes.log")) as f:
    text = f.read()
check("lanes: the log holds no key or token", AGENT_KEY not in text and ENGINE_TOKEN not in text, "")

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
