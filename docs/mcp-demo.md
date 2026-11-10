# CutLab MCP: live demo script

*Run this after the Agent Control release is deployed. It takes about ten
minutes and uses only your own account, your own media and your own chat.
Nothing here is a mock: every step is a real tool call against the real
relay, and the demo ends with a rendered file you can play.*

*Prerequisite state, stated once: this demo needs the post-upgrade MCP
(the full A–J vocabulary). If step 1 shows only the seven render-lane
tools, the relay is still on the earlier release: stop and say so
rather than improvising.*

---

## Before you start

1. Sign in to CutLab in the browser and open **Settings → Connections**.
2. **Generate new token** (or verify an existing one reads *Connected*).
   The token starts with `clt_`. Keep it out of screenshots and chats you
   do not control; the relay stores only its hash.
3. Add the CutLab MCP server to your agent's MCP configuration
   (endpoint: `https://hjdyvaetxhvxzgsdlibt.supabase.co/functions/v1/cutlab-mcp`,
   header: `Authorization: Bearer clt_…`). Full instructions:
   `public/mcp-docs.html`, section "Connect".
4. Have one short video clip ready on the relay: either already in a
   CutLab project, or as a file your agent can upload in step 3 of the
   prompt below. A 20–40 second clip is ideal.

Fill in the two bracketed values in the prompt: your project name (or
"a new project") and your clip's name.

---

## The prompt (paste verbatim to your own agent)

```text
You are connected to my CutLab account through the CutLab MCP server.
Work only on my account, and tell me the tool you are about to call
before each call.

1. List my CutLab projects and confirm which project
   "<PROJECT NAME OR: a new project>" is. If I said a new project,
   create it as a 1080x1920, 30 fps project named "MCP demo".
2. Show me the project's summary (tracks, clips, duration, media)
   before you change anything.
3. Make sure the clip "<CLIP NAME>" is in the project's media. If it
   is not, request a media upload, upload it, and register it.
4. Put the clip on the first video track starting at 0. Trim it to
   its best 20 seconds if it is longer.
5. Grade it warm: set a grade layer with a slightly warm temperature,
   lifted shadows and gentle contrast. Then grab a still at the
   5-second mark and show it to me. Wait for my OK before continuing.
6. Transcribe the clip, then turn the transcription into captions on
   a text track.
7. Set the clip volume to -3 dB and add a 0.5 second fade out at the
   end.
8. Queue a render: 9:16 (1080x1920), MP4, H.264, CRF 18, output name
   "mcp-demo". Poll the job until it finishes.
9. When the render is done, show me: the job result, the render's
   verification frame grabs, and the download link. Summarise every
   edit you made, in order.
```

---

## Expected tool-call sequence

The agent should make these calls, in roughly this order. Names are the
exact MCP tool names from the upgrade plan (groups A–J).

| Step | Tool call | Why |
|---|---|---|
| 1 | `list_my_projects` | Find (or rule out) the named project on your account only. |
| 1 | `create_project` *(new project path only)* | Canvas 1080×1920, 30 fps, name "MCP demo". |
| 2 | `get_project_summary` | The cheap planning read: tracks, clips, duration, media. |
| 3 | `list_media` | Check the registry before adding anything. |
| 3 | `request_media_upload` → upload → `register_media` *(only if the clip is missing)* | The registry changes only through the media tools. |
| 4 | `add_clip` | Place the clip at 0 on the first video track. |
| 4 | `trim_clip` *(only if longer than 20 s)* | In/out to the chosen 20 seconds. |
| 5 | `set_grade_layer` | Warm temperature, lifted shadows, gentle contrast, in one validated grade object. |
| 5 | `grab_still` | Renders one frame at t = 5 s and returns a signed URL. **This is the first verification moment** (see below). |
| 6 | `transcribe` | Queues the transcription job; word timings come back with it. |
| 6 | `captions_from_transcription` | Word timings become caption text clips on a text track. |
| 7 | `set_clip_volume` | −3 dB. |
| 7 | `set_fades` | 0.5 s fade out. |
| 8 | `queue_render` | Container MP4, codec H.264, 1080×1920, CRF 18, output name "mcp-demo". |
| 8 | `get_job` (polled) | Status until `done`; a failure returns a structured, stage-level error, not a bare "failed". |
| 9 | `get_output_links` | Signed download link for the finished render. |

Notes for the presenter:

- Every write in steps 4–7 is schema-validated server-side and appended
  to the project's edit log. A refused write means the agent proposed
  something the editor itself would refuse; the agent should report the
  refusal, not retry blindly.
- If the agent claims it cannot find a tool above, it is connected to
  the pre-upgrade relay (seven render-lane tools only). That is the
  demo's built-in honesty check.

---

## The verification moment

This is the part to linger on. Two beats:

1. **Before the render: `grab_still`.** After grading, the agent does
   not ask you to trust it. It renders a single frame at 5 seconds and
   shows you the actual graded picture. The prompt makes the agent wait
   for your OK here. If the grade is wrong, say so in plain words
   ("cooler, less contrast") and the agent calls `set_grade_layer`
   again and grabs a new still. No render minutes are spent on a grade
   nobody has seen.

2. **After the render: verification grabs.** The finished job returns
   more than a status: the file's probe facts (dimensions, frame rate,
   duration, streams) and sampled frame grabs from the rendered MP4
   itself. Compare one grab against the still you approved: same frame,
   same grade, now in the delivered file. Then play the download.

Talking point, if you need one: *the agent showed its work twice, once before spending the render and once after, using frames from the
real project and the real output file.*

---

## If the agent renders it itself (render-lane variant)

If the demo agent can run code, queue the render with execution lane
`agent` instead of the server lane, and the second half of the demo
becomes the original render-lane flow:

1. `list_waiting_render_jobs`: the job appears, queued for your agent.
2. `claim_render_job`: claimed under a one-hour lease; returns the job
   payload and signed upload URLs.
3. `get_project` + `get_media_links`: the project JSON and time-limited
   URLs for every input file.
4. The agent renders locally with the CutLab renderer package.
5. Upload each output to its signed URL, then `complete_render_job`
   (or `fail_render_job` with the reason; never abandon a claimed job).

The seven tools in this variant (`list_my_projects`, `get_project`,
`get_media_links`, `list_waiting_render_jobs`, `claim_render_job`,
`complete_render_job`, `fail_render_job`) are the original 2026-11-05
MCP release, unchanged.

---

## Teardown

- The demo project and its render stay in your account; delete the
  project from the app whenever you like.
- Revoke the demo token in **Settings → Connections** if you created
  one just for this. The relay refuses it from that moment.
