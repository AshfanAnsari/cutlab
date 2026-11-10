# Registry listing copy: CutLab MCP

> **DRAFT: awaiting user go for submission. Do not submit anywhere.**
> Copy below is submission-ready; every factual claim in it is drawn
> from `public/mcp-docs.html` and the upgrade plan. No directory has
> been contacted, no listing has been filed, no account has been
> created for this. Submitting is a separate, user-approved step.
>
> Items marked **[proposed]** are choices for the user to confirm at
> submission time, not facts about an existing listing.

---

## Shared facts (single source for every directory)

- **Server name [proposed]:** `io.github.AshfanAnsari/cutlab`
  (MCP Registry reverse-DNS form, from the GitHub account that hosts
  the CutLab site. Alternative if the registry prefers the product
  domain form: confirm at submission.)
- **Display name:** CutLab
- **Endpoint:** `https://hjdyvaetxhvxzgsdlibt.supabase.co/functions/v1/cutlab-mcp`
- **Transport:** Streamable HTTP, stateless JSON-RPC 2.0 (MCP protocol
  version 2025-03-26). No local install, no stdio package.
- **Auth:** Bearer connect token issued in the CutLab app
  (`Authorization: Bearer clt_…`). Per-account scoped; only the token's
  SHA-256 hash is stored server-side. No API key for any AI provider is
  involved at any point.
- **Homepage:** https://ashfanansari.github.io/cutlab-x9p7/
- **Docs:** https://ashfanansari.github.io/cutlab-x9p7/mcp-docs.html
  *(URL assumes the `public/` page deploys at the app root, as built.)*
- **Positioning (user-locked, 2026-11-09):** lead with the "100%" term —
  100% of the engine, zero UI-only features. Other editors count commands;
  CutLab exposes the whole engine. Do not headline a tool count.
- **Licence / pricing:** CutLab is in beta and free during beta. The
  MCP server is a hosted endpoint, not an open-source package; say so
  plainly wherever a directory asks.

---

## Short description (one line, ≤ 160 characters)

> Edit video with your own AI chat: a hosted MCP server giving your
> agent 100% control of the CutLab editor — every edit callable, no API key.

Character count: 141.

## Short blurb (Smithery / PulseMCP card length)

> CutLab is a video editor that runs in the browser, and its MCP server
> hands the whole editor to the AI assistant you already use. Connect
> with a personal token from the app (your chat, never an API key),
> and your agent can build timelines, trim and split clips, animate,
> grade with wheels, curves and LUTs, caption from transcription, mix
> audio, queue renders, and even render jobs on its own machine.
> Every write is validated against the project schema and logged;
> finished renders come back with frame grabs so the agent can show
> its work.

## Long description (registry / mcp.so detail page)

> **Your video editor, driven by your chat.**
>
> CutLab is a timeline video editor that runs entirely in the browser:
> nothing to install, originals stay on your machine, and renders run
> on CutLab's server or on your own agent's machine. The CutLab MCP
> server exposes the editor's full engine to any MCP client: the same
> engine the web UI uses, not a reduced automation subset.
>
> **What your agent can do** (ten tool groups, A–J):
>
> - **Project:** create, duplicate, rename, batch-apply edits, set
>   canvas and timeline range, markers, cheap summary reads.
> - **Media:** signed uploads into the project scope, registry
>   management, bins, media analysis (proxies, thumbnails, waveforms).
> - **Timeline:** tracks and flags, add / move / trim / split /
>   duplicate clips, speed ramps, reverse, freeze frames, linking,
>   compounds, adjustment clips, multicam angle cuts.
> - **Transform & animation:** transform, keyframes with bezier and
>   hold easing, crop, blend modes, masks, chroma key, mattes.
> - **Effects & transitions:** all 12 effects and 11 transitions the
>   renderer ships.
> - **Colour:** the full grade object: primaries, lift/gamma/gain/
>   offset wheels, RGB and hue curves, HSL, qualifier key, LUTs
>   (list, apply, upload .cube), stacked grade layers, project look,
>   plus `grab_still`, which renders one frame so the agent can see
>   its own grade.
> - **Text & captions:** full typography control, presets, text
>   animation, and captions generated from transcription word timings.
> - **Audio:** volume and volume keyframes, fades, pan, 6-band
>   parametric EQ, denoise, voice effects, demucs voice separation,
>   and the master bus (gain, loudness normalise, compressor, ducking).
> - **Analysis & AI jobs:** transcription, beat detection, region
>   tracking, smart reframe, replicate-an-edit analysis, and
>   natural-language prompt edits as pollable jobs.
> - **Jobs & export:** the full render surface (MP4/MOV, H.264/H.265,
>   size, fps, CRF/bitrate, ranged export, extra aspect ratios in one
>   job), job polling and cancellation, signed output links, plus the
>   original agent render lane: claim a render job under a lease,
>   fetch its inputs, render locally, upload, complete.
>
> **Guardrails.** Every call is scoped to the account that issued the
> connect token; there is no parameter that widens it. Every write is
> validated against CutLab's strict project schema before it lands,
> stale writes are refused, and every agent mutation is appended to
> the project's edit log. Relay quotas are unchanged: 50 MB per file,
> 200 MB per user.
>
> **Why it is different.** Other agent-for-video setups ask for an AI
> provider's API key or sell credits. CutLab connects the chat you
> already have: the token is the whole arrangement, revocable at any
> time. And renders verify themselves: finished jobs return probe
> facts and sampled frame grabs, and failures return structured,
> stage-level errors.
>
> **Status.** Beta. The vocabulary above is the Agent Control release
> (2026-11-09); the seven render-lane tools date from the first MCP
> release (2026-11-05) and are unchanged.

## Category tags

Primary picks (use the closest match each directory offers):

- `video-editing`
- `video`
- `media`
- `creative-tools`
- `automation`

Secondary, where multiple tags are allowed: `ai-agents`,
`content-creation`, `remote-server`, `hosted`.

---

## Connect snippet (all directories)

```json
{
  "mcpServers": {
    "cutlab": {
      "url": "https://hjdyvaetxhvxzgsdlibt.supabase.co/functions/v1/cutlab-mcp",
      "headers": {
        "Authorization": "Bearer clt_REPLACE_WITH_YOUR_TOKEN"
      }
    }
  }
}
```

Get a token: open CutLab → sign in → **Settings → Connections →
Generate new token**. Revoke in the same place at any time.

For clients that cannot set headers, the server also accepts the
token in the `x-cutlab-token` header.

---

## Per-directory notes

### Official MCP Registry (registry.modelcontextprotocol.io)

- Server name **[proposed]:** `io.github.AshfanAnsari/cutlab`
- Entry type: remote server, Streamable HTTP, with a required
  `Authorization` header (secret). There is no package to publish: the
  `server.json` describes the hosted endpoint only.
- Title: "CutLab: video editing for your agent"
- Description: use the one-line short description above (registry
  descriptions are length-capped; trim to "…full, validated control
  of the CutLab browser editor." if the cap bites).
- Before submitting: the registry's ownership check for the
  `io.github.AshfanAnsari` namespace runs through the GitHub account;
  have it signed in.

### Smithery

- Listing type: hosted / remote server (no local install command;
  Smithery will ask; do not invent an `npx` command, there is none).
- Description: short blurb above.
- Config schema to declare: one field, `connectToken` (string,
  secret), mapped to the `Authorization: Bearer` header in the
  connect snippet.
- Tags: video-editing, media, creative-tools, automation.

### PulseMCP

- Description: short blurb above; PulseMCP cards favour a plain
  statement of what the server does, so lead with the blurb's first
  two sentences if space is tight.
- Classify as: remote (hosted), authenticated.
- Official link: the docs URL above, not the app root. PulseMCP
  readers land better on documentation.

### mcp.so

- Description: long description above (mcp.so detail pages carry the
  full text).
- Categories: Video / Media / Creative, plus AI Tools if a second
  category is permitted.
- Include the connect snippet verbatim; mcp.so renders it as the
  install block. Add one line under it: "No local install: CutLab
  runs in the browser; the token is issued in the app."

---

## Honesty checklist (checked before this draft was written)

- [x] No user counts, star counts, testimonials or benchmark claims
      anywhere in the copy: none exist to cite.
- [x] Tool counts follow the plan's own framing: the vocabulary is
      described by its ten groups and named capabilities; the only
      number claimed outright is the seven original render-lane
      tools, which is verifiable in `tools/list` today.
- [x] "Beta" and "free during beta" stated; no pricing invented.
- [x] No install command invented for a hosted, HTTP-only server.
- [x] Server name and docs URL flagged **[proposed]** / conditional
      until the user confirms them at submission.
