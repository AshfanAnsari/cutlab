// Deployment configuration (Phase 1 — lockdown + accounts).
//
// OWNER_UID is the Supabase Auth user id of the CutLab owner. It gates
// exactly one thing: the "Jarvis control" live-drive surface, which is
// owner-only in the public product (PLAN-PUBLIC-PRODUCT-DRAFT Phase 1).
// It is NOT a credential — RLS does the real work (a command row can
// only be read/patched by the account it belongs to); this constant
// only decides whether the control UI exists in this browser at all.
//
// DEPLOY STEP (coordinator): after the owner creates their account,
// set this to that account's auth uid — the same uid used in the claim
// block at the bottom of supabase/phase1-migration.sql — then rebuild.
// While it is empty, Jarvis control is unavailable in the app (the
// gate reports "not configured"), for every account including the
// owner's. That is deliberate: control never ships half-configured.

export const OWNER_UID = ''; // set to your own Supabase Auth user id (see above)
