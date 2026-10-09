# HID Platform Super Admin - AI & Processing update

Date: 20 July 2026  
Status: implemented locally; database migration, secret provisioning, provider tests, and environment validation are not claimed.

## Delivered

- Preserved the existing Platform Admin dashboard, widgets, analytics, controls, and scroll navigation.
- Added compact HID Migrate and AI infrastructure metrics to the existing dashboard.
- Added the platform-admin-only `/eminence/ai-processing` workspace with:
  - HID Migrate overview;
  - OCR and AI provider cards;
  - real provider connectivity testing;
  - masked credential management;
  - model management and workload-purpose assignment;
  - primary/fallback workload routing;
  - OCR-then-AI and direct-multimodal processing strategies;
  - processing health, queue, retry, and dead-letter visibility;
  - provider/workload/organization/project usage;
  - token, page, latency, failure, retry, and cost metrics;
  - platform budget thresholds and explicit non-critical blocking policy.
- Added provider/model/configuration version pinning when a job is inserted. A later routing change affects new jobs only.
- Added worker-only runtime credential resolution. Raw credentials are decrypted only for authenticated worker claims and those responses are marked `no-store`.
- Added usage-event recording from worker success/failure paths.
- Added append-only platform audit events for provider, key, model, route, budget, connection-test, and manual-retry actions. Raw secret values are excluded.

## Security boundary

- Only `platform_admin` may call `admin-ai-processing`.
- AI provider/configuration/usage tables have RLS enabled and no authenticated/anonymous grants or policies.
- The browser receives only `api_key_masked` and `has_api_key`.
- API keys are encrypted with AES-256-GCM using a server-only key derived from `HID_AI_CONFIG_KEK`.
- `HID_AI_CONFIG_KEK` must be at least 32 characters and must be provisioned in retired hosted identity backend Edge Function secrets and worker runtime secrets. It must never be a `VITE_*` variable.
- Provider tests return user-facing connectivity states without returning provider response bodies or credentials.
- Provider quota or remaining-token information is shown only if a provider supplies it. Otherwise the interface says “Not provided by provider.”

## Deployment requirements

1. Apply `20260722100000_admin_ai_processing_infrastructure.sql` in an isolated environment.
2. Provision `HID_AI_CONFIG_KEK` with an environment-specific secret.
3. Deploy `admin-ai-processing` and the updated `migration-worker-jobs`.
4. Configure a synthetic provider credential and run a real connection test.
5. Verify worker claim responses are not logged by the gateway, worker, or observability pipeline.
6. Exercise primary/fallback routing, rate limiting, timeout, retry, and dead-letter paths with synthetic documents.
7. Run the SQL contract test and cross-role access tests before staging approval.

## Intentionally not claimed

- No provider was configured or contacted from this workspace.
- No database migration or Edge Function was deployed.
- No provider quota, token balance, credits, or rate-limit values were invented.
- Provider/project budget enforcement is recorded and displayed, but actual job blocking remains policy-driven and requires an approved worker enforcement rule.
- Production launch still requires the existing release evidence gates and approvals.
