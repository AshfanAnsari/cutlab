# CutLab — solving the deployment blocker (design only, nothing provisioned)

Written 2026-11-04 at the user's request. No services were provisioned, no network settings changed,
nothing on the AI server was exposed. This document is the design Codex builds against.

## The constraint, precisely

- The **AI server** (Jarvis VM) can run the renderer and jobs, and has full *outbound* internet via the
  platform egress proxy. It accepts **no inbound connections**, has **no public endpoint**, and its
  Tailscale client is outgoing-only (no serve/funnel/exit-node; that isolation must not be tunnelled
  around casually — any exposure is an explicit, separate user decision).
- The **browser app** (Codex's codebase, user's PC) needs: project/media persistence, job submission,
  job status, and result delivery — with near-zero load on the PC.
- Therefore every viable design has the same shape: **the server initiates all contact.** The only
  questions are *what the server talks to* and *who else can reach it*.

## Option A — Tailnet job bridge: the server polls the PC's Node API  ★ RECOMMENDED for v1

Codex's scaffold already includes a project/media Node API on the user's PC. The server reaches that
same API over the tailnet, exactly the way it already reaches FigCraft on that machine
(egress-proxy CONNECT to the laptop's tailnet address; the per-address approval for that machine
already exists from the FigCraft bridge and covers other ports).

- **Flow:** browser app ⇄ Node API (localhost, same PC — zero network cost). Server polls the API's
  job queue every few seconds → claims a job → pulls media over the tailnet → renders → posts status
  and results back to the API → app downloads/plays results from the API.
- **Needs:** PC on with the Node API running while editing; one portproxy/firewall rule on the PC in
  the FigCraft pattern (tailnet address → the API's localhost port). No new accounts, no credentials
  beyond a shared bearer token between server and API.
- **PC load:** negligible — a light Node process serving JSON and files. All encode/render load is
  server-side. (Playback of proxies in the browser is ordinary video playback.)
- **Security:** nothing is publicly exposed. The API is reachable only inside the tailnet (the user's
  own devices). Bearer token still required, because a tailnet can grow.
- **Limitations:** PC off or API down = jobs wait (they queue in the API until the server polls —
  actually the queue lives on the PC, so submission also needs the PC; acceptable: editing happens
  at the PC anyway). The portproxy rule dies on PC reboot (known FigCraft fragility; mitigate with a
  small startup script that re-adds it). Single-user scale — which is the actual requirement.
- **Why first:** zero cost, zero new infrastructure, reuses a transport pattern already proven in
  production (FigCraft), and the API contract (below) is identical to the other options — migrating
  later is a transport swap, not a redesign.

## Option B — Cloud relay with server polling (Supabase)

A hosted relay holds persistence + the job queue. The user already has a Supabase account and a
project (from Our Study Home), so this reuses an existing, free-tier service.

- **Flow:** browser app ⇄ Supabase directly (Postgres rows for projects/jobs, Storage for media,
  Realtime or polling for status). Server polls the jobs table via Supabase REST → downloads media
  from Storage → renders → uploads result to Storage → marks the job done with result refs.
- **Needs:** one Supabase project dedicated to CutLab; the **service-role key on the server only**
  (entered via the Secure Vault, never in chat, never in the browser); the browser uses the anon key
  with Row-Level Security + per-user auth, and signed URLs for media. (Free-tier quotas apply —
  storage/bandwidth are the tight ones for video; verify current limits before relying on them.)
- **PC load:** none beyond the browser app itself.
- **Security:** the server stays unexposed (outbound polling only). The relay is a public surface:
  RLS must be correct, media must use signed URLs, and the service key is a master key — its handling
  is the main risk. Job payloads should carry ids/refs, not embedded secrets.
- **Limitations:** polling latency (seconds); media makes two hops (PC→relay→server, server→relay→PC),
  doubling transfer; free-tier storage will not hold a big media library — pair with "originals stay
  on the PC/Drive, relay holds proxies + results" if quotas bite. Works with the PC off for
  *rendering queued jobs*, but new media still originates at the PC.
- **When it wins:** when the user wants the app usable from more than one machine, or jobs to drain
  while the PC sleeps.

## Option C — Reverse tunnel (Cloudflare Tunnel) to a server-hosted API

cloudflared on the server dials *out* to Cloudflare and holds a tunnel open; the browser app talks to
a normal public HTTPS URL that lands on an API running on the server.

- **Flow:** browser app ⇄ `https://cutlab.<domain>` (Cloudflare edge) ⇄ tunnel ⇄ server API
  (projects/media/jobs, WebSocket status possible). Most "real product" feel: live status, direct
  uploads/downloads, no polling.
- **Needs:** a Cloudflare account and a domain for a stable named tunnel (quick tunnels are free with
  no account but give random, temporary URLs); cloudflared running supervised on the server;
  **authentication in front of the API** (Cloudflare Access and/or app-level bearer tokens) — without
  it, this publishes a render API to the internet.
- **PC load:** none beyond the browser.
- **Security:** this is the one option that *exposes the AI server* (through the tunnel). That cuts
  against the server's current isolation posture and needs the user's explicit approval as its own
  decision, plus auth, rate limits, and a minimal API surface. Also **unverified**: whether the
  platform egress proxy passes the tunnel's outbound protocols has never been tested here.
- **Limitations:** platform-compatibility risk; public attack surface; a domain costs a small amount
  unless a free subdomain route is used. Rank it third: best UX, worst risk/effort for v1.

## Option D — File-bundle workflow (status quo, keep as the fallback)

Job = a folder (job.json + project JSON + media) delivered to the server (chat/Drive), results
returned as files with a status JSON. Zero infrastructure, works today, human-mediated (Jarvis in the
loop), no live status, latency in minutes. It remains valuable as the contract's proof: **if a design
cannot express a job as Option D's bundle, the contract is wrong.**

## The contract to target (transport-agnostic — all four options implement this)

Codex should build against this API shape; Options A/B/C are transports for it, Option D is its
file serialisation.

```
Project (the shared representation — PLAN §3 JSON, schema-versioned)
  PUT    /projects/{id}            create/replace project JSON
  GET    /projects/{id}            fetch project JSON
  GET    /projects                 list (id, name, updatedAt)

Media
  POST   /media                    upload one file → { mediaId, kind, duration?, w?, h? }
  GET    /media/{id}               download/stream (Range support — proxy playback depends on it)
  GET    /media/{id}/proxy         the editing proxy (generated by a proxy job if absent)

Jobs
  POST   /jobs                     { type: "render"|"proxy"|"thumbnail"|"analyse",
                                     projectId, project?: <inline JSON>, mediaIds: [...],
                                     preset?: {...}, idempotencyKey }
                                   → 202 { jobId, status: "queued" }
  GET    /jobs/{id}                { status: "queued"|"running"|"done"|"failed",
                                     progress?: 0..1, log?: string,
                                     result?: { outputs: [ { kind, mediaId|url, bytes } ] },
                                     error?: string }
  GET    /jobs?status=queued       the queue the server polls (Option A/B transports)
  POST   /jobs/{id}/claim          server claims a queued job (lease + heartbeat while running)
  POST   /jobs/{id}/complete       server posts result refs / failure

Rules
  - Bearer token on every call (per-deployment secret; stored in vault on the server side).
  - Job creation is idempotent (idempotencyKey) — retries never double-render.
  - Long jobs heartbeat; a stale lease returns the job to "queued".
  - Results are file references, never inline bytes in JSON.
  - Contract version in a header/path (v1); the project JSON carries its own schema version.
```

**Recommendation:** build v1 on **Option A** (the API Codex already has, reached over the tailnet in
the proven FigCraft pattern), keep the contract transport-agnostic so **Option B** can replace the
transport when multi-machine or PC-off rendering is wanted, and treat **Option C** as a later,
separately-approved step. **Option D** stays as the always-available fallback.
