# CutLab architecture

## One document, three surfaces

A CutLab project is a single JSON document (`src/types.ts` is the
canonical shape). Three surfaces edit it through one shared op
vocabulary (~57 pure ops in the editOps / ops implementations):

1. **The editor UI** — React + TypeScript. Folders by job:
   `components/` render, `services/` hold logic, `state/` is the one
   central store (state flows out, actions flow in, undo/redo built on
   op application). `engine/` evaluates the document per-time for
   preview and playback.
2. **The MCP server** — `supabase/functions/cutlab-mcp/`, a Deno edge
   function exposing 96+ tools (groups A–J). Editing tools run the
   write path in `ops.ts`: load → apply ops → validate against
   `schema.ts` → guarded save with optimistic concurrency on the
   project's `revision` column → append to the project's `editLog`.
   The media registry may only change through the group-B media tools.
3. **The live channel** — `src/services/control.ts` relays commands
   (19 total) into an open editor via the `cutlab_commands` table +
   realtime; the editor applies them with `editOps.ts`'s `applyOps`,
   one command = one undo step.

## The relay

All hosted state sits in one Supabase project:

- Tables: `cutlab_projects`, `cutlab_media`, `cutlab_jobs`,
  `cutlab_commands`, `cutlab_tokens`, `cutlab_project_versions`.
- Storage: one private bucket, `cutlab`. App-written objects live under
  `users/<uid>/jobs/<job_id>/…` and `users/<uid>/projects/<project_id>/…`
  (`src/services/relayAccess.ts` builds every path).
- Auth: the client carries only the **publishable** key; the bearer is
  the signed-in user's JWT when a session exists, so RLS scopes every
  row and object to its owner. Since the Phase-1 migration the anon
  role holds **no** CutLab policies — cloud features require sign-in;
  local editing never touches the relay for its own data.
- The **service-role key exists only** in the edge functions and the
  worker's environment. It never appears in the client.

## Jobs and rendering

Heavy work is a job row, not a request: proxies/thumbnails/waveform
peaks (`server/make_proxies.py`), transcription, beat detection,
tracking, reframe, voice separation, prompt-edit and renders
(`server/render_job.py` → `render-lane-b/render.py`).

Lane B renders project JSON + media to MP4 with ffmpeg + PIL
(H.264, CRF 18, bt709, metadata stripped), then verifies its own
output: ffprobe facts + frame grabs are attached to the job, failures
carry structured stage errors and are retried once automatically.
Export side-formats (SRT/VTT captions, EDL, FCP7 XML, GIF, loudness
presets) are produced in the same pass.

A render job can also be claimed by an external machine through the
render-lane MCP tools (`list_waiting_render_jobs` / `claim_render_job`
/ `complete_render_job`), which is how an agent's own computer becomes
a render node.

## The schema's three homes

The project-schema rule set is implemented three times — client
TypeScript (`src/services/promptSchema.ts`), Deno
(`supabase/functions/cutlab-mcp/schema.ts`) and Python
(`server/project_schema.py`) — and pinned to identical verdicts by
`scripts/mcp-harness.entry.ts`. A rule change lands in all three or
the harness goes red.

## The backend seam

The client only ever talks to interfaces in `src/services/`
(`ProjectStore`, `MediaStore`, `JobService`). Milestone 1 ships local
implementations (IndexedDB) plus the relay transport; a different
hosted backend can implement the same interfaces without touching
components. `src/services/jobsLocal.ts` is a labelled, disabled stub:
in-browser transcoding/export is intentionally not a path.
