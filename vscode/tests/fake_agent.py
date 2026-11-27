#!/usr/bin/env python3
"""A stand-in for `lembas serve --stdio`, for the extension's tests: ACP version 1 over lines,
with the editor's methods of harness spec 3.11.0 (`_lembas/complete`, `_lembas/edit`,
`_lembas/models`, `_lembas/editor/settings`, `_lembas/show` with `_lembas/show/read`).

It started as a copy of the Neovim plugin's stand-in and is kept separately on purpose.

A turn is steered by words in the prompt's last text block:
  PERM            asks for an approval
  DIFFPERM <path> asks for an approval that carries a diff, and writes the file when allowed
  WRITE <path>    rewrites that file
  READ <path>     asks the client for the file's text and says it back
  PUT <path>      asks the client to make "put by the agent" + a line break the file's text; writes
                  the disk itself when the client answers with an error, as the CLI does
  SHOW <path>     shows that file through a handle
  SHOWTEXT <path> shows that file as text
  META            says back the editor context the prompt carried
  SETTLE          asks for an approval and then withdraws it
  SLOW            waits to be cancelled
  CRASH           exits
A completion is steered by words in its prefix (SLOWC waits to be cancelled, FAILC fails), a
rewrite by words in its instruction (SLOWE waits to be cancelled).

Environment: FAKE_AGENT_LOG (every message received is appended, one JSON object a line),
FAKE_AGENT_AUTOCOMPLETE (the saved autocomplete model; "none": nobody has chosen one),
FAKE_AGENT_PLAIN=1 (an agent from before the editor's methods: no capabilities, no methods).
"""
import base64
import hashlib
import json
import os
import sys
import threading

LOG = os.environ.get("FAKE_AGENT_LOG")
PLAIN = os.environ.get("FAKE_AGENT_PLAIN") == "1"
lock = threading.Lock()
waiting = {}
cancelled = threading.Event()
next_id = [1000]

MODELS = [
    {"id": "example/model-a", "name": "Model A", "for": ["main", "autocomplete"], "default": True},
    {"id": "example/model-b", "name": "Model B", "for": ["main", "autocomplete"]},
    {"id": "example/model-c", "name": "Model C", "for": ["main"]},
]
saved = os.environ.get("FAKE_AGENT_AUTOCOMPLETE", "example/model-a")
settings = {"autocomplete_model": None if saved == "none" else saved, "main_model": None}
session_model = ["example/model-a"]

completions = {}  # the client's id -> Event set when it is cancelled
complete_lock = threading.Lock()
running_completion = [None]  # (client id, Event)
edits = {}
handles = {}  # handle -> bytes


def out(msg):
    with lock:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


def result(msg, value):
    out({"jsonrpc": "2.0", "id": msg["id"], "result": value})


def refuse(msg, code, message, reason=None):
    error = {"code": code, "message": message}
    if reason:
        error["data"] = {"reason": reason}
    out({"jsonrpc": "2.0", "id": msg["id"], "error": error})


def update(session, body):
    out({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session, "update": body}})


def say(session, text):
    update(session, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}})


def ask(method, params, wait=10):
    with lock:
        next_id[0] += 1
        rid = next_id[0]
    done = threading.Event()
    waiting[rid] = [done, None]
    out({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    done.wait(wait)
    return waiting.pop(rid)[1]


def read(path, mode="r"):
    with open(path, mode) as f:
        return f.read()


def word_after(text, word):
    return text.split(word + " ", 1)[1].split()[0]


def editor_settings():
    return {"autocomplete": {"model": settings["autocomplete_model"],
                             "source": "person" if settings["autocomplete_model"] else None,
                             "allowed": ["example/model-a", "example/model-b"]},
            "main": {"model": settings["main_model"]}}


def prompt(msg):
    p = msg["params"]
    session = p["sessionId"]
    text = [b["text"] for b in p["prompt"] if b["type"] == "text"][-1]
    update(session, {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "hidden thought"}})
    say(session, "Hello ")
    say(session, "there.\nSecond line")
    options = [{"optionId": "once", "name": "Allow once", "kind": "allow_once"},
               {"optionId": "deny", "name": "Deny", "kind": "reject_once"}]
    if "META" in text:
        say(session, "\neditor=" + json.dumps(((p.get("_meta") or {}).get("lembas") or {}).get("editor"), sort_keys=True))
    if "DIFFPERM " in text:
        path = word_after(text, "DIFFPERM")
        old = read(path) if os.path.exists(path) else None
        new = "rewritten by the agent\n"
        diff = [{"type": "diff", "path": path, "oldText": old, "newText": new}]
        answer = ask("session/request_permission", {
            "sessionId": session,
            "toolCall": {"toolCallId": "edit-" + str(msg["id"]), "title": "edit " + os.path.basename(path), "kind": "edit",
                         "status": "pending", "rawInput": {}, "content": diff},
            "options": options,
            "_meta": {"lembas": {"tool": "edit", "reason": "manual mode asks about every edit"}}})
        got = (answer or {}).get("outcome", {})
        if got.get("optionId") == "once":
            update(session, {"sessionUpdate": "tool_call", "toolCallId": "d1", "title": "edit " + os.path.basename(path),
                             "kind": "edit", "status": "in_progress"})
            with open(path, "w") as f:
                f.write(new)
            update(session, {"sessionUpdate": "tool_call_update", "toolCallId": "d1", "status": "completed",
                             "content": [{"type": "content", "content": {"type": "text", "text": "done"}}] + diff})
        say(session, "\nanswer=" + str(got.get("optionId") or got.get("outcome")))
    elif "SETTLE" in text:
        call = "settle-" + str(msg["id"])

        def withdraw():
            out({"jsonrpc": "2.0", "method": "_lembas/permission/settled", "params": {"sessionId": session, "toolCallId": call}})
        threading.Timer(0.2, withdraw).start()
        answer = ask("session/request_permission", {
            "sessionId": session,
            "toolCall": {"toolCallId": call, "title": "make build", "kind": "execute", "status": "pending", "rawInput": {}},
            "options": options, "_meta": {"lembas": {"tool": "bash"}}})
        got = (answer or {}).get("outcome", {})
        say(session, "\nanswer=" + str(got.get("optionId") or got.get("outcome")))
    elif "PERM" in text:
        answer = ask("session/request_permission", {
            "sessionId": session,
            "toolCall": {"toolCallId": "perm-" + str(msg["id"]), "title": "rm -r build", "kind": "execute", "status": "pending", "rawInput": {}},
            "options": options,
            "_meta": {"lembas": {"tool": "bash", "reason": "deletes files"}}})
        got = (answer or {}).get("outcome", {})
        say(session, "\nanswer=" + str(got.get("optionId") or got.get("outcome")))
    if "WRITE " in text:
        path = word_after(text, "WRITE")
        update(session, {"sessionUpdate": "tool_call", "toolCallId": "c1", "title": "edit " + os.path.basename(path),
                         "kind": "edit", "status": "in_progress"})
        with open(path, "w") as f:
            f.write("rewritten by the agent\n")
        update(session, {"sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed"})
    if "READ " in text:
        path = word_after(text, "READ")
        answer = ask("fs/read_text_file", {"sessionId": session, "path": path})
        say(session, "\nread=" + json.dumps((answer or {}).get("content")))
    if "PUT " in text:
        path = word_after(text, "PUT")
        with lock:
            next_id[0] += 1
            rid = next_id[0]
        done = threading.Event()
        waiting[rid] = [done, None]
        out({"jsonrpc": "2.0", "id": rid, "method": "fs/write_text_file",
             "params": {"sessionId": session, "path": path, "content": "put by the agent\n"}})
        done.wait(10)
        answer = waiting.pop(rid)[1]
        if answer is None:
            with open(path, "w") as f:
                f.write("put by the agent\n")
        say(session, "\nput=" + ("client" if answer is not None else "disk"))
    if "SHOWTEXT " in text:
        path = word_after(text, "SHOWTEXT")
        answer = ask("_lembas/show", {"sessionId": session, "toolCallId": "show-t", "path": os.path.basename(path),
                                      "kind": "text", "text": read(path)})
        say(session, "\nshown=" + json.dumps(answer, sort_keys=True))
    elif "SHOW " in text:
        path = word_after(text, "SHOW")
        data = read(path, "rb")
        handle = "h_" + str(msg["id"])
        handles[handle] = data
        params = {"sessionId": session, "toolCallId": "show-" + str(msg["id"]), "path": os.path.basename(path),
                  "kind": "binary", "mimeType": "application/octet-stream", "size": len(data),
                  "hash": "sha256:" + hashlib.sha256(data).hexdigest(), "handle": handle}
        if "WITHURI" in text:
            params["uri"] = "file://" + os.path.abspath(path)
        if "BADHASH" in text:
            params["hash"] = "sha256:" + "0" * 64
        answer = ask("_lembas/show", params, 30)
        handles.pop(handle, None)
        say(session, "\nshown=" + json.dumps(answer, sort_keys=True))
    if "QUESTION" in text:
        answer = ask("_lembas/question", {
            "sessionId": session,
            "toolCallId": "q-" + str(msg["id"]),
            "why": "Need a choice",
            "questions": [{
                "header": "Database",
                "question": "Which backend?",
                "multiple": False,
                "options": [{"label": "SQLite", "description": "local file"}, {"label": "Postgres", "description": "server"}],
            }],
        })
        say(session, "\nquestion=" + json.dumps(answer, sort_keys=True))
    if "PLANCARD" in text:
        answer = ask("_lembas/plan", {
            "sessionId": session,
            "toolCallId": "p-" + str(msg["id"]),
            "path": ".agent/plans/test.md",
            "text": "# Upgrade\n- Step 1\n- Step 2",
            "plan": {"title": "Upgrade", "phases": [{"title": "Phase 1", "tasks": [{"text": "Step 1", "status": "todo"}]}]},
        })
        say(session, "\nplan=" + json.dumps(answer, sort_keys=True))
    if "CRASH" in text:
        sys.stderr.write("not signed in: run lembas login\n")
        sys.stderr.flush()
        os._exit(3)
    stop = "end_turn"
    if "SLOW" in text.replace("SLOWC", "").replace("SLOWE", ""):
        stop = "cancelled" if cancelled.wait(10) else "end_turn"
        cancelled.clear()
    result(msg, {"stopReason": stop})


def complete(msg):
    p = msg["params"]
    cid = p.get("id")
    mine = threading.Event()
    with complete_lock:
        before = running_completion[0]
        running_completion[0] = (cid, mine)
        if cid:
            completions[cid] = mine
    if before:
        before[1].set()  # a newer request cancels the older
    try:
        model = p.get("model") or settings["autocomplete_model"]
        if not model:
            return refuse(msg, -32602, "No autocomplete model is chosen. Choose one in your settings on the server.", "no_model")
        if model == "example/model-c":
            return refuse(msg, -32602, "Model C is not allowed for autocomplete.", "not_allowed")
        prefix = p.get("prefix", "")
        if "FAILC" in prefix:
            return refuse(msg, -32603, "The server did not answer.")
        if "SLOWC" in prefix:
            mine.wait(10)
        elif mine.wait(0.05):
            pass
        if mine.is_set():
            return result(msg, {"text": "", "cancelled": True})
        last = prefix.split()[-1] if prefix.split() else ""
        result(msg, {"text": "<" + last + "|" + model + ">", "model": model, "finish": "stop"})
    finally:
        with complete_lock:
            if running_completion[0] and running_completion[0][1] is mine:
                running_completion[0] = None
            if cid:
                completions.pop(cid, None)


def edit(msg):
    p = msg["params"]
    eid = p.get("id")
    mine = threading.Event()
    if eid:
        edits[eid] = mine
    try:
        if not p.get("text") or not p.get("instruction"):
            return refuse(msg, -32602, "text and instruction are needed")
        if "SLOWE" in p["instruction"]:
            mine.wait(10)
        if mine.is_set():
            return result(msg, {"text": "", "cancelled": True})
        if p["instruction"].startswith("REPLACE "):
            new = p["instruction"][len("REPLACE "):].replace("\\n", "\n")
        else:
            new = p["text"].upper()
        if eid:
            half = len(new) // 2
            for piece in (new[:half], new[half:]):
                out({"jsonrpc": "2.0", "method": "_lembas/edit/delta", "params": {"id": eid, "delta": piece}})
        result(msg, {"text": new, "model": p.get("model") or session_model[0]})
    finally:
        if eid:
            edits.pop(eid, None)


def show_read(msg):
    p = msg["params"]
    data = handles.get(p.get("handle"))
    if data is None:
        return refuse(msg, -32602, "This file is no longer offered.")
    offset = int(p.get("offset") or 0)
    length = min(int(p.get("length") or 1000), 1000)  # small parts, so a client has to loop
    part = data[offset:offset + length]
    result(msg, {"data": base64.b64encode(part).decode(), "offset": offset, "eof": offset + len(part) >= len(data)})


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
            meta = {} if PLAIN else {"lembas": {"protocol": 3, "harness_spec": "3.11.0", "limits": None, "connection": "example",
                                                "capabilities": ["configure", "show", "editor", "media", "files", "commands", "steer", "sessions", "ask", "plan", "compact"]}}
            result(msg, {"protocolVersion": 1, "agentCapabilities": {}, "agentInfo": {"name": "stand-in", "version": "0"}, "_meta": meta})
        elif method == "session/new":
            wanted = (msg["params"].get("_meta") or {}).get("model")
            if wanted:
                session_model[0] = wanted
            result(msg, {
                "sessionId": "ses_test",
                "modes": {"currentModeId": "ask", "availableModes": [{"id": "ask", "name": "Ask"}, {"id": "edit", "name": "Edit"}]},
                "_meta": {"lembas": {"model": session_model[0], "mode": "ask"}}})
        elif method == "session/prompt":
            threading.Thread(target=prompt, args=(msg,), daemon=True).start()
        elif method == "session/cancel":
            cancelled.set()
        elif method == "session/set_mode":
            result(msg, {})
            update(msg["params"]["sessionId"], {"sessionUpdate": "current_mode_update", "currentModeId": msg["params"]["modeId"]})
        elif method == "_lembas/configure":
            session_model[0] = msg["params"].get("model") or session_model[0]
            result(msg, {"model": session_model[0], "effort": "default"})
        elif PLAIN and "id" in msg:
            refuse(msg, -32601, "Method not found")
        elif method == "_lembas/models":
            result(msg, {"models": MODELS, **editor_settings()})
        elif method == "_lembas/editor/settings":
            for key, value in (msg["params"].get("set") or {}).items():
                if key in settings:
                    settings[key] = value
            result(msg, editor_settings())
        elif method == "_lembas/complete":
            threading.Thread(target=complete, args=(msg,), daemon=True).start()
        elif method == "_lembas/complete/cancel":
            event = completions.get(msg["params"].get("id"))
            if event:
                event.set()
        elif method == "_lembas/edit":
            threading.Thread(target=edit, args=(msg,), daemon=True).start()
        elif method == "_lembas/edit/cancel":
            event = edits.get(msg["params"].get("id"))
            if event:
                event.set()
        elif method == "_lembas/show/read":
            show_read(msg)
        elif method == "_lembas/complete/warm":
            pass
        elif method == "_lembas/files/search":
            q = str((msg.get("params") or {}).get("query") or "").lower()
            sample = [
                {"path": "src/app.py", "kind": "file"},
                {"path": "src/utils.py", "kind": "file"},
                {"path": "src", "kind": "dir"},
                {"path": "README.md", "kind": "file"},
            ]
            result(msg, {"root": os.getcwd(), "files": [f for f in sample if not q or q in f["path"].lower()]})
        elif method == "_lembas/commands":
            result(msg, {"commands": [{"name": "compact", "description": "Compact context", "_meta": {"lembas": {"kind": "builtin"}}}]})
        elif method == "_lembas/session/compact":
            result(msg, {"summary": "Compacted 2 turns."})
        elif method == "_lembas/steer":
            result(msg, {"queued": 1})
        elif method == "_lembas/sessions/list":
            result(msg, {"sessions": [{"id": "ses_prev", "title": "Earlier work", "model": "example/model-a", "updated": 1700000000000}]})
        elif method == "_lembas/sessions/resume":
            sid = (msg.get("params") or {}).get("sessionId") or "ses_prev"
            result(msg, {
                "sessionId": sid,
                "title": "Earlier work",
                "modes": {"currentModeId": "edit", "availableModes": [{"id": "ask", "name": "Ask"}, {"id": "edit", "name": "Edit"}]},
                "turns": [
                    {"role": "user", "text": "earlier question"},
                    {"role": "assistant", "text": "earlier answer", "reasoning": "", "tools": [{"id": "t1", "name": "read", "args": "{}", "output": "ok"}]},
                ],
                "_meta": {"lembas": {"model": session_model[0], "mode": "edit"}},
            })
        elif "id" in msg:
            refuse(msg, -32601, "Method not found")


main()
