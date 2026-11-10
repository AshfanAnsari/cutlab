# Deploying cutlab-mcp (coordinator step — dashboard, ~5 minutes)

The function in `index.ts` is authored and reviewed at base; it is NOT
deployed by the builder. Deploy it from the Supabase dashboard of the
shared project **hjdyvaetxhvxzgsdlibt** (the Our Study Home project —
dashboard sign-in is "Continue with GitHub"):

1. Dashboard → **Edge Functions** → **Create a new function**.
2. Name it exactly: `cutlab-mcp`.
3. Paste the full contents of `supabase/functions/cutlab-mcp/index.ts`
   into the editor, replacing the template.
4. **Before/without fail after deploying: open the function's settings
   and turn OFF "Verify JWT".** The platform gateway otherwise rejects
   the `clt_…` connect-token Bearer before the function runs — the
   function performs its own token auth (SHA-256 → cutlab_tokens).
5. Deploy. No secrets to set: `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` are injected into every Edge Function by
   the platform.
6. Endpoint: `https://hjdyvaetxhvxzgsdlibt.supabase.co/functions/v1/cutlab-mcp`

## Smoke test (after deploy)

```bash
TOKEN=clt_...   # a registered connect token (the owner's is fine)
curl -s -X POST https://hjdyvaetxhvxzgsdlibt.supabase.co/functions/v1/cutlab-mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# expect: result.serverInfo.name = "cutlab-mcp"
curl -s -X POST https://hjdyvaetxhvxzgsdlibt.supabase.co/functions/v1/cutlab-mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_waiting_render_jobs","arguments":{}}}'
# expect: result.content[0].text = {"jobs":[...]} (possibly empty)
```

Then run the full scripted acceptance:
`python3 server-tests/byom_mcp_client.py --token $TOKEN`
(see its docstring — it queues a fixture agent-lane job as the owner,
claims/renders/uploads/completes it through this endpoint, and checks
isolation with a second throwaway account).

## Notes

- Stateless MCP (2025-03-26): no session ids; every `tools/call` is
  authenticated independently. GET returns 405 with a hint.
- Agent claim lease: 1 hour (`claimed_at` + `payload.agentClaim`);
  completion/failure only accepted from the claiming token, and only
  while the job is `running` (the same status-guard pattern as the
  server worker's finish()).
- If the function misbehaves, the relay is unaffected: agent-lane jobs
  simply stay queued; server-lane work never routes through here.
