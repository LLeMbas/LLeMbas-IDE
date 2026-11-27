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


EDITOR = os.environ.get("FAKE_EDITOR") == "1"
SETTINGS = {"autocomplete": {"model": None, "source": None}, "main": {"model": None}}
gone = set()


def complete(msg):
    p = msg["params"]
    prefix = p["prefix"]
    if "NOMODEL" in prefix:
        out({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32602, "message": "no autocomplete model is chosen"}})
        return
    if "SLOWC" in prefix:
        for _ in range(40):
            if p.get("id") in gone:
                out({"jsonrpc": "2.0", "id": msg["id"], "result": {"text": "", "cancelled": True}})
                return
            threading.Event().wait(0.05)
    text = "tail()\n    second line" if "TWO" in prefix else "<" + prefix[-3:] + "|" + (p.get("suffix") or "")[:3] + ">"
    out({"jsonrpc": "2.0", "id": msg["id"], "result": {"text": text, "model": p.get("model") or "example/model-a", "finish": "stop"}})


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
    if "PERMDIFF" in text:
        answer = ask("session/request_permission", {
            "sessionId": session,
            "toolCall": {"toolCallId": "diff-" + str(msg["id"]), "title": "edit sample.py", "kind": "edit", "status": "pending",
                         "rawInput": {}, "content": [{"type": "diff", "path": "sample.py", "oldText": "one\ntwo", "newText": "one\nTWO"}]},
            "options": [{"optionId": "once", "name": "Allow once", "kind": "allow_once"},
                        {"optionId": "deny", "name": "Deny", "kind": "reject_once"}]})
        got = (answer or {}).get("outcome", {})
        update(session, {"sessionUpdate": "agent_message_chunk",
                         "content": {"type": "text", "text": "\nanswer=" + str(got.get("optionId") or got.get("outcome"))}})
    if "READ " in text:
        path = text.split("READ ", 1)[1].split()[0]
        answer = ask("fs/read_text_file", {"sessionId": session, "path": path})
        update(session, {"sessionUpdate": "agent_message_chunk",
                         "content": {"type": "text", "text": "\nread=" + json.dumps((answer or {}).get("content"))}})
    if "PUT " in text:
        path = text.split("PUT ", 1)[1].split()[0]
        with lock:
            next_id[0] += 1
            rid = next_id[0]
        done = threading.Event()
        waiting[rid] = [done, "error"]
        out({"jsonrpc": "2.0", "id": rid, "method": "fs/write_text_file",
             "params": {"sessionId": session, "path": path, "content": "written by the agent\nsecond\n"}})
        done.wait(10)
        got = waiting.pop(rid)[1]
        update(session, {"sessionUpdate": "agent_message_chunk",
                         "content": {"type": "text", "text": "\nput=" + ("error" if got == "error" else "ok")}})
    if "SHOW " in text:
        path = text.split("SHOW ", 1)[1].split()[0]
        kind = "image" if path.endswith(".png") else "code"
        answer = ask("_lembas/show", {"sessionId": session, "toolCallId": "show-" + str(msg["id"]), "path": os.path.basename(path),
                                       "uri": "file://" + path, "kind": kind, "line": 2})
        update(session, {"sessionUpdate": "agent_message_chunk",
                         "content": {"type": "text", "text": "\nshown=" + json.dumps(answer)}})
    if "WRITE " in text:
        path = text.split("WRITE ", 1)[1].split()[0]
        update(session, {"sessionUpdate": "tool_call", "toolCallId": "c1", "title": "edit " + os.path.basename(path),
                         "kind": "edit", "status": "in_progress"})
        with open(path, "w") as f:
            f.write("rewritten by the agent\n")
        update(session, {"sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed"})
    if "QUESTION" in text:
        answer = ask("_lembas/question", {
            "sessionId": session,
            "toolCallId": "q-" + str(msg["id"]),
            "why": "Pick a backend",
            "questions": [{"header": "DB", "question": "Which DB?", "options": [{"label": "SQLite"}, {"label": "Postgres"}]}],
        })
        update(session, {"sessionUpdate": "agent_message_chunk",
                         "content": {"type": "text", "text": "\nquestion=" + json.dumps(answer, sort_keys=True)}})
    if "PLANCARD" in text:
        answer = ask("_lembas/plan", {
            "sessionId": session,
            "toolCallId": "p-" + str(msg["id"]),
            "text": "# Plan\n- step 1",
            "plan": {"title": "Upgrade"},
        })
        update(session, {"sessionUpdate": "agent_message_chunk",
                         "content": {"type": "text", "text": "\nplan=" + json.dumps(answer, sort_keys=True)}})
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
                if "error" not in msg:
                    entry[1] = msg.get("result")
                entry[0].set()
        elif method == "initialize":
            result = {"protocolVersion": 1, "agentCapabilities": {}}
            if EDITOR:
                result["_meta"] = {"lembas": {"capabilities": ["editor", "media", "files", "commands", "steer", "sessions", "ask", "plan", "compact"]}}
            out({"jsonrpc": "2.0", "id": msg["id"], "result": result})
        elif method == "_lembas/complete":
            threading.Thread(target=complete, args=(msg,), daemon=True).start()
        elif method == "_lembas/complete/cancel":
            gone.add(msg["params"]["id"])
        elif method == "_lembas/complete/warm":
            pass
        elif method == "_lembas/files/search":
            q = str((msg.get("params") or {}).get("query") or "").lower()
            sample = [{"path": "sample.py", "kind": "file"}, {"path": "other.py", "kind": "file"}, {"path": "sub", "kind": "dir"}]
            out({"jsonrpc": "2.0", "id": msg["id"], "result": {"root": os.getcwd(), "files": [f for f in sample if not q or q in f["path"].lower()]}})
        elif method == "_lembas/commands":
            out({"jsonrpc": "2.0", "id": msg["id"], "result": {"commands": [{"name": "review", "description": "Review changes", "_meta": {"lembas": {"kind": "builtin"}}}]}})
        elif method == "_lembas/session/compact":
            out({"jsonrpc": "2.0", "id": msg["id"], "result": {"summary": "Compacted 1 turn."}})
        elif method == "_lembas/steer":
            out({"jsonrpc": "2.0", "id": msg["id"], "result": {"queued": 1}})
        elif method == "_lembas/sessions/list":
            out({"jsonrpc": "2.0", "id": msg["id"], "result": {"sessions": [{"id": "ses_prev", "title": "Previous run", "model": "example/model-a"}]}})
        elif method == "_lembas/sessions/resume":
            out({"jsonrpc": "2.0", "id": msg["id"], "result": {
                "sessionId": "ses_prev",
                "title": "Previous run",
                "modes": {"currentModeId": "edit", "availableModes": [{"id": "ask", "name": "Ask"}, {"id": "edit", "name": "Edit"}]},
                "turns": [
                    {"role": "user", "text": "old prompt"},
                    {"role": "assistant", "text": "old reply", "reasoning": "", "tools": [{"id": "h1", "name": "read", "args": "{}", "output": "file text"}]},
                ],
                "_meta": {"lembas": {"model": "example/model-a", "mode": "edit"}},
            }})
        elif method == "_lembas/edit":
            p = msg["params"]
            if "REFUSE" in p["instruction"]:
                out({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32602, "message": "no model to rewrite with"}})
                continue
            out({"jsonrpc": "2.0", "method": "_lembas/edit/delta", "params": {"id": p.get("id"), "delta": "abc"}})
            lines = p["text"].split("\n")
            if "SAME" in p["instruction"]:
                new = lines
            else:
                # The first line rewritten, a line added after the second, the rest as it was.
                new = [lines[0].upper()] + lines[1:2] + ["    # added by the rewrite"] + lines[2:]
            out({"jsonrpc": "2.0", "id": msg["id"], "result": {"text": "\n".join(new), "model": "example/model-a"}})
        elif method == "_lembas/models":
            out({"jsonrpc": "2.0", "id": msg["id"], "result": {"models": [
                {"id": "example/model-a", "name": "Model A", "for": ["main", "autocomplete"]},
                {"id": "example/model-b", "name": "Model B", "for": ["main"]}],
                "autocomplete": SETTINGS["autocomplete"], "main": SETTINGS["main"]}})
        elif method == "_lembas/editor/settings":
            for key, value in (msg["params"].get("set") or {}).items():
                which = "autocomplete" if key == "autocomplete_model" else "main"
                SETTINGS[which] = {"model": value, "source": "person" if value else None}
            out({"jsonrpc": "2.0", "id": msg["id"], "result": SETTINGS})
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
