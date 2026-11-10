// Analytics (EXTRAS — privacy-light product events).
//
// One fire-and-forget insert into cutlab_analytics_events
// (supabase/analytics-migration.sql) per product event. Tracking
// must NEVER throw, NEVER block the UI and NEVER surface an error:
// every path is wrapped, the insert's rejection is swallowed, and
// until the migration is deployed the table simply does not exist —
// those failures are silent by design.
//
// Privacy-light is a hard constraint, enforced here in one place:
//   · event names come only from ANALYTICS_EVENTS below — unknown
//     names are dropped, so no caller can invent a free-form event;
//   · props are sanitised (see sanitiseProps): keys matching
//     email|name|message|text|token|password are dropped, at most
//     10 keys survive, string values are truncated at 120 chars —
//     no PII and no free-text capture, ever;
//   · user_id is stamped only when signed in, else NULL (the
//     migration's INSERT policies enforce the same rule in the DB).

import { restInsert, restSelect } from './supabase';
import { currentSession } from './auth';

export const ANALYTICS_EVENTS = [
  'page_view',
  'project_created',
  'project_opened',
  'render_queued',
  'export_downloaded',
  'feedback_sent',
  'mcp_token_created',
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

export interface AnalyticsRow {
  event: string;
  page?: string | null;
  props?: Record<string, unknown> | null;
  created_at?: string | null;
}

const BANNED_PROP_KEY = /email|name|message|text|token|password/i;
export const ANALYTICS_MAX_PROP_KEYS = 10;
export const ANALYTICS_MAX_PROP_VALUE_CHARS = 120;

/** Pure props sanitiser (harness-covered). Drops banned keys and
 *  non-scalar values, keeps at most 10 keys (insertion order) and
 *  truncates string values at 120 chars. Never throws. */
export function sanitiseProps(
  props?: Record<string, unknown> | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!props || typeof props !== 'object') return out;
  try {
    for (const [key, value] of Object.entries(props)) {
      if (Object.keys(out).length >= ANALYTICS_MAX_PROP_KEYS) break;
      if (BANNED_PROP_KEY.test(key)) continue;
      if (typeof value === 'string') {
        out[key] = value.slice(0, ANALYTICS_MAX_PROP_VALUE_CHARS);
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        out[key] = value;
      }
      // objects / arrays / null / undefined are dropped: scalars only.
    }
  } catch { /* a hostile props bag degrades to whatever was collected */ }
  return out;
}

// ---------------------------------------------------------------------------
// page_view once-guard (per page id, per session — in-memory only)
// ---------------------------------------------------------------------------

const seenPageViews = new Set<string>();

/** True when this page's page_view has already fired this session. */
export function hasSeenPageView(page: string): boolean {
  return seenPageViews.has(page);
}

/** Harness seam: clear the once-guard between scenarios. */
export function resetPageViewGuard(): void {
  seenPageViews.clear();
}

// ---------------------------------------------------------------------------
// track()
// ---------------------------------------------------------------------------

type AnalyticsInserter = (
  table: string,
  row: Record<string, unknown>,
) => Promise<unknown>;

const defaultInserter: AnalyticsInserter = (table, row) => restInsert(table, row);
let inserter: AnalyticsInserter = defaultInserter;

/** Harness seam: swap the insert (null restores the relay insert). */
export function __setAnalyticsInserterForTests(fn: AnalyticsInserter | null): void {
  inserter = fn ?? defaultInserter;
}

/**
 * Record one product event. Fire-and-forget: returns immediately,
 * never throws, never blocks. `props.page` (a PageId or 'home') is
 * promoted to the row's page column and removed from the stored
 * props bag. page_view fires at most once per page id per session.
 */
export function track(event: AnalyticsEvent, props?: Record<string, unknown>): void {
  try {
    if (!(ANALYTICS_EVENTS as readonly string[]).includes(event)) return;
    const clean = sanitiseProps(props);
    let page: string | null = null;
    if (typeof clean.page === 'string' && clean.page) {
      page = clean.page.slice(0, 64);
      delete clean.page;
    }
    if (event === 'page_view') {
      const key = page ?? '';
      if (seenPageViews.has(key)) return;
      seenPageViews.add(key);
    }
    let userId: string | null = null;
    try {
      userId = currentSession()?.user.id ?? null;
    } catch { /* session unreadable: the event stays anonymous */ }
    const row: Record<string, unknown> = {
      user_id: userId, event, page, props: clean,
    };
    try {
      const pending = inserter('cutlab_analytics_events', row);
      if (pending && typeof (pending as Promise<unknown>).catch === 'function') {
        (pending as Promise<unknown>).catch(() => { /* tracking fails silent */ });
      }
    } catch { /* tracking fails silent */ }
  } catch { /* tracking fails silent — analytics must be invisible */ }
}

// ---------------------------------------------------------------------------
// Reading own activity (Account panel) + the pure summary
// ---------------------------------------------------------------------------

export interface AnalyticsSummary {
  total: number;
  byEvent: Record<string, number>;
  byPage: Record<string, number>;
  topEvents: { event: string; count: number }[];
}

/**
 * Pure summary (harness-covered): counts by event and by page over
 * an optional trailing window (`days`, measured back from `now` —
 * rows without a parseable created_at count only when no window is
 * given), plus the top-events list (count desc, name asc on ties).
 */
export function summariseEvents(
  rows: readonly AnalyticsRow[],
  opts?: { days?: number; now?: Date },
): AnalyticsSummary {
  const byEvent: Record<string, number> = {};
  const byPage: Record<string, number> = {};
  let total = 0;
  const now = opts?.now ?? new Date();
  const cutoff = opts?.days != null
    ? now.getTime() - opts.days * 24 * 60 * 60 * 1000
    : null;
  for (const row of rows ?? []) {
    if (!row || typeof row.event !== 'string' || !row.event) continue;
    if (cutoff != null) {
      const t = row.created_at ? Date.parse(row.created_at) : NaN;
      if (!Number.isFinite(t) || t < cutoff || t > now.getTime()) continue;
    }
    total += 1;
    byEvent[row.event] = (byEvent[row.event] ?? 0) + 1;
    if (typeof row.page === 'string' && row.page) {
      byPage[row.page] = (byPage[row.page] ?? 0) + 1;
    }
  }
  const topEvents = Object.entries(byEvent)
    .map(([event, count]) => ({ event, count }))
    .sort((a, b) => b.count - a.count || a.event.localeCompare(b.event));
  return { total, byEvent, byPage, topEvents };
}

/** The signed-in user's own events for the trailing `days` window
 *  (RLS scopes the select to their rows). Throws on relay failure —
 *  the Account panel turns that into its graceful empty state. */
export async function loadOwnAnalyticsEvents(days = 30): Promise<AnalyticsRow[]> {
  if (!currentSession()) return [];
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return restSelect<AnalyticsRow>(
    '/rest/v1/cutlab_analytics_events?select=event,page,props,created_at'
    + `&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=1000`,
  );
}
