# CutLab

**A video editor with 100% MCP.**
**100% of the engine is agent-callable — zero UI-only features.**

Every editing operation in CutLab — timeline, clips, keyframes, effects,
colour, text, audio, analysis, rendering — exists as an MCP tool. If a
human can do it in the editor, an AI agent can do it through the API,
with the same validation, the same undo semantics and the same render
pipeline. There is no second-class automation surface bolted on the side:
the MCP tools *are* the engine's write path.

🌐 **Live app:** https://ashfanansari.github.io/cutlab-x9p7/
📖 **MCP docs:** `public/mcp-docs.html` · **Demo script:** `docs/mcp-demo.md`

---

## Why "agent-callable" is the whole design

Most editors treat automation as an export format or a plugin API that
covers 10% of the product. CutLab inverts that:

- **The project is one JSON document.** A person edits it in the app; an
  agent edits it by writing the JSON. The same JSON drives the preview
  and the server render — there is no second representation.
- **One op vocabulary, three surfaces.** ~57 pure edit ops (timeline,
  transform/keyframes, effects, colour, text, audio) are shared by the
  MCP server, the live-control channel into the open editor, and the
  in-app prompt-edit path. Learn the ops once, drive CutLab from
  anywhere.
- **Guarded writes.** Every mutation runs read → apply → validate →
  save, with optimistic concurrency on the project's `revision` column
  and an `editLog` entry per change. Invalid edits are refused before
  anything is written, not cleaned up after.
- **Verified renders.** A finished render returns ffprobe facts and
  frame grabs, not just a file — an agent can *check its own work*.

## The MCP surface — 96+ tools, groups A–J

The MCP server (`supabase/functions/cutlab-mcp/`) is a stateless
streamable-HTTP endpoint. Connect with a per-user token and your agent
gets the full engine:

| Group | Covers |
|---|---|
| **A — Project** | create / duplicate / delete, canvas, markers, whole-document replace |
| **B — Media** | register / remove media, bins, signed upload + download links |
| **C — Timeline & clips** | add / trim / split / move clips, link groups, track ops |
| **D — Transform & animation** | position / scale / rotation, keyframes, easing |
| **E — Effects & transitions** | 13 effect types, transitions, masks |
| **F — Colour** | grading, LUT upload and application |
| **G — Text & captions** | text clips, styles, captions from transcription |
| **H — Audio** | levels, fades, voice separation, beat detection |
| **I — Analysis & AI jobs** | media analysis, tracking, reframe, prompt-based editing |
| **J — Jobs & export** | queue renders and jobs, poll, cancel, output links |

Editing tools share one write path (`ops.ts` — pure ops — plus
`schema.ts`, the project-schema rule set). Media may only change through
the group-B media tools; a whole-document replace that tries to smuggle
a media change is refused.

### The live channel

Point an agent at the editor a human has open and it can drive it in
real time: **19 commands** over the same 57-op vocabulary
(`src/services/control.ts` + `editOps.ts`). One command = one undo step,
so a human can watch an agent edit and roll back any single move.

### Connect your chat, not an API key

AI features inside CutLab are driven by the *user's own* chat/agent
connection (a `clt_…` connect token), never by a CutLab-held LLM API
key. Your agent is the brain; CutLab is the pair of hands.

## Rendering & export

Rendering is server-first, so a modest PC only ever runs the interface:

- **Lane B renderer** (`render-lane-b/render.py`) — project JSON + media
  → MP4 (H.264, CRF 18, bt709, metadata stripped), ffmpeg + PIL.
- **Worker** (`server/`) — proxies, thumbnails, waveform peaks,
  transcription, beat detection, tracking, voice separation, renders —
  as background jobs over a Supabase relay (tables + storage bucket).
- **Exports** — MP4 plus caption files (**SRT / VTT** from word
  timings), **EDL** and **FCP7 XML** for handing off to other editors,
  **GIF** companions, and platform **loudness (LUFS)** presets.
- **Verification** — every render is ffprobe-checked with frame grabs;
  failures carry structured stage errors and get one automatic retry.
- **Render lanes** — jobs can run on the server worker or be claimed by
  an agent's own machine through the render-lane MCP tools.

Effects shelf (13): brightness, contrast, saturation, blur, glow,
sharpen, vignette, tv-lines, haze, wide-angle, motion-blur, relight,
turbulent-displace — most of them keyframable. Transitions include
dissolve, slide, zoom, shake, flash/glare, mask-wipe and blur-cut.

## Run it locally

**Editor only (local editing works fully offline):**

```bash
npm install
npm run dev        # http://localhost:5173
```

On Windows, `run-locally.bat` does the same in one double-click.

**Full stack (cloud projects, MCP, renders):**

1. Create a Supabase project and run the migrations in `supabase/`
   (schema, storage policies, then the phase/jobs/commands upgrades).
2. Deploy the two edge functions in `supabase/functions/`
   (`cutlab-mcp`, `cutlab-account`) — see
   `supabase/functions/cutlab-mcp/DEPLOY.md`. Set the secrets from
   `.env.example`; the service-role key lives **only** here and on the
   worker, never in the client.
3. Point the client at your project (`SUPABASE_URL` +
   the *publishable* key in `src/services/supabase.ts` — that key is
   public by design; row-level security does the guarding).
4. Run a worker: `server/worker.py` with the same env (see
   `DEPLOYMENT.md`). Originals stay on your machine; the relay carries
   proxies and job payloads.

An example project ships in `examples/karina.cutlab.json`.

## Architecture in one paragraph

A light React + TypeScript editor (folders by job, UI separated from
logic, one central store) talks to a Supabase relay — Postgres tables
(`cutlab_projects / cutlab_media / cutlab_jobs / cutlab_commands /
cutlab_tokens / cutlab_project_versions`) plus a private `cutlab`
storage bucket. A Python worker claims jobs, runs the heavy lanes and
posts results back. The project schema has three twin validators
(TypeScript, Deno, Python) pinned to identical verdicts by a parity
harness. Details: [ARCHITECTURE.md](ARCHITECTURE.md).

## Status & honest limitations

- **Beta.** The hosted instance is live and in daily use; the free
  relay caps accounts at **2 projects** (the owner account is exempt)
  to protect the free tier.
- Rendering needs a worker machine — there is intentionally **no**
  in-browser transcoding path.
- The owner-only live-control surface is gated to a single configured
  account UID in this build.
- The engine is ahead of the polish: expect the editor UI to keep
  changing faster than the API, which is versioned by the project
  schema instead.

## Repo layout

```
src/            the editor (components / engine / services / state)
supabase/       relay migrations + the MCP & account edge functions
server/         the Python worker (jobs: proxies, analysis, renders)
render-lane-b/  the renderer: project JSON + media → MP4
scripts/        parity + harness scripts
docs/           MCP demo script, registry listings
examples/       an acceptance project as CutLab JSON
```

---

Built by [Ashfan Ansari](https://github.com/AshfanAnsari) with a crew of
AI agents — which is rather the point. If an agent-callable video editor
sounds useful, a ⭐ tells us people care.
