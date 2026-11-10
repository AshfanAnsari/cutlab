#!/usr/bin/env python3
"""
CutLab live-control driver — the Jarvis end of the FigCraft-style command
channel (PLAN §10, CONTROL clarified).

  python3 control.py sessions [--limit N]
      List the app sessions that have announced themselves (newest first).

  python3 control.py send <session-id|latest> <kind> [args-json]
                          [--timeout SECONDS] [--poll SECONDS] [--no-wait]
      Insert a command row into cutlab_commands for the session and wait
      for the open app to execute it. Prints the result JSON on success;
      exits 1 when the app reports failure, 2 on timeout, 3 on usage or
      relay errors (including "the table does not exist yet").

  Command kinds (v1, implemented in src/services/control.ts):
      ping {}                                   -> liveness + project name
      getState {}                               -> project JSON + media list
      openCloudProject {projectId}
      addClip {assetId, trackId?, start?}
      trimClip {clipId, in, out}
      moveClip {clipId, start}
      splitClip {clipId, at}
      deleteClip {clipId}
      setVolume {clipId, volume}
      addText {text, start?, dur?, style?}
      updateText {clipId, text}
      saveCloud {}
      queueMediaJob {}
      queueRender {}
      previewSnapshot {maxWidth?}             -> playhead state + the
          primary video frame at the playhead as a JPEG data URL
          (image is null, with a note, when no video frame is up)
      applyOps {ops: [{op, ...args}, ...]}    -> Phase 2 parity: the
          full Phase 1 edit-op vocabulary (snake_case op names —
          add_clip, trim_clip, split_clip, set_transform, add_keyframe,
          set_grade_layer, add_effect, set_transition, add_text,
          set_text_style, set_clip_volume, set_audio_bus, add_marker,
          set_canvas, …; implemented client-side in
          src/services/editOps.ts) applied ATOMICALLY to the live
          project: one command = one undo step, and a failing op
          refuses the whole batch
      grabStill {t?, maxWidth?}               -> a clean still of the
          composited stage at the requested time (the app seeks to t
          first) + stage state; image is null, with a note, when no
          frame is available at the playhead
      getProjectSummary {}                    -> cheap structured
          summary (tracks / clips / duration / media counts) — the
          read an agent plans from, instead of the full project JSON
      listMarkers {}                          -> project.markers

  python3 control.py ops <session-id|latest> '<ops-json-array>'
                          [--timeout SECONDS] [--poll SECONDS] [--no-wait]
      Convenience passthrough for applyOps: takes a bare JSON array of
      ops and wraps it as {ops: [...]}.

Requires supabase/commands-migration.sql to have been run in the dashboard
(the app must also be open with its "Jarvis control" toggle ON — otherwise
the command simply waits in the queue until the timeout).

Phase 1 (supabase/phase1-migration.sql): command rows are stamped with
the session's user_id, copied from the app's session announcement —
under the owner-only RLS policies the app can only claim rows that
carry its own account id. Sessions announced before Phase 1 have no
user_id; their commands are inserted without one (the claim then rests
on the pre-Phase-1 policies — re-announce by toggling control off/on
after signing in to fix that).

Auth: the Supabase secret key reaches requests through Muse's credential
proxy (dynamic_credentials surrogate), exactly as in worker.py. The key
itself never appears here. Run with the egress proxy env set, like the
worker unit: HTTP_PROXY/HTTPS_PROXY=http://hatch-egress-proxy:3128.
"""
import argparse, json, sys, time, urllib.request, urllib.error, uuid
from datetime import datetime, timezone

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request

BASE = "https://hjdyvaetxhvxzgsdlibt.supabase.co"
HOST = "hjdyvaetxhvxzgsdlibt.supabase.co"
TABLE = "cutlab_commands"

KNOWN_COMMANDS = [
    "ping", "getState", "openCloudProject", "addClip", "trimClip",
    "moveClip", "splitClip", "deleteClip", "setVolume", "addText",
    "updateText", "saveCloud", "queueMediaJob", "queueRender",
    "previewSnapshot",
    # Phase 2 — live control parity (src/services/control.ts)
    "applyOps", "grabStill", "getProjectSummary", "listMarkers",
]

MISSING_TABLE_HINT = (
    "Table public.cutlab_commands does not exist yet — run "
    "supabase/commands-migration.sql in the Supabase dashboard SQL editor first."
)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused")


class RelayError(RuntimeError):
    pass


def call(method, path, body=None, prefer=None):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if prefer:
        headers["Prefer"] = prefer
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    add_surrogate_to_request(r, "custom.supabase", allowed_hosts=[HOST])
    try:
        with urllib.request.build_opener(NoRedirect()).open(r, timeout=300) as resp:
            payload = resp.read()
            if "application/json" in (resp.headers.get("Content-Type") or ""):
                return json.loads(payload) if payload else None
            return payload
    except urllib.error.HTTPError as e:
        detail = e.read()[:400]
        if e.code == 404 and TABLE in path:
            raise RelayError(MISSING_TABLE_HINT) from None
        raise RelayError(f"{method} {path} -> {e.code}: {detail!r}") from None


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def list_sessions(limit=500):
    """Session announcements (kind='session'), deduped to the newest row
    per session_id, most recently announced first."""
    try:
        rows = call(
            "GET",
            f"/rest/v1/{TABLE}?kind=eq.session&order=created_at.desc"
            f"&limit={limit}&select=session_id,command,created_at,user_id",
        ) or []
    except RelayError:
        # Pre-Phase-1 relay: no user_id column yet — list without it.
        rows = call(
            "GET",
            f"/rest/v1/{TABLE}?kind=eq.session&order=created_at.desc"
            f"&limit={limit}&select=session_id,command,created_at",
        ) or []
    seen = {}
    for row in rows:
        seen.setdefault(row["session_id"], row)
    return list(seen.values())


def resolve_session(which):
    if which != "latest":
        return which
    sessions = list_sessions(limit=50)
    if not sessions:
        raise RelayError(
            "No app session has announced itself — open CutLab and turn the "
            "'Jarvis control' toggle ON first."
        )
    return sessions[0]["session_id"]


def cmd_sessions(args):
    sessions = list_sessions(limit=max(args.limit * 4, 50))[: args.limit]
    if not sessions:
        print("No sessions announced yet. Open CutLab and turn 'Jarvis control' ON.")
        return 0
    print(f"{'SESSION':38}  {'ANNOUNCED (UTC)':27}  USER AGENT")
    for s in sessions:
        ua = (s.get("command") or {}).get("userAgent", "?")
        print(f"{s['session_id']:38}  {s['created_at']:27}  {ua}")
    print(f"\n{len(sessions)} session(s). 'latest' = {sessions[0]['session_id']}")
    return 0


def cmd_ops(args):
    """Passthrough helper: `ops <session> '[{...}, ...]'` is exactly
    `send <session> applyOps '{"ops": [...]}'` with the bare array
    unwrapped for convenience."""
    try:
        ops = json.loads(args.ops_json) if args.ops_json else None
    except json.JSONDecodeError as e:
        print(f"ops-json is not valid JSON: {e}", file=sys.stderr)
        return 3
    if not isinstance(ops, list) or not ops:
        print("ops-json must be a non-empty JSON array of ops, "
              "e.g. '[{\"op\":\"trim_clip\",\"clipId\":\"...\",\"in\":1,\"out\":4}]'",
              file=sys.stderr)
        return 3
    wrapped = argparse.Namespace(
        session=args.session, kind="applyOps",
        args_json=json.dumps({"ops": ops}),
        timeout=args.timeout, poll=args.poll, no_wait=args.no_wait,
    )
    return cmd_send(wrapped)


def cmd_send(args):
    if args.kind not in KNOWN_COMMANDS and args.kind != "session":
        print(f"note: '{args.kind}' is not a known command kind "
              f"({', '.join(KNOWN_COMMANDS)}) — sending anyway; the app "
              "will report it as unknown if it is.", file=sys.stderr)
    try:
        args_obj = json.loads(args.args_json) if args.args_json else {}
    except json.JSONDecodeError as e:
        print(f"args-json is not valid JSON: {e}", file=sys.stderr)
        return 3
    if not isinstance(args_obj, dict):
        print("args-json must be a JSON object, e.g. '{\"clipId\":\"...\"}'", file=sys.stderr)
        return 3
    session_id = resolve_session(args.session)
    cmd_id = str(uuid.uuid4())
    body = {
        "id": cmd_id,
        "session_id": session_id,
        "kind": args.kind,
        "command": args_obj,
        "status": "queued",
        "updated_at": now_iso(),
    }
    # Phase 1: stamp the command with the session's account id so the
    # owner's app may claim it under the owner-only RLS policies. A
    # pre-migration relay (no user_id column) or an unscoped session
    # simply omits the field.
    try:
        for s in list_sessions(limit=50):
            if s["session_id"] == session_id and s.get("user_id"):
                body["user_id"] = s["user_id"]
                break
    except RelayError:
        pass
    call(
        "POST",
        f"/rest/v1/{TABLE}",
        body=body,
        prefer="return=representation",
    )
    print(f"queued {args.kind} -> session {session_id} (command {cmd_id})")
    if args.no_wait:
        print("--no-wait: not waiting for the app to execute it.")
        return 0
    deadline = time.time() + args.timeout
    last_status = None
    while True:
        rows = call(
            "GET",
            f"/rest/v1/{TABLE}?id=eq.{cmd_id}&select=status,result,error",
        ) or []
        if not rows:
            print("The command row vanished from the queue.", file=sys.stderr)
            return 3
        row = rows[0]
        if row["status"] != last_status:
            last_status = row["status"]
            print(f"  status: {last_status}")
        if row["status"] == "done":
            print(json.dumps(row.get("result") or {}, indent=2))
            return 0
        if row["status"] == "failed":
            print(f"FAILED: {row.get('error') or 'no error detail recorded'}", file=sys.stderr)
            return 1
        if time.time() > deadline:
            print(
                f"Timed out after {args.timeout}s — command {cmd_id} is still "
                f"'{row['status']}'. Is the app open with Jarvis control ON?",
                file=sys.stderr,
            )
            return 2
        time.sleep(args.poll)


def main():
    ap = argparse.ArgumentParser(
        description="Drive an open CutLab app live through the relay command channel."
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_sessions = sub.add_parser("sessions", help="List announced app sessions.")
    p_sessions.add_argument("--limit", type=int, default=10)
    p_sessions.set_defaults(fn=cmd_sessions)

    p_send = sub.add_parser("send", help="Send a command to a session and wait for its result.")
    p_send.add_argument("session", help="Session id, or 'latest'.")
    p_send.add_argument("kind", help="Command kind, e.g. ping, getState, trimClip.")
    p_send.add_argument("args_json", nargs="?", default=None,
                        help="Args as a JSON object string (default: {}).")
    p_send.add_argument("--timeout", type=float, default=300,
                        help="Seconds to wait for execution (default 300; "
                             "queueRender can legitimately take longer).")
    p_send.add_argument("--poll", type=float, default=2,
                        help="Seconds between status checks (default 2).")
    p_send.add_argument("--no-wait", action="store_true",
                        help="Queue the command and return immediately.")
    p_send.set_defaults(fn=cmd_send)

    p_ops = sub.add_parser(
        "ops", help="Send an applyOps batch (Phase 2 edit ops) from a bare JSON array.")
    p_ops.add_argument("session", help="Session id, or 'latest'.")
    p_ops.add_argument("ops_json",
                       help="Ops as a JSON array string, e.g. "
                            "'[{\"op\":\"set_canvas\",\"w\":1080,\"h\":1920}]'.")
    p_ops.add_argument("--timeout", type=float, default=300,
                       help="Seconds to wait for execution (default 300).")
    p_ops.add_argument("--poll", type=float, default=2,
                       help="Seconds between status checks (default 2).")
    p_ops.add_argument("--no-wait", action="store_true",
                       help="Queue the command and return immediately.")
    p_ops.set_defaults(fn=cmd_ops)

    args = ap.parse_args()
    try:
        return args.fn(args)
    except RelayError as e:
        print(f"relay error: {e}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
