# Provider integration management

This inventory describes the executable PR #5 tree. It separates an external
provider from the capability it serves. The Identity API owns the admin catalog
and the persistent routing decisions; each service that calls a provider must
enforce those decisions when it receives new work. A healthy connection test is
operational evidence, not proof of a delivered message or an identity match.

## Current integration inventory

The configuration column names the current environment inputs. In AWS, CDK
sets deployment values and injects named JSON fields from AWS Secrets Manager
into ECS tasks at startup. A setting in the admin catalog never replaces the
provider's credential or grants a new outbound endpoint.

| Provider | Capability and runtime consumer | Current configuration and secret source | Current fallback | Dynamic pause and credential rotation |
| --- | --- | --- | --- | --- |
| AWS SES | Authentication email OTP; `notification-api` | `AWS_REGION`, `SES_FROM_ADDRESS`, `NOTIFICATION_PROVIDER_TIMEOUT_MS`; sender from `NotificationProviderSecretArn`, AWS task IAM for signing | Brevo email only after a definitive SES failure and only in the full delivery profile | Runtime pause/routing is safe when enforced before `SendEmail`; no live IAM or sender rotation from the application. |
| Termii | Authentication SMS OTP; `notification-api` | `TERMII_BASE_URL`, `TERMII_API_KEY`, `TERMII_SENDER_ID`, `TERMII_CHANNEL`, provider timeout; base URL, key, sender from `NotificationProviderSecretArn` | Brevo SMS on a definitive failure if its SMS sender and key are configured | Safe to pause before a new send; rotate key in AWS Secrets Manager and refresh the ECS task, not in the application database. |
| Meta / WhatsApp | Authentication WhatsApp OTP; `notification-api` | `META_GRAPH_BASE_URL`, `META_GRAPH_API_VERSION`, `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN`, `META_OTP_TEMPLATE_NAME`, `META_OTP_TEMPLATE_LANGUAGE`, provider timeout; ID, token, template from `NotificationProviderSecretArn` | Brevo WhatsApp on a definitive failure if configured | Safe to pause before a new send; token rotation remains a provider/AWS/ECS operation. |
| Brevo | Optional authentication email, SMS, WhatsApp fallback; `notification-api` | `BREVO_API_KEY`, `BREVO_EMAIL_FROM`, `BREVO_SMS_SENDER`, `BREVO_WHATSAPP_SENDER`, provider timeout; key and sender fields from `NotificationProviderSecretArn` | None after Brevo | Safe to pause; an unavailable or unconfigured fallback fails safely. Key rotation remains external. |
| Novu | Ordinary event notifications; `notification-worker` after EventBridge and SQS | `NOTIFICATION_WORKER_ENABLED`, `NOVU_MODE`, `NOVU_API_URL`, `NOVU_API_KEY`; key from `NotificationProviderSecretArn`, staging API origin from `StagingNovuApiUrl` | No other wired orchestrator | Worker retry/queue handling requires operational coordination, so it is catalogued without a dashboard pause command. Key rotation requires AWS secret update and task refresh. |
| QoreID | Existing-patient NIN evidence, public patient enrollment, and CAC Basic V2 organization verification; `identity-api` | `QOREID_ENABLED`, separate default-off `QOREID_NIN_ONLY_ENROLLMENT_ENABLED`, fixed base URL, timeout, OAuth fields; `QoreIdCredentialsSecretArn` is injected only when CDK `HID_QOREID_ENABLED=true`; enabled staging also injects the NIN lookup and encryption keys from `IdentitySensitiveSecretArn` | None; new verification fails closed | Runtime pause blocks new verification calls while preserving prior identities. The entitled sandbox NIN-only request and response contract are empirically confirmed; its enrollment gate stays off pending release/security gates. CAC Basic V2 calls use the confirmed endpoint and response parser when the general gate and runtime provider are enabled; entitled-account CAC access has not been exercised in this PR. Credentials require provider/AWS rotation and task refresh. |
| Cloudflare Turnstile | Bot challenge for public authentication, patient enrollment, and organization application; browser widget plus `identity-api` Siteverify | Public `VITE_TURNSTILE_SITE_KEY`; server `TURNSTILE_MODE`, `TURNSTILE_SITEVERIFY_URL`, `TURNSTILE_TIMEOUT_MS`, `TURNSTILE_SECRET_KEY` from `IdentitySensitiveSecretArn` | None; a required challenge fails closed | Production requires Turnstile. A general admin pause would weaken that boundary, so this is read only. Secret and site key rotation require Cloudflare/AWS and, for the public key, a frontend build. |
| Google OIDC | Existing account sign in; `apps/web` and `identity-api` | Public `VITE_GOOGLE_CLIENT_ID`; server `GOOGLE_OIDC_CLIENT_IDS` allowlist from `IdentitySensitiveSecretArn`; fixed Google JWKS and issuer | No automatic account creation or identity-provider fallback | Catalogued read only. Client ID/allowlist changes require frontend build and secure deployment configuration. Existing HID sessions are independent of a temporary Google outage. |
| Generic OIDC and workload issuer/JWKS | Configured login trust and service-to-service JWT verification; Identity and domain APIs | `AUTH_MODE`, `OIDC_ISSUER_URL`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL`; workload `WORKLOAD_ISSUER_URL`, `WORKLOAD_JWKS_URL`, audiences and exact caller subjects | No authorization fallback | Infrastructure trust boundary. Never allow a dashboard pause or arbitrary issuer/JWKS URL update. Signing-key rotation is an infrastructure operation. |
| AWS S3 and KMS | Clinical document storage and exact OCR document reads; `ehr-api`, `ocr-worker` | `STORAGE_MODE`, `S3_REGION`, `S3_BUCKET`, `S3_KMS_KEY_ID`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`; worker `AWS_REGION`, `AWS_ENDPOINT_URL`; workload IAM/KMS grants | No storage fallback in production | Read only infrastructure; production storage is required. IAM/KMS and bucket changes require infrastructure rollout. |
| AWS Textract | OCR extraction; `ocr-worker` | `OCR_PROVIDER`, `OCR_TEXTRACT_POLL_MS`, `OCR_TEXTRACT_MAX_POLL_SECONDS`, `AWS_REGION`; workload IAM | Test adapter only under `NODE_ENV=test`; no production fallback | Read only infrastructure; production requires Textract. Do not pause via ordinary provider controls. |
| AWS EventBridge and SQS | Domain outbox dispatch and ordinary notification queue; `event-dispatcher`, `notification-worker` | `EVENT_DISPATCHER_ENABLED`, `EVENT_DISPATCHER_TRANSPORT`, `EVENTBRIDGE_EVENT_BUS_NAME`, `NOTIFICATION_WORKER_QUEUE_URL`, `AWS_REGION`; workload IAM | Deterministic transport is test only; no production fallback | Read only infrastructure. Pausing would strand or delay work and requires the event/queue operational runbook. |
| Cloudflare Workers, edge DNS, origin authentication | Seven browser applications, API proxy and static assets; `infra/cloudflare` | Wrangler deployment profile, fixed `API_ORIGIN` and `EXPECTED_HOST`; `ORIGIN_AUTH_TOKEN` Worker secret binding paired with AWS WAF parameter | No automatic alternative edge | Deployment infrastructure, not a selectable business provider. Rotate its secret through Cloudflare/WAF release procedures. |
| GitHub Actions/API and AWS release services | Build, audit, OIDC federation, ECR image publishing, TUF signing and object publication; `release/`, `infra/aws` | Protected workflow identity, `GITHUB_*`, `GH_*_READ_TOKEN`, short-lived Actions OIDC token; AWS IAM, KMS, S3, ECR and Secrets Manager | No runtime business fallback | Release infrastructure only; no dashboard pause or credential update. |

Additional AWS platform dependencies include RDS/PostgreSQL, IAM, Secrets
Manager, ECR, CloudWatch Logs and WAF. Their task/database credentials and
policies are deployment-owned, not provider-routing settings. Local development
may use explicit `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` or S3 access keys;
the production notification and event services prohibit static AWS keys and
use workload IAM.

### Prepared or absent integrations

| Name | Executable state | Admin treatment |
| --- | --- | --- |
| Firebase Cloud Messaging | `FcmPushProvider` adapter and `FCM_PROJECT_ID`/`FCM_API_URL` inputs exist, but the current notification worker instantiates Novu only and has no live credential provider. | Read only/unavailable; never offer as an active notification route. |
| MetaMap GovChecks | Superseded standalone NIN research transport and signature primitive. It is deliberately not a `NinVerificationProvider`, and no current runtime credential injection activates it. | Read only/unavailable; never use it to claim NIN assurance. |
| PiersFlow | No executable adapter, runtime consumer, environment variable, or credential reference exists. Migration `0053` removes the historical inert catalog row. | Absent from the admin catalog. |
| Infobip, Supabase, Vercel | Historical or redaction references only; not active outbound business integrations. | No selectable provider. |

## Provider and capability matrix

| Capability | Approved implemented provider(s) | Current selection/fallback rule |
| --- | --- | --- |
| Email OTP | AWS SES, Brevo | SES primary; Brevo can be the configured fallback in the full profile. |
| SMS OTP | Termii, Brevo | Termii primary; Brevo can be the configured fallback in the full profile. |
| WhatsApp OTP | Meta, Brevo | Meta primary; Brevo can be the configured fallback in the full profile. |
| Patient NIN | QoreID | One verification provider; no fallback. Existing-patient evidence and new public enrollment are separate routes. New enrollment additionally needs an exact NIN binding, chosen-contact OTP, and password; its NIN-only gate stays off pending release/security gates. |
| Provider CAC | QoreID Basic V2 | The confirmed contract is implemented with synthetic fixtures. General QoreID and runtime pause gates apply; entitled-account CAC execution still needs staging acceptance. Approval requires authoritative organization binding and separate platform review. |
| Ordinary notifications | Novu | One wired orchestrator; no automatic fallback. |
| Push notifications | FCM adapter only | Not wired to the worker; unavailable for selection. |
| Bot challenge | Turnstile | Required production security control; no alternative. |
| Federated account sign in | Google OIDC or separately configured generic OIDC mode | Authentication trust configuration, not patient identity verification. |
| OCR, document storage, events, queue | AWS Textract, S3/KMS, EventBridge, SQS | Infrastructure requirements, not interchangeable business providers. |

## Admin contract and runtime behavior

The Admin application shows **Settings → Integrations** only with
`platform.integration.read`. `platform.integration.manage` authorizes supported
provider state/configuration and channel routing commands;
`platform.integration.test` authorizes connection tests. Identity API route
guards and database functions independently check these permissions. The
`platform.integration_providers` and `platform.integration_capability_routes`
tables use optimistic row versions and append-only change events. Mutations
require `If-Match`, an idempotency key, a recorded reason where relevant, and
the existing semantic audit context. A reader or security auditor cannot turn
an infrastructure dependency off merely because the catalog displays it.

| API route under `/api/v1` | Purpose |
| --- | --- |
| `GET /admin/integrations`, `GET /admin/integrations/:provider` | Bounded, secret-free catalog and detail. |
| `POST /admin/integrations/:provider/enable`, `/pause`, `/configuration` | Change supported runtime state or allowlisted non-secret values. |
| `POST /admin/integrations/:provider/credential-reference` | Explicitly unsupported for the present ECS-injected credentials; it cannot accept a plaintext key. |
| `POST /admin/integrations/:provider/test` | Record a safe, non-sending provider check and last test outcome. |
| `GET /admin/integrations/:provider/audit` | Bounded provider change/test history without secrets. |
| `POST /admin/integrations/capabilities/:capability/selection`, `/fallback` | Select compatible configured providers for email, SMS or WhatsApp. |

The dashboard's persisted state covers enabled/paused flags, compatible OTP
routes, allowlisted non-secret sender/template settings, test outcomes, and
append-only change history. It does not persist credentials or override
deployment gates. New calls to a paused provider are rejected; an already
verified identity or organization remains valid. A provider outage returns a
bounded application error. No identity verification silently switches to a
different provider.

| Integration | Dashboard control and test semantics | State and failure boundary |
| --- | --- | --- |
| SES, Termii, Meta/WhatsApp, Brevo | Authorized enable/pause, compatible channel selection, and the allowlisted sender/template settings below. No provider connection probe is implemented. | Runtime route and non-secret settings are persisted and audited; credentials stay in AWS. Definitive send failure permits only the configured compatible fallback; ambiguous outcomes fail without another send. |
| QoreID | Authorized enable/pause and an OAuth-only, non-sending connection test when enabled and configured. The test does not prove NIN match or CAC entitlement. | Runtime state and bounded test outcome are persisted and audited. The general deployment gate applies to CAC; the separate NIN-only gate applies only to patient enrollment. Provider errors fail closed without another identity provider. |
| Novu and FCM scaffold | Catalog visibility only; no dashboard pause, selection, or provider probe. | Novu worker operation is deployment/runbook controlled; FCM has no live route. Queue failure follows worker retry handling. |
| Turnstile, Google/generic OIDC, AWS storage/OCR/events, Cloudflare edge, release services | Read-only inventory where represented; no dashboard pause, credential edit, or app-level connection probe. | Deployment/environment configuration and external health tooling own these dependencies. Security controls and trust boundaries fail closed under their owning service. |

The Admin UI disables actions when either the actor lacks permission or the
backend omits the action from `availableActions`. The provider/capability
relationship is server controlled. Non-secret configuration is limited to SES
`fromAddress`, Termii `senderId`/`channel`, Meta `phoneNumberId`/`templateName`/
`templateLanguage`, and Brevo `emailFrom`/`smsSender`/`whatsappSender`.
Administrators cannot supply an arbitrary HTTP destination. The QoreID origin,
Meta Graph origin and Brevo origin remain fixed or validated in server code.

For a new OTP request, the Identity API reads the current database provider
and capability route and sends a bounded non-secret delivery plan over its
authenticated workload call. The Notification API validates that plan before
calling a provider; live mode rejects requests without one. A paused provider receives no
new request. Fallback is permitted only when the configured provider supports
the same capability, is enabled and configured, and the primary outcome is a
**definitive failure**. An unknown outcome, including a timeout after a send
may have reached the provider, does not trigger another send. In staging's
`email-only` profile, SMS/WhatsApp and Brevo fallback stay disabled. Without a
valid fallback, delivery fails with provider-unavailable evidence. A request
already in flight when an administrator pauses a provider may finish.

The Notification API accepts delivery plans only from the authenticated
Identity workload. It validates capability, provider names, and allowlisted
settings, but does not independently query the Identity database. A plan
already issued before a pause can finish as in-flight work. Notification
workload credentials therefore remain restricted to the Identity API.

QoreID pause blocks new NIN and CAC requests at the Identity verification
boundary. It does not revoke existing patients, organizations, sessions, or
verification evidence. `QOREID_ENABLED=false` or missing approved credentials
remains an independent deployment gate and must fail closed. Neither a provider
test nor a status-only verification result authorizes Health ID issuance or
organization approval. Public enrollment requires verified registry identity,
a unique NIN, chosen-contact OTP, and password before atomic HID activation.
Existing-patient verified NIN evidence also requires an
exact prior keyed NIN binding; the authoritative NIN/CAC contracts are documented
separately in [QoreID verification](QOREID_VERIFICATION_CONTRACT.md).

Migration `0049_qoreid_request_quotas.sql` applies shared hourly and daily
limits before outbound NIN, CAC, and QoreID connection-test calls. The public
organization application form has a separate keyed network quota after
Turnstile verification. Quota rows contain account or application identifiers,
or a keyed network digest; they contain no NIN, CAC number, raw IP, or provider
response. Identity API prunes expired rows hourly, and the database command
also prunes bounded expired rows during use. Denials return a safe 429 and make
no provider request. Test-key reservations prevent a concurrent replay from
making a second OAuth probe. Production requires the existing server-only OTP
HMAC key for the public network digest; local development uses an ephemeral key.

## Credential boundary and limitations

No API response, browser storage, migration, audit event, log or error should
contain a plaintext provider credential, NIN, CAC number, or raw provider
payload. The dashboard renders a fixed mask and a credential *state*; it does
not receive or display secret values. Provider tests return bounded outcome
codes and timestamps. The application database contains only operational
enablement, compatible routes, allowlisted non-secret values, versions, and
audit metadata.

The current ECS task definitions inject Secrets Manager JSON fields as
environment variables at task startup. Updating a secret or an ARN through an
admin API cannot refresh running tasks safely or atomically. The dashboard
therefore disables **Rotate Credential** for these providers. Rotation requires
the provider's credential process, an environment-scoped AWS secret update,
task rollout and verification; Cloudflare secrets and frontend public site
keys follow their own deployment paths. Credential-reference updates can be
enabled later only with a reviewed secret access/refresh design, no plaintext
entry, and an audited rollback path.

The catalog reflects local implementation and configured state. The entitled
QoreID sandbox NIN-only request and response were verified by the project owner;
the catalog does not claim production activation, CAC entitlement, successful
staging OTP delivery, or production readiness. See
[staging provider accounts](STAGING_PROVIDER_ACCOUNTS.md) and
[AWS deployment runbook](AWS_DEPLOYMENT_RUNBOOK.md) for external prerequisites.
