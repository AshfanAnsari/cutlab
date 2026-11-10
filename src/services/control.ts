// Live control — the FigCraft-style bridge (PLAN §10, CONTROL clarified).
//
// FigCraft gives Jarvis a control port into the user's open app; CutLab's
// equivalent is a command channel through the Supabase relay (table
// cutlab_commands, supabase/commands-migration.sql):
//
//   - With the TopBar "Jarvis control" toggle ON (default OFF), the app
//     announces a session row and listens for commands addressed to its
//     session id, oldest first. Wake-up is a Supabase Realtime push
//     (services/controlRealtime.ts) with polling as the fallback: a
//     slow safety poll runs while the socket is up, and the fast poll
//     below returns the moment it drops.
//   - Each command is claimed (queued -> running, guarded so a second tab
//     can't take it), executed against the REAL editor store — the same
//     actions the UI itself calls — and finished with status done/failed
//     plus a result/error payload Jarvis reads back.
//   - A visible banner (TopBar) shows control is live, and Stop ends it:
//     no new commands are claimed; the one in flight still writes its
//     outcome back so the queue never hangs in 'running'.
//
// Security posture (Phase 1, supersedes the test-phase note): live
// control is OWNER-ONLY. The toggle renders only for the owner's
// signed-in account (services/ownerConfig.ts), setControlEnabled
// refuses everyone else, and the poller re-checks the gate before
// every claim — signing out mid-session stops execution. Underneath,
// RLS scopes cutlab_commands rows to their account, and the driver
// (server/control.py) stamps each command row with the session's
// user_id, so a command can only ever be claimed by the app whose
// account it belongs to. Default remains OFF, with the banner + stop.

import { useSyncExternalStore } from 'react';
import { store } from '../state/store';
import { splitClipAt, updateClip } from '../state/actions';
import {
  clipDuration,
  DEFAULT_TRANSFORM,
  newId,
  projectDuration,
  type Clip,
  type MediaItem,
  type Project,
  type TextClip,
  type Track,
} from '../types';
import { mediaStore } from './mediaStore';
import { jobService, setRelayProjectSlot } from './jobsSupabase';
import { restInsert, restPatch, restSelect } from './supabase';
import { currentSession, type AuthSession } from './auth';
import { OWNER_UID } from './ownerConfig';
import { startControlRealtime } from './controlRealtime';
import { grabStageStill } from './stillGrab';
import { applyEditOps } from './editOps';
import { playback } from '../engine/playback';
import { clipAtTime } from '../engine/compose';

const POLL_MS = 2000;
/** While Realtime push is joined it is the wake-up; this slow poll is
 *  only the safety net for an event the socket somehow missed. */
const SAFETY_POLL_MS = 30_000;
const SESSION_KEY = 'cutlab.control.session';

// ---------------------------------------------------------------------------
// Control state (tiny external store, same pattern as state/store.ts)
// ---------------------------------------------------------------------------

export interface ControlState {
  enabled: boolean;
  sessionId: string | null;
  busyKind: string | null;
  /** True while the Realtime push subscription is joined. */
  realtime: boolean;
  last: { kind: string; ok: boolean; error?: string; at: number } | null;
}

let ctl: ControlState = { enabled: false, sessionId: null, busyKind: null, realtime: false, last: null };
const listeners = new Set<() => void>();

function setCtl(partial: Partial<ControlState>) {
  ctl = { ...ctl, ...partial };
  for (const fn of listeners) fn();
}

export function useControl(): ControlState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => ctl,
  );
}

export function getControlState(): ControlState {
  return ctl;
}

// ---------------------------------------------------------------------------
// The Phase-1 gate: who may run live control at all. Pure in (session,
// ownerUid) so the harness can walk the whole matrix; controlAllowed()
// wires it to the live session + this deployment's OWNER_UID.
// ---------------------------------------------------------------------------

export interface ControlGate { allowed: boolean; reason: string }

export function controlGate(session: AuthSession | null, ownerUid: string): ControlGate {
  if (!session) {
    return { allowed: false, reason: 'Sign in first — Jarvis control only exists for the owner’s account.' };
  }
  if (!ownerUid) {
    return { allowed: false, reason: 'Jarvis control is not configured on this deployment yet (owner id unset — see services/ownerConfig.ts).' };
  }
  if (session.user.id !== ownerUid) {
    return { allowed: false, reason: 'Jarvis control is owner-only — this account cannot enable it.' };
  }
  return { allowed: true, reason: '' };
}

export function controlAllowed(): ControlGate {
  return controlGate(currentSession(), OWNER_UID);
}

// ---------------------------------------------------------------------------
// Session identity — stable per browser, so Jarvis can address this app
// across reloads. localStorage may be unavailable (private mode, Node):
// fall back to an in-memory id.
// ---------------------------------------------------------------------------

let memorySessionId: string | null = null;

function sessionId(): string {
  if (memorySessionId) return memorySessionId;
  try {
    const kept = localStorage.getItem(SESSION_KEY);
    if (kept) {
      memorySessionId = kept;
      return kept;
    }
  } catch { /* fall through */ }
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? `sess_${crypto.randomUUID()}`
      : `sess_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  memorySessionId = id;
  try { localStorage.setItem(SESSION_KEY, id); } catch { /* in-memory only */ }
  return id;
}

// ---------------------------------------------------------------------------
// Project adoption: opening a cloud project must bind its media the way the
// UI's own Open-cloud flow does. App.tsx registers that routine at boot
// (it owns bindProjectMedia); without a registration (headless harness),
// fall back to a plain store replace.
// ---------------------------------------------------------------------------

let projectAdopter: ((p: Project) => Promise<void>) | null = null;

export function registerControlProjectAdopter(fn: (p: Project) => Promise<void>): void {
  projectAdopter = fn;
}

// ---------------------------------------------------------------------------
// Arg validation — every failure is a thrown Error whose message lands in
// the command row's `error`, so Jarvis sees exactly what was wrong.
// ---------------------------------------------------------------------------

function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Command needs a non-empty string arg '${key}'.`);
  }
  return v;
}

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`Arg '${key}' must be a string.`);
  return v;
}

function reqNum(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`Command needs a numeric arg '${key}'.`);
  }
  return v;
}

function optNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`Arg '${key}' must be a number.`);
  }
  return v;
}

function locateClip(clipId: string): { track: Track; clip: Clip } {
  const p = store.get().project;
  for (const track of p.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  throw new Error(`No clip with id '${clipId}' in the current project.`);
}

// ---------------------------------------------------------------------------
// The command set (v1). Every handler maps onto the app's real store
// actions — the same commits the UI makes, so undo/autosave/preview all
// behave exactly as if the user had done it by hand.
// ---------------------------------------------------------------------------

export const CONTROL_COMMANDS = [
  'ping', 'getState', 'openCloudProject', 'addClip', 'trimClip', 'moveClip',
  'splitClip', 'deleteClip', 'setVolume', 'addText', 'updateText',
  'saveCloud', 'queueMediaJob', 'queueRender', 'previewSnapshot',
  'applyOps', 'grabStill', 'getProjectSummary', 'listMarkers',
] as const;

export async function executeCommand(
  kind: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (kind) {
    case 'ping':
      return {
        ok: true,
        at: new Date().toISOString(),
        sessionId: ctl.sessionId,
        projectName: store.get().project.name,
      };

    case 'getState': {
      const recs = await mediaStore.all();
      return {
        project: store.get().project,
        media: recs.map((r) => ({
          id: r.meta.id,
          src: r.meta.src,
          kind: r.meta.kind,
          duration: r.meta.duration ?? null,
          hasProxy: !!r.proxyBlob,
          hasThumb: !!r.thumb,
          hasPeaks: !!r.peaks,
          remoteOriginal: !!r.remoteOriginal,
        })),
        control: {
          enabled: ctl.enabled,
          sessionId: ctl.sessionId,
          busyKind: ctl.busyKind,
          realtime: ctl.realtime,
        },
      };
    }

    case 'openCloudProject': {
      const projectId = reqString(args, 'projectId');
      if (!jobService.loadProjectRemote) {
        throw new Error('Cloud projects are not available on this transport.');
      }
      const p = await jobService.loadProjectRemote(projectId);
      if (!p) throw new Error(`No relay project with id '${projectId}'.`);
      await setRelayProjectSlot(projectId, p.name);
      if (projectAdopter) await projectAdopter(p);
      else store.replaceProject(p);
      return { projectId, name: p.name, mediaCount: p.media.length, trackCount: p.tracks.length };
    }

    case 'addClip': {
      const assetId = reqString(args, 'assetId');
      const project = store.get().project;
      let item: MediaItem | undefined = project.media.find((m) => m.id === assetId);
      if (!item) {
        const recs = await mediaStore.all();
        item = recs.find((r) => r.meta.id === assetId || r.meta.src === assetId)?.meta;
      }
      if (!item) {
        throw new Error(`No media asset '${assetId}' — not in the project and not in the media bin.`);
      }
      const mediaItem: MediaItem = item;
      const wantKind = mediaItem.kind === 'audio' ? 'audio' : 'video';
      let track: Track | undefined;
      const trackIdArg = optString(args, 'trackId');
      if (trackIdArg) {
        track = project.tracks.find((t) => t.id === trackIdArg);
        if (!track) throw new Error(`No track with id '${trackIdArg}'.`);
      } else {
        track = project.tracks.find((t) => t.kind === wantKind) ?? project.tracks[0];
      }
      if (!track) throw new Error('The project has no tracks to add a clip to.');
      const targetTrack: Track = track;
      const start = optNum(args, 'start')
        ?? Math.max(0, ...targetTrack.clips.map((c) => c.start + clipDuration(c)));
      if (start < 0) throw new Error(`Arg 'start' must be >= 0.`);
      const clipId = newId('clip');
      store.commit((draft) => {
        if (!draft.media.some((m) => m.id === mediaItem.id)) draft.media.push(mediaItem);
        const tr = draft.tracks.find((t) => t.id === targetTrack.id)!;
        const dur = mediaItem.duration ?? 5;
        if (wantKind === 'video') {
          tr.clips.push({
            id: clipId, media: mediaItem.id, start, in: 0, out: dur, speed: 1,
            muted: false, volume: 1, transitionIn: null,
            transform: { ...DEFAULT_TRANSFORM },
          });
        } else {
          tr.clips.push({
            id: clipId, media: mediaItem.id, start, in: 0, out: dur, speed: 1,
            volume: 1, fadeIn: 0, fadeOut: 0, transitionIn: null,
          });
        }
      });
      return { clipId, trackId: targetTrack.id, start };
    }

    case 'trimClip': {
      const clipId = reqString(args, 'clipId');
      const inV = reqNum(args, 'in');
      const outV = reqNum(args, 'out');
      const { track, clip } = locateClip(clipId);
      if (!('in' in clip)) throw new Error(`Clip '${clipId}' is a text clip — trimClip applies to video/audio clips.`);
      if (inV < 0 || outV <= inV) throw new Error(`Trim needs 0 <= in < out (got in=${inV}, out=${outV}).`);
      updateClip(track.id, clipId, (c) => {
        if ('in' in c) { c.in = inV; c.out = outV; }
      });
      return { clipId, in: inV, out: outV };
    }

    case 'moveClip': {
      const clipId = reqString(args, 'clipId');
      const start = reqNum(args, 'start');
      if (start < 0) throw new Error(`Arg 'start' must be >= 0.`);
      const { track } = locateClip(clipId);
      updateClip(track.id, clipId, (c) => { c.start = start; });
      return { clipId, start };
    }

    case 'splitClip': {
      const clipId = reqString(args, 'clipId');
      const at = reqNum(args, 'at');
      const { track, clip } = locateClip(clipId);
      const rightId = splitClipAt(track.id, clipId, at);
      if (!rightId) {
        throw new Error(
          `Split point ${at}s is not inside clip '${clipId}' (it spans ${clip.start}s–${clip.start + clipDuration(clip)}s).`,
        );
      }
      return { clipId, newClipId: rightId, at };
    }

    case 'deleteClip': {
      const clipId = reqString(args, 'clipId');
      const { track } = locateClip(clipId);
      store.commit((draft) => {
        const tr = draft.tracks.find((t) => t.id === track.id);
        if (tr) tr.clips = tr.clips.filter((c) => c.id !== clipId);
      });
      if (store.get().selected?.clipId === clipId) store.set({ selected: null });
      return { deleted: clipId };
    }

    case 'setVolume': {
      const clipId = reqString(args, 'clipId');
      const volume = Math.min(1, Math.max(0, reqNum(args, 'volume')));
      const { track, clip } = locateClip(clipId);
      if (!('volume' in clip)) throw new Error(`Clip '${clipId}' has no volume (text clip?).`);
      updateClip(track.id, clipId, (c) => {
        if ('volume' in c) c.volume = volume;
      });
      return { clipId, volume };
    }

    case 'addText': {
      const text = reqString(args, 'text');
      const start = optNum(args, 'start') ?? 0;
      const dur = optNum(args, 'dur') ?? 2;
      const style = optString(args, 'style') ?? 'pop-bold';
      if (start < 0) throw new Error(`Arg 'start' must be >= 0.`);
      if (dur <= 0) throw new Error(`Arg 'dur' must be > 0.`);
      const clipId = newId('clip');
      let trackId = '';
      store.commit((draft) => {
        let tr = draft.tracks.find((t) => t.kind === 'text');
        if (!tr) {
          tr = { id: newId('trk'), kind: 'text', clips: [] };
          draft.tracks.push(tr);
        }
        trackId = tr.id;
        const clip: TextClip = {
          id: clipId, text, start, dur, style,
          x: 0.5, y: 0.8, animIn: 'pop', animOut: 'fade', effects: [], transitionIn: null,
        };
        tr.clips.push(clip);
      });
      store.set({ selected: { trackId, clipId } });
      return { clipId, trackId, start, dur };
    }

    case 'updateText': {
      const clipId = reqString(args, 'clipId');
      const text = reqString(args, 'text');
      const { track, clip } = locateClip(clipId);
      if (!('text' in clip)) throw new Error(`Clip '${clipId}' is not a text clip.`);
      updateClip(track.id, clipId, (c) => {
        if ('text' in c) c.text = text;
      });
      return { clipId, text };
    }

    case 'saveCloud': {
      if (!jobService.saveProjectRemote) {
        throw new Error('Cloud save is not available on this transport.');
      }
      const projectId = await jobService.saveProjectRemote(store.get().project);
      return { projectId };
    }

    case 'queueMediaJob': {
      // Dispatches the same call the MediaBin button makes. The JobService
      // reports job-level failures as app toasts rather than throwing, so
      // this resolves once the flow completes; the job row itself is in
      // cutlab_jobs for Jarvis to watch.
      const recs = await mediaStore.all();
      await jobService.createMediaJobBundle(store.get().project, recs);
      return { dispatched: true };
    }

    case 'queueRender': {
      const recs = await mediaStore.all();
      await jobService.createRenderJobBundle(store.get().project, recs);
      return { dispatched: true };
    }

    case 'previewSnapshot': {
      // What Jarvis "sees" of the preview: the primary video element's
      // frame at the playhead (the Cover maker's blessed grab route,
      // services/stillGrab.ts) plus the structured stage state. The
      // stage is DOM-composited (overlays, grades ride CSS), so the
      // honest capture is this frame + state, not a flattened render.
      const maxWidth = Math.min(1280, Math.max(160, optNum(args, 'maxWidth') ?? 640));
      const project = store.get().project;
      const t = playback.time;
      const state: Record<string, unknown> = {
        projectName: project.name,
        canvas: project.canvas,
        playhead: t,
        playing: playback.playing,
        duration: projectDuration(project),
        activeClips: project.tracks.flatMap((track) => {
          const c = clipAtTime(track.clips, t);
          return c
            ? [{
                trackId: track.id,
                trackKind: track.kind,
                clipId: c.id,
                clipKind: 'text' in c ? 'text' : track.kind,
              }]
            : [];
        }),
      };
      if (typeof document === 'undefined') {
        throw new Error('previewSnapshot needs the open editor window — it captures the live preview stage.');
      }
      const frame = grabStageStill(project.canvas.w, project.canvas.h);
      if (!frame) {
        return {
          ...state,
          image: null,
          note: 'No primary video frame at the playhead (empty stage, text-only moment, or the clip has not decoded yet). The state above is current.',
        };
      }
      const scale = Math.min(1, maxWidth / frame.width);
      const w = Math.max(1, Math.round(frame.width * scale));
      const h = Math.max(1, Math.round(frame.height * scale));
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const ctx = out.getContext('2d');
      if (!ctx) throw new Error('previewSnapshot could not allocate a 2d context for the capture.');
      ctx.drawImage(frame, 0, 0, w, h);
      return {
        ...state,
        image: { format: 'jpeg', width: w, height: h, dataUrl: out.toDataURL('image/jpeg', 0.72) },
      };
    }

    case 'applyOps': {
      // Phase 2 parity: the full Phase 1 edit-op vocabulary (services/
      // editOps.ts) against the LIVE project. The pure engine validates
      // and builds the result first — a bad op throws before anything
      // is committed — then the result lands through ONE store.commit,
      // so one applyOps command is exactly one undo step and autosave
      // sees one change, never a half-applied batch.
      const ops = args.ops;
      if (!Array.isArray(ops) || ops.length === 0) {
        throw new Error(`Command 'applyOps' needs a non-empty 'ops' array, e.g. {ops: [{op: 'trim_clip', clipId: '…', in: 1, out: 4}]}.`);
      }
      const before = store.get().project;
      const after = applyEditOps(before, ops as Record<string, unknown>[]);
      store.commit((draft) => {
        const fresh = JSON.parse(JSON.stringify(after)) as Project;
        for (const k of Object.keys(draft)) {
          if (!(k in fresh)) delete (draft as unknown as Record<string, unknown>)[k];
        }
        Object.assign(draft, fresh);
      }, { label: `Jarvis edit ops (${ops.length})` });
      const now = store.get().project;
      return {
        applied: ops.length,
        ops: ops.map((o) => (o && typeof o === 'object' ? String((o as Record<string, unknown>).op ?? '?') : '?')),
        projectName: now.name,
        duration: projectDuration(now),
        trackCount: now.tracks.length,
        clipCount: now.tracks.reduce((n, t) => n + t.clips.length, 0),
      };
    }

    case 'grabStill': {
      // A clean still of the composited stage at a requested time: the
      // playhead seeks to `t` (when given) and the primary frame is
      // grabbed through the same grabStageStill route as the Cover
      // maker. Headless / no-frame cases degrade to the state payload
      // plus a note — never a throw — so a caller can always plan from
      // the state even when no pixels are available.
      const project = store.get().project;
      const requestedT = optNum(args, 't') ?? optNum(args, 'time');
      if (requestedT !== undefined) {
        if (requestedT < 0) throw new Error(`Arg 't' must be >= 0.`);
        playback.seek(requestedT);
      }
      const maxWidth = Math.min(1920, Math.max(160, optNum(args, 'maxWidth') ?? 960));
      const t = playback.time;
      const state: Record<string, unknown> = {
        projectName: project.name,
        canvas: project.canvas,
        playhead: t,
        requestedTime: requestedT ?? null,
        playing: playback.playing,
        duration: projectDuration(project),
        activeClips: project.tracks.flatMap((track) => {
          const c = clipAtTime(track.clips, t);
          return c
            ? [{
                trackId: track.id,
                trackKind: track.kind,
                clipId: c.id,
                clipKind: 'text' in c ? 'text' : track.kind,
              }]
            : [];
        }),
      };
      if (typeof document === 'undefined') {
        return {
          ...state,
          image: null,
          note: 'No editor window here (headless), so no frame could be grabbed — the still was taken at the current playhead state above. In the open app, grabStill seeks to the requested time and returns the composited frame.',
        };
      }
      const frame = grabStageStill(project.canvas.w, project.canvas.h);
      if (!frame) {
        return {
          ...state,
          image: null,
          note: 'No primary video frame at the playhead (empty stage, text-only moment, or the clip has not decoded yet) — grabbed at the current playhead; the state above is current.',
        };
      }
      const scale = Math.min(1, maxWidth / frame.width);
      const w = Math.max(1, Math.round(frame.width * scale));
      const h = Math.max(1, Math.round(frame.height * scale));
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const ctx = out.getContext('2d');
      if (!ctx) {
        return { ...state, image: null, note: 'Could not allocate a 2d context for the still; the state above is current.' };
      }
      ctx.drawImage(frame, 0, 0, w, h);
      return {
        ...state,
        image: { format: 'jpeg', width: w, height: h, dataUrl: out.toDataURL('image/jpeg', 0.8) },
        note: requestedT !== undefined
          ? `Still grabbed after seeking to ${t}s.`
          : 'Still grabbed at the current playhead (no time was requested).',
      };
    }

    case 'getProjectSummary': {
      // The cheap structured read an agent plans from, instead of the
      // full project JSON getState carries.
      const project = store.get().project;
      const mediaByKind: Record<string, number> = {};
      for (const m of project.media) mediaByKind[m.kind] = (mediaByKind[m.kind] ?? 0) + 1;
      return {
        name: project.name,
        canvas: project.canvas,
        duration: projectDuration(project),
        rangeIn: project.rangeIn ?? null,
        rangeOut: project.rangeOut ?? null,
        hasLook: !!project.look,
        hasAudioBus: !!project.audioBus,
        mediaCount: project.media.length,
        mediaByKind,
        markerCount: project.markers.length,
        trackCount: project.tracks.length,
        clipCount: project.tracks.reduce((n, t) => n + t.clips.length, 0),
        tracks: project.tracks.map((track) => ({
          id: track.id,
          kind: track.kind,
          name: track.name ?? null,
          muted: !!track.muted,
          solo: !!track.solo,
          locked: !!track.locked,
          hidden: !!track.hidden,
          bus: track.bus ?? null,
          clipCount: track.clips.length,
          clips: track.clips.map((c) => ({
            id: c.id,
            kind: 'text' in c ? 'text' : 'adj' in c ? 'adjustment' : 'nest' in c ? 'compound' : track.kind,
            start: c.start,
            duration: clipDuration(c),
          })),
        })),
      };
    }

    case 'listMarkers': {
      const project = store.get().project;
      return {
        markers: project.markers.map((m) => ({ ...m })),
        count: project.markers.length,
      };
    }

    default:
      throw new Error(`Unknown command kind '${kind}'. Known kinds: ${CONTROL_COMMANDS.join(', ')}.`);
  }
}

// ---------------------------------------------------------------------------
// The poller: announce, claim, execute, report — one command at a time.
// ---------------------------------------------------------------------------

interface CommandRow {
  id: string;
  kind: string;
  command: Record<string, unknown> | null;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let loopBusy = false;
let realtimeUp = false;
let stopRealtime: (() => void) | null = null;

/** The poll cadence follows the push channel: fast (POLL_MS) whenever
 *  Realtime is down — exactly the pre-push behaviour — and a slow
 *  safety tick (SAFETY_POLL_MS) while push is joined and waking the
 *  claim path itself. */
function applyPollInterval(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (!ctl.enabled) return;
  pollTimer = setInterval(() => { void pollOnce(); }, realtimeUp ? SAFETY_POLL_MS : POLL_MS);
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (stopRealtime) {
    stopRealtime();
    stopRealtime = null;
  }
  realtimeUp = false;
  setCtl({ enabled: false, realtime: false });
}

async function pollOnce(): Promise<void> {
  if (!ctl.enabled || loopBusy || !ctl.sessionId) return;
  // The gate is re-checked every tick: if the session ended or the
  // account changed, the executor stands down immediately rather than
  // running one more command on yesterday's authority.
  if (!controlAllowed().allowed) {
    stopPolling();
    return;
  }
  loopBusy = true;
  try {
    const sid = ctl.sessionId;
    const rows = await restSelect<CommandRow>(
      `/rest/v1/cutlab_commands?session_id=eq.${encodeURIComponent(sid)}&status=eq.queued&order=created_at.asc&limit=1&select=id,kind,command`,
    );
    const row = rows[0];
    if (!row || !ctl.enabled) return;
    // Claim with a status guard: if another executor (second tab) took it
    // first, the update matches nothing and we stand down.
    const claimed = await restPatch<CommandRow[]>(
      `/rest/v1/cutlab_commands?id=eq.${row.id}&status=eq.queued`,
      { status: 'running', updated_at: new Date().toISOString() },
    );
    if (!claimed.length) return;
    // Final authority check between claim and execution — the executor
    // never runs a command on a session that stopped being the owner's.
    if (!controlAllowed().allowed) {
      await restPatch(`/rest/v1/cutlab_commands?id=eq.${row.id}`, {
        status: 'failed',
        error: 'Control authority ended before this command ran (signed out or account changed).',
        updated_at: new Date().toISOString(),
      }).catch(() => undefined);
      stopPolling();
      return;
    }
    setCtl({ busyKind: row.kind });
    try {
      const result = await executeCommand(row.kind, row.command ?? {});
      await restPatch(`/rest/v1/cutlab_commands?id=eq.${row.id}`, {
        status: 'done', result: result ?? {}, error: null,
        updated_at: new Date().toISOString(),
      });
      setCtl({ last: { kind: row.kind, ok: true, at: Date.now() } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await restPatch(`/rest/v1/cutlab_commands?id=eq.${row.id}`, {
        status: 'failed', error: msg.slice(0, 2000),
        updated_at: new Date().toISOString(),
      }).catch(() => undefined);
      setCtl({ last: { kind: row.kind, ok: false, error: msg, at: Date.now() } });
    } finally {
      setCtl({ busyKind: null });
    }
  } catch (e) {
    // Relay hiccup (or the commands table not applied yet): stay quiet and
    // retry on the next tick rather than toasting every two seconds.
    console.warn('CutLab control poll failed:', e);
  } finally {
    loopBusy = false;
  }
}

/** Turn live control on or off. Turning it on announces the session to the
 *  relay and starts polling; turning it off stops claiming new commands
 *  immediately — a command already executing still writes its outcome.
 *  Turning it on is refused (with the reason toasted) for anyone but
 *  the owner's signed-in account — see controlGate. */
export async function setControlEnabled(on: boolean): Promise<void> {
  if (!on) {
    stopPolling();
    return;
  }
  const gate = controlAllowed();
  if (!gate.allowed) {
    store.toastMsg('error', gate.reason);
    return;
  }
  const sid = sessionId();
  setCtl({ enabled: true, sessionId: sid });
  try {
    // Sweep anything a previous crashed session left 'running' — it would
    // otherwise hang there forever with Jarvis waiting on it.
    await restPatch(
      `/rest/v1/cutlab_commands?session_id=eq.${encodeURIComponent(sid)}&status=eq.running`,
      {
        status: 'failed',
        error: 'App restarted (or control re-enabled) while this command was running.',
        updated_at: new Date().toISOString(),
      },
    ).catch(() => undefined);
    await restInsert('cutlab_commands', {
      session_id: sid,
      kind: 'session',
      user_id: currentSession()?.user.id,
      command: {
        hello: true,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
      },
      status: 'done',
      result: { announcedAt: new Date().toISOString() },
    });
    store.toastMsg('info', 'Jarvis control is ON — this editor will execute relay commands for its session.');
  } catch (e) {
    store.toastMsg(
      'error',
      'Jarvis control could not announce itself to the relay — '
        + (e instanceof Error ? e.message : String(e)),
    );
  }
  realtimeUp = false;
  applyPollInterval();
  void pollOnce();
  // Push wake-up on top of the poll: a queued command row for this
  // session runs the same claim path the tick runs. If the socket
  // never joins (relay without the realtime publication, a blocked
  // WebSocket, …) the poll simply stays at its fast cadence.
  stopRealtime = startControlRealtime({
    sessionId: sid,
    getAccessToken: () => currentSession()?.accessToken ?? null,
    onWake: () => { void pollOnce(); },
    onStatus: (up) => {
      if (!ctl.enabled) return;
      realtimeUp = up;
      setCtl({ realtime: up });
      applyPollInterval();
    },
  });
}
