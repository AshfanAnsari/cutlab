/**
 * Analytics harness (EXTRAS — privacy-light product events) — headless
 * checks for the PURE parts of src/services/analytics.ts plus the
 * track() insert contract, bundled with `vite build --ssr` and run
 * under Node, like the other harnesses:
 *   · the props sanitiser (banned keys out, 10-key cap, 120-char
 *     truncation, scalars only)
 *   · the page_view once-guard (per page id, per session)
 *   · summariseEvents maths on fixture rows (by event, by page,
 *     top-events order, trailing-window filter, empty input)
 *   · track() signed-out reaches the stubbed insert with
 *     user_id null and refuses nothing; signed-in stamps the uid;
 *     a rejecting (or synchronously throwing) insert never makes
 *     track() throw; unknown event names are dropped.
 * RLS behaviour itself is NOT checkable here — that is deploy-time
 * verification against supabase/analytics-migration.sql.
 */
import { setSession, type AuthSession } from '../src/services/auth';
import {
  __setAnalyticsInserterForTests, hasSeenPageView, resetPageViewGuard,
  sanitiseProps, summariseEvents, track, type AnalyticsRow,
} from '../src/services/analytics';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
}

function session(uid: string): AuthSession {
  return {
    accessToken: 'AT-AN', refreshToken: 'RT', expiresAt: Date.now() + 3_600_000,
    user: { id: uid, email: `${uid}@example.test` },
  };
}

interface CapturedRow { table: string; row: Record<string, unknown> }

async function main() {
  // ---- sanitiser ------------------------------------------------------
  const dirty = sanitiseProps({
    email: 'a@b.c', userEmail: 'a@b.c', fullName: 'Some One', name: 'X',
    message: 'hello', noteText: 'hi', authToken: 'secret', password: 'pw',
    page: 'edit', count: 3, ok: true,
  });
  check('sanitiser drops every banned key (email|name|message|text|token|password)',
    !('email' in dirty) && !('userEmail' in dirty) && !('fullName' in dirty)
      && !('name' in dirty) && !('message' in dirty) && !('noteText' in dirty)
      && !('authToken' in dirty) && !('password' in dirty),
    JSON.stringify(dirty));
  check('sanitiser keeps safe scalar keys untouched',
    dirty.page === 'edit' && dirty.count === 3 && dirty.ok === true,
    JSON.stringify(dirty));

  const many: Record<string, unknown> = {};
  for (let i = 0; i < 15; i++) many[`k${i}`] = i;
  check('sanitiser caps props at 10 keys',
    Object.keys(sanitiseProps(many)).length === 10,
    `${Object.keys(sanitiseProps(many)).length} keys`);

  const long = sanitiseProps({ label: 'x'.repeat(300) });
  check('sanitiser truncates string values at 120 chars',
    typeof long.label === 'string' && (long.label as string).length === 120);

  const mixed = sanitiseProps({ obj: { a: 1 }, arr: [1, 2], nil: null, n: 1.5, b: false });
  check('sanitiser drops non-scalar values, keeps number/boolean',
    !('obj' in mixed) && !('arr' in mixed) && !('nil' in mixed)
      && mixed.n === 1.5 && mixed.b === false,
    JSON.stringify(mixed));
  check('sanitiser tolerates missing/junk input',
    Object.keys(sanitiseProps(undefined)).length === 0
      && Object.keys(sanitiseProps(null)).length === 0);

  // ---- summariseEvents --------------------------------------------------
  const now = new Date('2026-11-09T12:00:00.000Z');
  const rows: AnalyticsRow[] = [
    { event: 'page_view', page: 'edit', created_at: '2026-11-09T10:00:00.000Z' },
    { event: 'page_view', page: 'media', created_at: '2026-11-09T10:05:00.000Z' },
    { event: 'page_view', page: 'edit', created_at: '2026-11-08T09:00:00.000Z' },
    { event: 'project_created', page: null, created_at: '2026-11-07T09:00:00.000Z' },
    { event: 'render_queued', page: 'deliver', created_at: '2026-11-06T09:00:00.000Z' },
    { event: 'render_queued', page: 'deliver', created_at: '2026-11-05T09:00:00.000Z' },
    // 40 days before `now` — outside a 30-day window:
    { event: 'page_view', page: 'edit', created_at: '2026-09-30T09:00:00.000Z' },
  ];
  const all = summariseEvents(rows);
  check('summarise: total counts every row', all.total === 7, `${all.total}`);
  check('summarise: counts by event',
    all.byEvent.page_view === 4 && all.byEvent.render_queued === 2
      && all.byEvent.project_created === 1,
    JSON.stringify(all.byEvent));
  check('summarise: counts by page (null pages skipped)',
    all.byPage.edit === 3 && all.byPage.media === 1 && all.byPage.deliver === 2,
    JSON.stringify(all.byPage));
  check('summarise: top events ordered by count desc',
    all.topEvents[0]?.event === 'page_view' && all.topEvents[0]?.count === 4
      && all.topEvents[1]?.event === 'render_queued' && all.topEvents[1]?.count === 2,
    JSON.stringify(all.topEvents));

  const windowed = summariseEvents(rows, { days: 30, now });
  check('summarise: 30-day window excludes the 40-day-old row',
    windowed.total === 6 && windowed.byEvent.page_view === 3,
    JSON.stringify(windowed.byEvent));
  const empty = summariseEvents([]);
  check('summarise: empty input is a zero summary',
    empty.total === 0 && empty.topEvents.length === 0
      && Object.keys(empty.byEvent).length === 0);

  // ---- track(): insert contract -----------------------------------------
  const captured: CapturedRow[] = [];
  __setAnalyticsInserterForTests((table, row) => {
    captured.push({ table, row });
    return Promise.resolve(null);
  });

  setSession(null);
  resetPageViewGuard();
  captured.length = 0;
  let threw = false;
  try {
    track('project_opened', { page: 'edit', projectEmail: 'a@b.c', source: 'home' });
  } catch { threw = true; }
  check('track signed-out refuses nothing (does not throw)', !threw);
  check('track signed-out reaches the insert exactly once',
    captured.length === 1 && captured[0]?.table === 'cutlab_analytics_events',
    `${captured.length} inserts`);
  check('track signed-out stamps user_id null',
    captured[0]?.row.user_id === null, JSON.stringify(captured[0]?.row));
  check('track promotes props.page to the page column, sanitised props stored',
    captured[0]?.row.page === 'edit'
      && (captured[0]?.row.props as Record<string, unknown>)?.source === 'home'
      && !('projectEmail' in ((captured[0]?.row.props as Record<string, unknown>) ?? {})),
    JSON.stringify(captured[0]?.row));

  setSession(session('u-an'));
  captured.length = 0;
  track('render_queued', { page: 'deliver' });
  check('track signed-in stamps the session user_id',
    captured.length === 1 && captured[0]?.row.user_id === 'u-an',
    JSON.stringify(captured[0]?.row));
  setSession(null);

  // page_view once-guard: same page twice = one insert; a new page fires.
  resetPageViewGuard();
  captured.length = 0;
  track('page_view', { page: 'edit' });
  track('page_view', { page: 'edit' });
  track('page_view', { page: 'colour' });
  track('page_view', { page: 'edit' });
  check('page_view once-guard: one insert per page id per session',
    captured.length === 2 && hasSeenPageView('edit') && hasSeenPageView('colour'),
    `${captured.length} inserts`);
  captured.length = 0;
  track('project_created', {});
  track('project_created', {});
  check('once-guard applies to page_view only (other events repeat)',
    captured.length === 2, `${captured.length} inserts`);

  // Unknown event names are dropped before any insert.
  captured.length = 0;
  track('totally_made_up' as never, {});
  check('track drops unknown event names', captured.length === 0);

  // A rejecting insert must be invisible: track() does not throw and
  // no unhandled rejection escapes (the harness would crash on one).
  __setAnalyticsInserterForTests(() => Promise.reject(new Error('table missing')));
  resetPageViewGuard();
  threw = false;
  try {
    track('page_view', { page: 'audio' });
    track('project_created', {});
  } catch { threw = true; }
  await new Promise((r) => setTimeout(r, 10));
  check('track never throws when the insert rejects', !threw);

  __setAnalyticsInserterForTests(() => { throw new Error('sync boom'); });
  threw = false;
  try { track('project_created', {}); } catch { threw = true; }
  check('track never throws when the insert throws synchronously', !threw);

  __setAnalyticsInserterForTests(null);
  setSession(null);

  console.log(`\nanalytics-harness: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
