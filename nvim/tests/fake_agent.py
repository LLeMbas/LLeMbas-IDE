#!/usr/bin/env python3
"""A stand-in for `lembas serve --stdio`, for the plugin's tests: ACP version 1 over lines.

What it does is steered by words in the prompt's last text block: PERM asks for an approval,
WRITE <path> rewrites that file, SLOW waits to be cancelled, CRASH exits. Every request it gets is
appended to the file named by FAKE_AGENT_LOG, one JSON object a line.
"""
import json
import os
import sys
import threading

LOG = os.environ.get("FAKE_AGENT_LOG")
lock = threading.Lock()
waiting = {}
cancelled = threading.Event()
next_id = [1000]


def out(msg):
    with lock:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


def update(session, body):
    out({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session, "update": body}})


def ask(method, params):
    with lock:
        next_id[0] += 1
        rid = next_id[0]
    done = threading.Event()
    waiting[rid] = [done, None]
    out({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    done.wait(10)
    return waiting.pop(rid)[1]


def prompt(msg):
    p = msg["params"]
    session = p["sessionId"]
    text = [b["text"] for b in p["prompt"] if b["type"] == "text"][-1]
    update(session, {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "hidden thought"}})
    update(session, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Hello "}})
    update(session, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "there.\nSecond line"}})
    if "PERM" in text:
        answer = ask("session/request_permission", {
            "sessionId": session,
            "toolCall": {"toolCallId": "perm-" + str(msg["id"]), "title": "rm -r build", "kind": "execute", "status": "pending", "rawInput": {}},
            "options": [{"optionId": "once", "name": "Allow once", "kind": "allow_once"},
                        {"optionId": "deny", "name": "Deny", "kind": "reject_once"}],
            "_meta": {"lembas": {"tool": "bash", "reason": "deletes files"}}})
        got = (answer or {}).get("outcome", {})
        update(session, {"sessionUpdate": "agent_message_chunk",
                         "content": {"type": "text", "text": "\nanswer=" + str(got.get("optionId") or got.get("outcome"))}})
    if "WRITE " in text:
        path = text.split("WRITE ", 1)[1].split()[0]
        update(session, {"sessionUpdate": "tool_call", "toolCallId": "c1", "title": "edit " + os.path.basename(path),
                         "kind": "edit", "status": "in_progress"})
        with open(path, "w") as f:
            f.write("rewritten by the agent\n")
        update(session, {"sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed"})
    if "CRASH" in text:
        sys.stderr.write("not signed in: run lembas login\n")
        sys.stderr.flush()
        os._exit(3)
    stop = "end_turn"
    if "SLOW" in text:
        stop = "cancelled" if cancelled.wait(10) else "end_turn"
        cancelled.clear()
    out({"jsonrpc": "2.0", "id": msg["id"], "result": {"stopReason": stop}})


def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        msg = json.loads(line)
        if LOG:
            with open(LOG, "a") as f:
                f.write(json.dumps(msg) + "\n")
        method = msg.get("method")
        if method is None:
            entry = waiting.get(msg.get("id"))
            if entry:
                entry[1] = msg.get("result")
                entry[0].set()
        elif method == "initialize":
            out({"jsonrpc": "2.0", "id": msg["id"], "result": {"protocolVersion": 1, "agentCapabilities": {}}})
        elif method == "session/new":
            out({"jsonrpc": "2.0", "id": msg["id"], "result": {
                "sessionId": "ses_test",
                "modes": {"currentModeId": "ask", "availableModes": [{"id": "ask", "name": "Ask"}, {"id": "edit", "name": "Edit"}]},
                "_meta": {"lembas": {"model": "example/model-a", "mode": "ask"}}}})
        elif method == "session/prompt":
            threading.Thread(target=prompt, args=(msg,), daemon=True).start()
        elif method == "session/cancel":
            cancelled.set()
        elif method == "session/set_mode":
            out({"jsonrpc": "2.0", "id": msg["id"], "result": {}})
        elif method == "_lembas/configure":
            out({"jsonrpc": "2.0", "id": msg["id"], "result": {"model": msg["params"].get("model"), "effort": "default"}})
        elif "id" in msg:
            out({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "Method not found"}})


main()
