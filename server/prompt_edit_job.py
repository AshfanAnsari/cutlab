#!/usr/bin/env python3
"""
CutLab server job: prompt_edit (parked-features plan, Feature 1 §8).

Bundle contract: job.json only —
  {version: 1, type: "prompt_edit", instruction: str, project: {...},
   tokenHash?: str}
No media travels with this job: the project JSON is the whole input.

Flow: the instruction + current project go to the LLM lane
(server/llm_lane.py); the reply must be {"project": ..., "summary": ...}.
The revised project is validated against the project schema
(server/project_schema.py — unknown fields rejected, clip references must
exist, the media registry must be identical) BEFORE anything is written.
Any failure exits non-zero with a plain reason and the worker fails the
job — the editor shows its error state and nothing changes. There is no
partial-apply path.

Output (--out revised.json): {project, summary, lane}

Usage: python3 prompt_edit_job.py BUNDLE.zip --out revised.json
"""
import argparse, json, os, sys, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import llm_lane
import project_schema

SYSTEM = """You are the editing engine inside CutLab, a video editor. You receive a project as JSON and an instruction. Return ONLY a JSON object of the form {"project": <the full revised project>, "summary": "<one short paragraph saying what changed>"}.

Rules:
- Return the COMPLETE project object, not a patch. Keep every id stable: clip ids, track ids and media ids must not change, and do not add, remove, or rename entries in the "media" array.
- Change only what the instruction asks for. Everything else stays byte-identical in meaning.
- Respect the schema exactly: no new fields, no renamed fields. Clip kinds: a clip with "media"/"in"/"out" is a media clip; a clip with "text"/"dur" is a caption; a clip with "nest" is a compound clip; a clip with "adj": true is an adjustment clip. Times are seconds. Text clips live on text tracks, audio clips on audio tracks, the rest on video tracks.
- Only media and compound clips have a "transform" object. Text clips have NO transform: their position is the "x"/"y" fields (fractions of the canvas, anchor centre — y 0.12 is near the top, y 0.85 near the bottom) and their size is "fontSize". Audio clips have neither transform nor x/y.
- "summary" is plain language for the editor user, no jargon, no markdown."""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bundle")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    with zipfile.ZipFile(args.bundle) as z:
        job = json.loads(z.read("job.json"))
    instruction = (job.get("instruction") or "").strip()
    project = job.get("project")
    if not instruction:
        print("prompt_edit job has no instruction", file=sys.stderr)
        return 2
    errs = project_schema.validate_project(project)
    if errs:
        print("incoming project failed schema validation: " + "; ".join(errs[:5]),
              file=sys.stderr)
        return 2

    user = ("Instruction: " + instruction + "\n\nProject JSON:\n"
            + json.dumps(project, separators=(",", ":")))
    try:
        reply, lane = llm_lane.chat_json(SYSTEM, user)
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return 3

    revised = reply.get("project") if isinstance(reply, dict) else None
    summary = reply.get("summary") if isinstance(reply, dict) else None
    if not isinstance(revised, dict) or not isinstance(summary, str):
        print("LLM reply was not {project, summary}", file=sys.stderr)
        return 2
    errs = project_schema.validate_project(revised)
    if errs:
        print("revised project failed schema validation: " + "; ".join(errs[:5]),
              file=sys.stderr)
        return 2
    reg_err = project_schema.media_registry_error(project, revised)
    if reg_err:
        print(reg_err, file=sys.stderr)
        return 2

    with open(args.out, "w") as f:
        json.dump({"project": revised, "summary": summary, "lane": lane}, f)
    print(f"prompt_edit ok via {lane}: {summary[:120]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
