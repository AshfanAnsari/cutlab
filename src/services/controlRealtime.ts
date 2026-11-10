// controlRealtime.ts — Supabase Realtime push for the live-control
// channel (leftovers sweep, 2026-11-05; the council's "cheap steal":
// replace the 2-second command poll with a push wake-up).
//
// The app speaks the Phoenix wire protocol directly over a WebSocket —
// the project has no Supabase SDK and this module keeps it that way.
// It subscribes to INSERTs on public.cutlab_commands filtered to this
// app's session id; every queued command row that lands wakes the
// executor's normal claim path (services/control.ts) immediately.
//
// Delivery guarantees, honestly stated:
//   - The table must be in the `supabase_realtime` publication
//     (supabase/realtime-migration.sql) or no events are generated;
//     the subscription still joins and simply stays silent.
//   - Realtime honours RLS with the user's JWT, so events only ever
//     name the signed-in account's own command rows.
//   - Push is a WAKE-UP, never the only path: control.ts keeps a
//     safety poll running while the socket is up and restores the fast
//     2s poll the moment the socket reports down, so a silent or dead
//     subscription degrades to exactly the pre-push behaviour.
//   - The socket re-joins every 45 minutes with a fresh access token
//     (GoTrue tokens live an hour) so a long session cannot silently
//     outlive its authorisation.

import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase';

export interface ControlRealtimeOpts {
  sessionId: string;
  /** Read fresh at every (re)join — the stored session's current JWT. */
  getAccessToken: () => string | null;
  /** A queued command row for this session landed; run the claim path. */
  onWake: () => void;
  /** true once the subscription is joined, false when it drops/dies. */
  onStatus: (up: boolean) => void;
}

const HEARTBEAT_MS = 25_000;
const REJOIN_MS = 45 * 60_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

interface PhoenixMessage {
  topic?: string;
  event?: string;
  payload?: {
    status?: string;
    data?: { record?: Record<string, unknown> };
    ids?: number[];
  };
  ref?: string | null;
  join_ref?: string | null;
}

export function startControlRealtime(opts: ControlRealtimeOpts): () => void {
  const wsUrl = SUPABASE_URL.replace(/^http/, 'ws')
    + `/realtime/v1/websocket?apikey=${SUPABASE_PUBLISHABLE_KEY}&vsn=1.0.0`;
  const topic = `realtime:cutlab-commands-${opts.sessionId}`;

  let ws: WebSocket | null = null;
  let stopped = false;
  let joined = false;
  let refSeq = 0;
  let joinRef = '';
  let attempt = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // The postgres_changes binding id from the join acknowledgement —
  // events carry it so we can ignore anything else on the topic.
  let bindingIds = new Set<number>();

  const nextRef = () => String(++refSeq);

  function setJoined(up: boolean) {
    if (joined === up) return;
    joined = up;
    opts.onStatus(up);
  }

  function clearTimers() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (rejoinTimer) clearTimeout(rejoinTimer);
    heartbeatTimer = null;
    rejoinTimer = null;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (stopped) return;
    clearTimers();
    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.onopen = () => {
      if (stopped || ws !== socket) return;
      joinRef = nextRef();
      const join = {
        topic,
        event: 'phx_join',
        ref: joinRef,
        join_ref: joinRef,
        payload: {
          access_token: opts.getAccessToken() ?? SUPABASE_PUBLISHABLE_KEY,
          config: {
            broadcast: { ack: false, self: false },
            presence: { key: '' },
            postgres_changes: [{
              event: 'INSERT',
              schema: 'public',
              table: 'cutlab_commands',
              filter: `session_id=eq.${opts.sessionId}`,
            }],
            private: false,
          },
        },
      };
      try { socket.send(JSON.stringify(join)); } catch { /* close handler retries */ }
      heartbeatTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify({
              topic: 'phoenix', event: 'heartbeat', payload: {}, ref: nextRef(),
            }));
          } catch { /* close handler retries */ }
        }
      }, HEARTBEAT_MS);
      // Re-join ahead of the token's one-hour life with a fresh JWT.
      rejoinTimer = setTimeout(() => {
        try { socket.close(); } catch { /* already gone */ }
      }, REJOIN_MS);
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (ws !== socket) return;
      let msg: PhoenixMessage;
      try { msg = JSON.parse(String(ev.data)) as PhoenixMessage; } catch { return; }
      if (msg.event === 'phx_reply' && msg.ref === joinRef) {
        if (msg.payload?.status === 'ok') {
          attempt = 0;
          const ids = (msg.payload as { postgres_changes?: number[] }).postgres_changes;
          if (Array.isArray(ids)) bindingIds = new Set(ids);
          setJoined(true);
        } else {
          // Join refused (bad token, RLS, …): drop to the fallback poll
          // and try again on the backoff.
          setJoined(false);
          try { socket.close(); } catch { /* already gone */ }
        }
        return;
      }
      if (msg.event === 'postgres_changes') {
        const ids = msg.payload?.ids ?? [];
        if (bindingIds.size && !ids.some((i) => bindingIds.has(i))) return;
        const rec = msg.payload?.data?.record;
        if (rec && rec.session_id === opts.sessionId && rec.status === 'queued') {
          opts.onWake();
        }
      }
    };

    const onDown = () => {
      if (ws === socket) ws = null;
      clearTimers();
      setJoined(false);
      scheduleReconnect();
    };
    socket.onclose = onDown;
    socket.onerror = () => {
      try { socket.close(); } catch { /* already gone */ }
    };
  }

  connect();

  return () => {
    stopped = true;
    clearTimers();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    setJoined(false);
    if (ws) {
      try { ws.close(); } catch { /* already gone */ }
      ws = null;
    }
  };
}
