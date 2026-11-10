# Deploying cutlab-account (coordinator step — dashboard, ~5 minutes)

Phase 3 C2. The function in `index.ts` is authored and reviewed at
base; it is NOT deployed by the builder. Deploy it from the Supabase
dashboard of the shared project **hjdyvaetxhvxzgsdlibt** (dashboard
sign-in is "Continue with GitHub"):

1. Dashboard → **Edge Functions** → **Create a new function**.
2. Name it exactly: `cutlab-account`.
3. Paste the full contents of
   `supabase/functions/cutlab-account/index.ts` into the editor,
   replacing the template.
4. **Leave "Verify JWT" ON** (the default). This is the opposite of
   cutlab-mcp on purpose: callers here are real Supabase sessions, so
   the platform gateway validates the session JWT before the code
   runs, and the code re-resolves the user against GoTrue.
5. Deploy. No secrets to set: `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform.
6. Endpoint:
   `https://hjdyvaetxhvxzgsdlibt.supabase.co/functions/v1/cutlab-account`

## Post-deploy smoke

```bash
# No token: the gateway itself must refuse (Verify JWT ON).
curl -s -X POST https://hjdyvaetxhvxzgsdlibt.supabase.co/functions/v1/cutlab-account \
  -H 'Content-Type: application/json' -d '{"action":"delete_account"}'
# expect: 401 from the platform (NOT the function's JSON, NOT a 404 —
# a 404 means the function is not deployed under this name)

# Unknown action with any real session token: the function's own 400.
curl -s -X POST https://hjdyvaetxhvxzgsdlibt.supabase.co/functions/v1/cutlab-account \
  -H "Authorization: Bearer $SESSION_JWT" -H 'Content-Type: application/json' \
  -d '{"action":"hello"}'
# expect: {"error":"unknown action — ..."} with HTTP 400
```

Then the full seed/delete proof (throwaway account; never the owner):

```bash
python3 server-tests/account_delete_test.py
```

It signs up a throwaway account, seeds one row in each of the six
tables plus one storage object under the account's own scope, calls
the function with that account's session, and asserts the user, all
rows and the object are gone while the owner's row/file counts are
untouched. Exit 0 = the deletion path works end to end.

## Notes

- Deletion order is storage → rows → login, because every cutlab_
  user_id FK is ON DELETE SET NULL (phase1-migration.sql): deleting
  the login first would orphan the data instead of deleting it.
- Every step is idempotent, so a mid-sweep failure is safe to retry
  from the app. The app clears the local session only on a 200.
- Client behaviour before this deploy: the Account panel's Delete
  button gets a 404 and reports "not switched on yet" — nothing is
  deleted client-side, by design.
