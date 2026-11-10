// FALLBACK STUB — deliberately not wired into the app.
//
// The server-first build (user direction, 2026-11-04) removed in-browser
// proxy generation and in-browser export as primary paths: the user's PC
// must not be exerted. This stub keeps the JobService interface shape for a
// possible future local engine, and fails loudly instead of pretending to
// work. The live implementation is jobsServer.ts (job bundles + Lane B).

import type { JobService } from './jobs';

const disabled = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} is disabled in the server-first build — it runs as a server job instead.`);
};

export const localJobFallback: JobService = {
  createMediaJobBundle: disabled('Local media processing'),
  createRenderJobBundle: disabled('Local rendering'),
  ingestServerResults: disabled('Local results ingest'),
};
