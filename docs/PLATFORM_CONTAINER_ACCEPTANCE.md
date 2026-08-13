# HID Platform Container Acceptance

## Current container-security checkpoint — 2026-08-13

All twelve governed local targets now build with pinned non-root final bases.
The ten Node services and EHR migration target use Distroless Node 22 Debian
13 as UID/GID 65532; the API-only Gateway uses pinned unprivileged Nginx as UID
101. Docker Scout reports zero vulnerabilities for each Node/migration image
and zero critical/high findings for Gateway. All twelve final filesystems
produced zero high-confidence secret findings, and twelve SPDX SBOMs passed
checksum verification.

Representative and full-topology container acceptance passed locally. Seven
APIs reached liveness/readiness, six database-backed APIs and both dispatchers
failed readiness closed and recovered across a disposable PostgreSQL outage,
two OCR workers polled concurrently through a non-owner login, two dispatchers
were ready, disabled Notification Worker remained live but not ready without
providers, and Gateway preserved its API-only response and proxy contracts.
Node processes handled SIGTERM and Gateway handled SIGQUIT. The migration
target applied migrations `0001`–`0028` and returned zero pending for plan and
dry-run. No external provider or deployment system was contacted.

Runtime testing found and corrected two packaging-visible lifecycle defects:
Notification API now treats its provider override as optional Nest injection,
and disabled Notification Worker closes its status server on SIGTERM/SIGINT.
Both corrected images were rebuilt, rescanned, and retested successfully.

Source `df4f41328375c9a2235c2e6d48dd482ff6f432af` remains a permanently rejected
release candidate. The complete image, SBOM, scan, filesystem, runtime, and
frontend evidence must be regenerated from the exact clean remediation commit
before promotion. ECR, Inspector, AWS, and Cloudflare deployment evidence
remains externally pending.

## Previous production-convergence checkpoint — 2026-08-12

The current static contract covers ten backend executables (Identity, EHR,
Lab, Pharmacy, OCR API, OCR Worker, Outreach, Notification API, Notification
Worker, Event Dispatcher), the API-only Gateway, and a separate migration
target. AWS therefore has eleven long-running service images, eleven ECR
repositories, and twelve digest inputs. Gateway's locked two-stage Nginx image
contains no app build or static asset. Seven frontend builds are independent
Cloudflare Workers Static Assets publications.

Docker is available in the current environment, but final release images,
digests, SBOMs, vulnerability scans, registry comparison, and live container
acceptance are not performed or claimed by this source-convergence stage.
Migrations `0001`–`0027` remain immutable and additive `0028` is current.

The 2026-08-11 report below is retained as historical container-extraction
evidence. Its shared static Gateway, eight-backend count, Docker-unavailable,
CloudFront, and `0027`-tip statements are superseded by this checkpoint.

Acceptance date: 2026-08-11. Scope: production packaging and deployment contracts for the eight backend runtimes, seven browser applications, and the platform gateway. No AWS resource was provisioned and migrations `0001` through `0027` were not modified.

Evidence labels in this report are exclusive: `LOCALLY EXECUTED`, `STATICALLY VERIFIED`, `EXTERNALLY PENDING`, and `NOT APPLICABLE`. A host-process result is not presented as a container result.

## 1. Runtime inventory

| Runtime | Source path | Dockerfile | Build context | Build command | Runtime command | Port / route | Health | User | Packaging model | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| Identity API | `services/identity-api` | `services/identity-api/Dockerfile` | repository root | `npm ci`; `npm run build` | `node dist/main.js` | 3001 | `/api/v1/health/live`, `/ready` | `node` | multi-stage Node API | STATICALLY VERIFIED |
| EHR API | `services/ehr-api` | `services/ehr-api/Dockerfile` | repository root | locked API-client + EHR builds | `node dist/main.js` | 3002 | `/api/v1/health/live`, `/ready` | `node` | multi-stage Node API; separate migration target | STATICALLY VERIFIED |
| Lab API | `services/lab-api` | `services/lab-api/Dockerfile` | repository root | locked API-client + Lab builds | `node dist/main.js` | 3003 | `/api/v1/health/live`, `/ready` | `node` | multi-stage Node API | STATICALLY VERIFIED |
| Pharmacy API | `services/pharmacy-api` | `services/pharmacy-api/Dockerfile` | repository root | locked API-client + Pharmacy builds | `node dist/main.js` | 3004 | `/api/v1/health/live`, `/ready` | `node` | multi-stage Node API | STATICALLY VERIFIED |
| OCR API | `services/ocr-api` | `services/ocr-api/Dockerfile` | repository root | locked API-client + OCR builds | `node dist/main.js` | 3005 | `/api/v1/health/live`, `/ready` | `node` | multi-stage Node API | STATICALLY VERIFIED |
| OCR Worker | `services/ocr-worker` | `services/ocr-worker/Dockerfile` | repository root | `npm ci`; `npm run build` | `node dist/main.js` | none | process/lease lifecycle | `node` | multi-stage portless Node worker | STATICALLY VERIFIED |
| Outreach API | `services/outreach-api` | `services/outreach-api/Dockerfile` | repository root | locked API-client + Outreach builds | `node dist/main.js` | 3006 | `/api/v1/health/live`, `/ready` | `node` | multi-stage Node API | STATICALLY VERIFIED |
| Event Dispatcher | `services/event-dispatcher` | `services/event-dispatcher/Dockerfile` | repository root | `npm ci`; `npm run build` | `node dist/main.js` | 3010 | `/api/v1/health/live`, `/ready`, `/status`, `/metrics` | `node` | multi-stage Node worker/status server | STATICALLY VERIFIED |
| Web | `apps/web` | `gateway/Dockerfile` | repository root | `npm --prefix apps/web ci`; build | shared Nginx | 3000 `/` | gateway health | `101` | Vite static build in gateway | STATICALLY VERIFIED |
| EHR | `apps/ehr` | `gateway/Dockerfile` | repository root | locked EHR static build | shared Nginx | 3000 `/ehr/` | gateway health | `101` | canonical static artifact in gateway | STATICALLY VERIFIED |
| Lab | `apps/lab` | `gateway/Dockerfile` | repository root | locked Lab static build | shared Nginx | 3000 `/lab/` | gateway health | `101` | Vite static build in gateway | STATICALLY VERIFIED |
| Pharmacy | `apps/pharmacy` | `gateway/Dockerfile` | repository root | locked Pharmacy static build | shared Nginx | 3000 `/pharmacy/` | gateway health | `101` | Vite static build in gateway | STATICALLY VERIFIED |
| OCR | `apps/ocr` | `gateway/Dockerfile` | repository root | locked OCR static build | shared Nginx | 3000 `/ocr/` | gateway health | `101` | Vite static build in gateway | STATICALLY VERIFIED |
| Outreach | `apps/outreach` | `gateway/Dockerfile` | repository root | locked Outreach static build | shared Nginx | 3000 `/outreach/` | gateway health | `101` | Vite static build in gateway | STATICALLY VERIFIED |
| Admin | `apps/admin` | `gateway/Dockerfile` | repository root | locked Admin static build | shared Nginx | 3000 `/admin/` | gateway health | `101` | Vite static build in gateway | STATICALLY VERIFIED |
| Gateway | `gateway` | `gateway/Dockerfile` | repository root | seven locked frontend builds | unprivileged Nginx | 3000 | `/gateway-health/live`, `/ready` | `101` | multi-stage static host/reverse proxy | STATICALLY VERIFIED |

Standalone ports 3100–3106 are local preview/development evidence, not seven redundant production servers.

## 2. Backend container matrix

| Runtime | Preserved boundary | Production artifact result | Status |
|---|---|---|---|
| Identity API | Identity/auth/session, workload verification, canonical patient/HID authority; no Lab, Pharmacy, OCR-provider, or Textract requirement | Narrow final copy, locked production dependencies, port 3001, exec-form startup | STATICALLY VERIFIED |
| EHR API | No `ehr/server`; extracted Lab/Pharmacy/OCR controllers remain absent | Runtime excludes central migration scripts/ledger; a separate `migration` target owns the controlled executor | STATICALLY VERIFIED |
| Lab API | Lab role, Identity authorization, EHR acceptance, OCR imports, explicit verification/release semantics | Narrow API-client and service output only | STATICALLY VERIFIED |
| Pharmacy API | `prescribed != accepted != dispensed != administered` remains unchanged | Narrow API-client and service output only | STATICALLY VERIFIED |
| OCR API | Independent of Worker and provider execution credentials | API-only final runtime; OCR provider stays in Worker | STATICALLY VERIFIED |
| OCR Worker | `SKIP LOCKED`, leases/tokens, object version/hash, bounded retry, immutable extraction, graceful stop | Portless independent executable; no fabricated HTTP health | STATICALLY VERIFIED |
| Outreach API | Identity authority, temporary IDs, idempotent sync, worker/facility authorization | Narrow API-client and service output only | STATICALLY VERIFIED |
| Event Dispatcher | TLS, leases, retry, deterministic non-production transport, EventBridge, drain, role, metrics | Independent status runtime on 3010 | STATICALLY VERIFIED |

All eight host builds were also run by root `npm run build`: `LOCALLY EXECUTED`. Their OCI builds are recorded separately below.

## 3. Frontend packaging matrix

| App | Framework/output | Base | Fresh host build | OCI packaging |
|---|---|---|---|---|
| Web | React/Vite static output | `/` | LOCALLY EXECUTED | STATICALLY VERIFIED |
| EHR | canonical standalone/static output built by Vite tooling | `/ehr/` | LOCALLY EXECUTED | STATICALLY VERIFIED |
| Lab | React/Vite static output | `/lab/` | LOCALLY EXECUTED | STATICALLY VERIFIED |
| Pharmacy | React/Vite static output | `/pharmacy/` | LOCALLY EXECUTED | STATICALLY VERIFIED |
| OCR | React/Vite static output | `/ocr/` | LOCALLY EXECUTED | STATICALLY VERIFIED |
| Outreach | React/Vite static output | `/outreach/` | LOCALLY EXECUTED | STATICALLY VERIFIED |
| Admin | React/Vite static output | `/admin/` | LOCALLY EXECUTED | STATICALLY VERIFIED |

`apps/web` remains Vite; it was not rewritten. Browser variables are restricted to `VITE_*`, and built/source scans reject backend configuration imports and internal workload-token/database variables.

## 4. Gateway container/route model

| Item | Evidence | Status |
|---|---|---|
| Seven UI roots and slash redirects | Nginx template owns `/`, `/ehr/`, `/lab/`, `/pharmacy/`, `/ocr/`, `/outreach/`, `/admin/` | STATICALLY VERIFIED |
| API ownership | Identity owns auth/identity/audit/admin; EHR owns ehr and legacy `/api` fallback; Lab, Pharmacy, OCR, Outreach own exact prefixes | STATICALLY VERIFIED |
| Dispatcher exposure | No browser route to 3010 | STATICALLY VERIFIED |
| Forwarding boundary | Host/proto/forwarded-for are overwritten; Origin, CSRF, and correlation are explicitly relayed | STATICALLY VERIFIED |
| Failure response | 502/503/504 become bounded Problem Details `UPSTREAM_UNAVAILABLE` | STATICALLY VERIFIED |
| Static cache policy | workers are no-store; hashed assets immutable | STATICALLY VERIFIED |
| Running Nginx gateway | No container engine was present | EXTERNALLY PENDING |

## 5. Docker availability

| Check | Result | Status |
|---|---|---|
| `docker --version` | command not found | EXTERNALLY PENDING |
| `docker info` | command not found | EXTERNALLY PENDING |
| Podman or compatible engine | absent | EXTERNALLY PENDING |
| Automatic installation | deliberately not attempted | NOT APPLICABLE |

Docker execution is an environment prerequisite, not a hidden acceptance pass.

## 6. Image build results

| Evidence | Result | Status |
|---|---|---|
| Eight backend TypeScript/Nest production builds | passed in root build | LOCALLY EXECUTED |
| Seven frontend production builds | passed in root build | LOCALLY EXECUTED |
| Backend OCI images | not built without an engine | EXTERNALLY PENDING |
| Shared gateway/frontend OCI image | not built without an engine | EXTERNALLY PENDING |
| EHR migration target image | not built without an engine | EXTERNALLY PENDING |

## 7. Image tags/digests/sizes

| Item | Result | Status |
|---|---|---|
| Application image tags | none assigned because no image was built | EXTERNALLY PENDING |
| Application image digests | none observed | EXTERNALLY PENDING |
| Compressed/uncompressed sizes | none observed | EXTERNALLY PENDING |
| Base references | `node:22-bookworm-slim` and `nginxinc/nginx-unprivileged:1.27-alpine` are statically visible but unresolved mutable tags | STATICALLY VERIFIED |
| Resolved/pinned base digests | requires the build/release environment | EXTERNALLY PENDING |

## 8. Runtime users

| Runtime group | Declared user | Status |
|---|---|---|
| Eight backend final stages | `USER node` | STATICALLY VERIFIED |
| EHR migration target | `USER node` | STATICALLY VERIFIED |
| Gateway final stage | `USER 101` in unprivileged Nginx | STATICALLY VERIFIED |
| Actual UID/GID inside built images | not observable without images | EXTERNALLY PENDING |
| `chmod 777` | absent from deployment artifacts | STATICALLY VERIFIED |

## 9. Image content inspection

| Check | Result | Status |
|---|---|---|
| Docker COPY graph | final backends copy manifests, production dependencies, and compiled output; gateway copies seven `dist` trees plus Nginx configuration | STATICALLY VERIFIED |
| EHR API/migration separation | API final stage excludes `database/` and migration scripts | STATICALLY VERIFIED |
| Whole-context final copies | rejected by `verify:containers` | STATICALLY VERIFIED |
| Actual final filesystem/layer inventory | no image exists to inspect | EXTERNALLY PENDING |

## 10. Image scan results

| Scanner/evidence | Result | Status |
|---|---|---|
| Trivy | absent | EXTERNALLY PENDING |
| Grype | absent | EXTERNALLY PENDING |
| Syft/SBOM | absent | EXTERNALLY PENDING |
| OS/base-image CVEs | not measured | EXTERNALLY PENDING |
| Application image CVEs | not measured | EXTERNALLY PENDING |

No image-scan claim is made.

## 11. Dependency audit

Production `npm audit` was run against all deployable package locks using the live npm registry: `LOCALLY EXECUTED`.

| Package group | Raw result / review | Status |
|---|---|---|
| Eight backend runtimes | zero production dependency vulnerabilities | LOCALLY EXECUTED |
| EHR and Admin frontends | zero production dependency vulnerabilities | LOCALLY EXECUTED |
| Pharmacy and OCR frontends | two moderate React Router advisories each; affected SSR deserialization path is not used by these client-only SPAs | LOCALLY EXECUTED |
| Web frontend | one high `xlsx` finding and three moderate findings in the DOMPurify/React Router tree | LOCALLY EXECUTED |
| Lab and Outreach lock reports | raw report includes stale `../web/node_modules/*` lock entries (206 each), producing findings not attributable to their built runtime bundles | LOCALLY EXECUTED |

The `xlsx` parser consumes only the immutable bundled facilities workbook; there is no user-upload parser path. This is a bounded residual dependency risk, not evidence that the advisory is fixed. Replace the runtime workbook parser with generated trusted JSON or document an approved exception before production release. React Router major upgrades require a compatibility change and were not applied blindly. Clean the Lab/Outreach lock metadata so future audit attribution is exact.

## 12. Secret scans

| Surface | Evidence | Result | Status |
|---|---|---|---|
| Build context | 1,042 eligible files scanned for high-confidence private keys, AWS keys, private telemetry keys, and embedded non-fixture database passwords | 0 findings | LOCALLY EXECUTED |
| Built output | 764 backend/frontend text artifacts scanned | 0 findings | LOCALLY EXECUTED |
| Frontend policy scan | 141 bundle files plus source boundary checks | passed | LOCALLY EXECUTED |
| Browser internal-port/server-code scan | frontend source/bundles contain no backend DB/token imports or bundled backend runtime configuration | passed | LOCALLY EXECUTED |
| `.dockerignore` | excludes Git, dependencies/build output, all environment variants except examples, workload tokens, AWS credentials, keys/certs, databases, dumps, logs, and editor state | passed | STATICALLY VERIFIED |
| Final image layers | no image available | unverified | EXTERNALLY PENDING |

Secret values were not printed during scanning.

Operational logging writes to stdout/stderr rather than persistent container-local files: `STATICALLY VERIFIED`. API Problem Details tests prove secrets, patient identifiers, and raw clinical notes are absent from failure logs; Worker/Dispatcher tests exercise bounded structured event logging without OCR text, tokens, credentials, presigned URLs, Lab values, or medication detail: `LOCALLY EXECUTED`. Correlation middleware/client tests and the gateway forwarding rule preserve `x-correlation-id`: `LOCALLY EXECUTED`; observation across a running containerized gateway remains `EXTERNALLY PENDING`.

## 13. Health/readiness

| Runtime | Evidence | Status |
|---|---|---|
| Identity, EHR, Lab, Pharmacy, OCR, Outreach | built host processes returned live=200 and ready=200; with PostgreSQL stopped live stayed 200 and ready failed; readiness recovered after restart | LOCALLY EXECUTED |
| OCR liveness audit coupling | an exposed defect was fixed with `@NoAudit`; regression test passes | LOCALLY EXECUTED |
| Dispatcher x2 | both status servers returned ready=200 | LOCALLY EXECUTED |
| OCR Worker | no public health port by design; ready/stopped lifecycle log evidence observed | LOCALLY EXECUTED |
| Backend Docker health tools | Node `fetch` checks avoid an uninstalled curl/wget dependency | STATICALLY VERIFIED |
| Gateway Docker health tool | configured BusyBox `wget`; actual final-image utility execution was not possible | EXTERNALLY PENDING |

## 14. PostgreSQL connectivity

The isolated PostgreSQL 16.14 acceptance cluster applied all 27 migrations, bootstrapped runtime roles, ran the complete rollback-only schema/RLS suite, served all six APIs and four worker processes, stopped/restarted under load, and was removed afterward: `LOCALLY EXECUTED`.

Production RDS address, security groups, DNS, credentials, pool sizing under load, and failover remain `EXTERNALLY PENDING`.

## 15. PostgreSQL TLS

| Check | Result | Status |
|---|---|---|
| TLS negotiation | `pg_stat_ssl.ssl = true` for a representative non-owner login | LOCALLY EXECUTED |
| CA/hostname verification | `verify-full` with the generated localhost CA passed | LOCALLY EXECUTED |
| Wrong CA | connection rejected | LOCALLY EXECUTED |
| Runtime TLS configuration | verified CA required in production; global `NODE_TLS_REJECT_UNAUTHORIZED=0` and URL `ssl*` overrides rejected across all eight DB runtimes | LOCALLY EXECUTED |
| Production RDS CA/endpoint | unavailable | EXTERNALLY PENDING |

## 16. Representative non-owner LOGINs

Eight temporary LOGINs inherited exactly one runtime group each: Identity, EHR, Lab, Pharmacy, OCR API, OCR Worker, Outreach, and Dispatcher. All authenticated over verify-full TLS; none had superuser, create-role, create-database, replication, or BYPASSRLS. The LOGINs and cluster were removed: `LOCALLY EXECUTED`.

Environment-specific production LOGINs remain `EXTERNALLY PENDING`.

## 17. Runtime role denials

Each of the eight representative LOGINs attempted a cross-domain `DELETE ... WHERE false` and received SQLSTATE `42501`: eight of eight denials passed, `LOCALLY EXECUTED`. The full schema/RLS integration suite also passed. Production role grants remain `EXTERNALLY PENDING`.

## 18. Workload token mounts

| Item | Result | Status |
|---|---|---|
| EHR, Lab, Pharmacy, OCR, Outreach callers | source performs `stat` and `readFile` for each request/attempt, enabling rotation rather than startup-only caching | STATICALLY VERIFIED |
| Missing, malformed, oversized, unsafe-mode token behavior | service tests pass fail-closed contracts | LOCALLY EXECUTED |
| Docker COPY behavior | token/secret copies are rejected; mount path must be supplied at runtime | STATICALLY VERIFIED |
| Actual read-only mounted JWT files, rotation, issuer/JWKS validation | no container/workload issuer exists here | EXTERNALLY PENDING |
| Dispatcher HID workload-token mount | architecture does not use one | NOT APPLICABLE |

## 19. Cookie/CSRF/Origin

| Contract | Evidence | Status |
|---|---|---|
| Cookie path/domain | one-origin application model and Identity cookie policy preserved | STATICALLY VERIFIED |
| CSRF and Origin | API guards and tests enforce unsafe-method evidence; gateway explicitly forwards both headers | LOCALLY EXECUTED |
| Spoofed forwarding headers | gateway overwrites Host and forwarded chain at the trust boundary; APIs use explicit `TRUST_PROXY_CIDRS` | STATICALLY VERIFIED |
| Auth entry/unauthorized browser behavior | seven fresh production previews rendered safe unauthenticated entry states | LOCALLY EXECUTED |
| Authenticated cross-app production session | no external Identity environment was supplied | EXTERNALLY PENDING |

## 20. Signal handling

| Runtime | Evidence | Status |
|---|---|---|
| Six APIs | actual SIGTERM caused bounded Node/Nest exits (normal signal status 143 accepted) after health recovery | LOCALLY EXECUTED |
| OCR Worker x2 | SIGTERM stopped new claims, completed bounded shutdown, emitted `ocr.worker.stopped`, exit 0 | LOCALLY EXECUTED |
| Dispatcher x2 | SIGTERM exercised accepted drain and emitted `event_dispatcher.stopped`, exit 0 | LOCALLY EXECUTED |
| Docker stop signal | all backend Dockerfiles declare `STOPSIGNAL SIGTERM`; gateway declares Nginx `SIGQUIT` | STATICALLY VERIFIED |
| PID 1 inside final images | no image runtime available | EXTERNALLY PENDING |
| Static frontend processes | served by the shared gateway, so per-app signals do not exist | NOT APPLICABLE |

The browser harness directly owned and terminated its seven Vite preview children and clean Chrome process; its temporary profile was removed: `LOCALLY EXECUTED`.

## 21. Restart behavior

| Scenario | Evidence | Status |
|---|---|---|
| Six APIs after database restart | readiness returned to 200 without process restart | LOCALLY EXECUTED |
| OCR retry/durable claims | database suite executes active-lease exclusion, persisted retry, claim-token enforcement, and bounded attempts; worker code renews leases and stops accepting claims before close | LOCALLY EXECUTED |
| OCR exact process-crash/stale-lease restart | recovery SQL is present, but no provider job was deliberately killed mid-claim in this run | STATICALLY VERIFIED |
| Dispatcher publish/mark crash window | database and dispatcher tests execute expired-lease redelivery, stable envelope, new token, stale-token denial, and at-least-once semantics | LOCALLY EXECUTED |
| Container restart policy/exit behavior | no orchestrator available | EXTERNALLY PENDING |

## 22. Horizontal scale

| Runtime | Result | Status |
|---|---|---|
| OCR Worker x2 | two built host instances shared one non-owner DB login and reached readiness without claim conflict | LOCALLY EXECUTED |
| Dispatcher x2 | two built host instances shared one non-owner DB login; both status endpoints were ready; DB tests prove exclusive claims and stale-token rejection | LOCALLY EXECUTED |
| Six APIs | review found only immutable configuration/allowlists and bounded per-instance clients; sessions, idempotency, jobs, leases, and authoritative state are PostgreSQL-backed | STATICALLY VERIFIED |
| Gateway | unprivileged Nginx configuration is stateless | STATICALLY VERIFIED |
| Real container replicas/load balancing | no engine/orchestrator | EXTERNALLY PENDING |

No Redis dependency was invented.

## 23. Offline/PWA acceptance

All seven freshly rebuilt production artifacts were served on clean loopback preview origins and exercised in Google Chrome with a new temporary profile: `LOCALLY EXECUTED`.

| App | Offline behavior observed | Status |
|---|---|---|
| Web | cached shell and visible offline state | LOCALLY EXECUTED |
| EHR | cached canonical shell; no new offline clinical authority | LOCALLY EXECUTED |
| Lab | cached shell; no verified/released result fabricated | LOCALLY EXECUTED |
| Pharmacy | cached shell; dispensing/reversal remain live-authoritative | LOCALLY EXECUTED |
| OCR | cached shell; no extraction/publication success fabricated | LOCALLY EXECUTED |
| Outreach | cached shell plus existing encrypted durable outbox contracts preserved | LOCALLY EXECUTED |
| Admin | cached shell; governed mutations remain live-only | LOCALLY EXECUTED |

Chrome transport was genuinely blocked through DevTools. Because headless Chrome 150 continued to expose the host adapter through `navigator.onLine`, the harness additionally set the document-start navigator state to offline so the same blocked reload exercised the visible UI branch. Representative physical-device install/reconnect/quota/key-loss behavior is `EXTERNALLY PENDING`.

## 24. Service-worker scope

| App | Observed active scope | Cache entries | API cache entries | Status |
|---|---|---:|---:|---|
| Web | `http://127.0.0.1:3100/` | 18 | 0 | LOCALLY EXECUTED |
| EHR | `http://127.0.0.1:3101/ehr/` | 3 | 0 | LOCALLY EXECUTED |
| Lab | `http://127.0.0.1:3102/lab/` | 3 | 0 | LOCALLY EXECUTED |
| Pharmacy | `http://127.0.0.1:3103/pharmacy/` | 3 | 0 | LOCALLY EXECUTED |
| OCR | `http://127.0.0.1:3105/ocr/` | 3 | 0 | LOCALLY EXECUTED |
| Outreach | `http://127.0.0.1:3104/outreach/` | 6 | 0 | LOCALLY EXECUTED |
| Admin | `http://127.0.0.1:3106/admin/` | 3 | 0 | LOCALLY EXECUTED |

The production gateway keeps every worker script no-store and every app fallback within its base: `STATICALLY VERIFIED`.

## 25. Sentry/PostHog container status

| Item | Result | Status |
|---|---|---|
| Shared initialization in all seven apps | present through `packages/telemetry` | STATICALLY VERIFIED |
| Build arguments | only public DSN/key/host/release/sample-rate switches | STATICALLY VERIFIED |
| Replay/feedback | integrations filtered out | LOCALLY EXECUTED |
| PostHog autocapture/pageview/persistence | `false`/`false`/`memory` | LOCALLY EXECUTED |
| Safe Sentry destination | DSN/auth token absent; no event sent | EXTERNALLY PENDING |
| Safe PostHog destination | project key/private key absent; no event sent | EXTERNALLY PENDING |

Telemetry destination absence does not block product startup.

## 26. PHI telemetry verification

The telemetry verifier and 311-test aggregate execute event/property allowlists, Sentry exception/request/context/breadcrumb redaction, safe app identities, memory-only analytics, and non-critical initialization/capture failures: `LOCALLY EXECUTED`. Built/source security verification also passed. Observation of actual sanitized payloads at external Sentry/PostHog destinations is `EXTERNALLY PENDING`.

## 27. Browser smoke

| Check | Result | Status |
|---|---|---|
| Browser/version | Google Chrome 150, clean temporary profile | LOCALLY EXECUTED |
| Routes | `/patient`, `/ehr/acceptance-refresh`, `/lab/acceptance-refresh`, `/pharmacy/prescriptions`, `/ocr/jobs`, `/outreach/login`, `/admin/facilities` | LOCALLY EXECUTED |
| Render | seven meaningful shells, no blank root or EHR bundler error | LOCALLY EXECUTED |
| Direct refresh | all seven routes reloaded under service-worker control | LOCALLY EXECUTED |
| Offline reload | all seven cached shells rendered with visible offline state | LOCALLY EXECUTED |
| Reconnect transport | DevTools transport restored after each app | LOCALLY EXECUTED |
| Authenticated/authorized production roles | no deployed Identity environment | EXTERNALLY PENDING |
| Containerized Nginx origin | Docker unavailable; preview evidence is not relabeled as gateway-container evidence | EXTERNALLY PENDING |

## 28. Migration state

| Item | Result | Status |
|---|---|---|
| Clean dry run | 27 pending in a new cluster; transaction rolled back successfully | LOCALLY EXECUTED |
| Apply | `0001` through immutable `0027` applied | LOCALLY EXECUTED |
| Runtime role bootstrap/verify | passed | LOCALLY EXECUTED |
| Complete schema/RLS suite | passed | LOCALLY EXECUTED |
| Final plan | 0 pending | LOCALLY EXECUTED |
| Production ownership | central ledger remains EHR repository infrastructure; APIs must not race at startup | STATICALLY VERIFIED |
| Production executor | use the non-root EHR Docker `migration` target as a controlled one-shot deployment job | STATICALLY VERIFIED |
| Production execution | no production database | EXTERNALLY PENDING |

No `0028` was created.

## 29. Production fail-closed matrix

| Unsafe production condition | Result | Status |
|---|---|---|
| Dispatcher deterministic transport | rejected outside explicit non-production configuration | LOCALLY EXECUTED |
| OCR deterministic/test provider | rejected in production | LOCALLY EXECUTED |
| Local-secret development workload identity | rejected in production where JWT workload identity is required | LOCALLY EXECUTED |
| Missing PostgreSQL TLS/CA | rejected in production | LOCALLY EXECUTED |
| URL TLS downgrade or global TLS verification disable | rejected across all DB runtimes | LOCALLY EXECUTED |
| Mock/local auth production use | rejected by environment policy | LOCALLY EXECUTED |
| Fake NIN provider production use | rejected by provider-mode policy | LOCALLY EXECUTED |
| Missing workload-token file | caller fails closed | LOCALLY EXECUTED |
| Identity/Lab/Pharmacy dependency failure | bounded client/policy tests deny or fail without fabricating success | LOCALLY EXECUTED |
| Database failure | six readiness endpoints fail while liveness remains process-only | LOCALLY EXECUTED |
| Telemetry failure | product continues and telemetry failure remains non-critical | LOCALLY EXECUTED |
| Gateway upstream failure | bounded safe Problem Details response configured | STATICALLY VERIFIED |
| Full production-mode container topology | engine unavailable | EXTERNALLY PENDING |

## 30. AWS dependency matrix

No AWS service was contacted or provisioned; every live AWS row is `EXTERNALLY PENDING`.

| Runtime/surface | Architecture mapping | Status |
|---|---|---|
| Identity, EHR, Lab, Pharmacy, OCR API, Outreach | ECR + ECS/Fargate, private ALB/service discovery, RDS, Secrets Manager/workload identity, CloudWatch | EXTERNALLY PENDING |
| OCR Worker | ECR + ECS/Fargate, RDS, S3 versioning, KMS, Textract, workload identity, CloudWatch | EXTERNALLY PENDING |
| Event Dispatcher | ECR + ECS/Fargate, RDS, EventBridge PutEvents IAM, CloudWatch | EXTERNALLY PENDING |
| Seven static frontends | one versioned static publication suitable for S3/CloudFront or the proven gateway image; preserve path scopes and no-store workers | EXTERNALLY PENDING |
| Gateway/edge | Route 53, ACM, CloudFront, WAF, then API Gateway/ALB routing as the deployment design selects | EXTERNALLY PENDING |
| Platform data/security | RDS PostgreSQL, S3, KMS, Secrets Manager, CloudTrail | EXTERNALLY PENDING |
| Optional integrations | SQS only for consumers that require it; SES only where an implemented workflow requires it | EXTERNALLY PENDING |

The environment had no AWS CLI, region, credential variable, web-identity token, or container credential endpoint.

## 31. Externally pending evidence

| Required evidence | Status |
|---|---|
| Docker engine/info and complete image builds | EXTERNALLY PENDING |
| Image tags, application/base digests, sizes, final layers, SBOM, and OS/image scans | EXTERNALLY PENDING |
| Actual non-root UID/GID, health utilities, signals, and restart policy inside final containers | EXTERNALLY PENDING |
| Complete container network/topology and production-mode gateway upstream failure | EXTERNALLY PENDING |
| Mounted workload JWTs, rotation, issuer/JWKS, and workload identities | EXTERNALLY PENDING |
| Production PostgreSQL LOGINs, RDS TLS/CA/network/failover | EXTERNALLY PENDING |
| Authenticated cross-app session and authorization in a deployed environment | EXTERNALLY PENDING |
| Live Sentry and PostHog destination arrival | EXTERNALLY PENDING |
| Representative physical-device offline lifecycle | EXTERNALLY PENDING |
| ECR, ECS/Fargate, ALB/API Gateway/CloudFront/WAF, RDS, S3/KMS/Textract, EventBridge/IAM, CloudWatch/CloudTrail, and AWS deployment | EXTERNALLY PENDING |

## 32. Recommended next stage

Recommendation basis: all locally executable builds, 311 tests, verification, PostgreSQL/runtime acceptance, and fresh seven-app browser/offline acceptance pass; no high-priority local correctness defect remains: `LOCALLY EXECUTED`.

Proceed to **AWS Deployment Architecture + Infrastructure as Code**, without provisioning from this acceptance task. Make the first deployment pipeline gate a Docker-capable build host that records all image/base digests and sizes, runs SBOM and vulnerability scans, inspects final layers and UIDs, executes the full container topology, and verifies gateway/auth/workload mounts. Resolve or formally exception the bounded Web `xlsx` risk and clean Lab/Outreach audit metadata before production release. Then map the proven runtime boundaries to the AWS services in section 30 and validate production RDS TLS/non-owner LOGINs, workload JWTs, live telemetry, and representative devices.

IMPLEMENTED, EXTERNAL ENVIRONMENT VERIFICATION PENDING
