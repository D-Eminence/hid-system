# HID Event Dispatcher

Independent transport-neutral dispatcher for the five active transactional
outboxes owned by Identity, OCR, Lab, Pharmacy, and Outreach. EHR has no outbox
producer today. The dispatcher does not invent consumers or business effects.

It claims normalized immutable envelopes through lease-bound `integration`
commands, validates the registered `ng.hid.event-envelope` v1 contract and
minimum-necessary payload policy, publishes in batches, and records each
transport result independently. Successful transport acceptance followed by a
database-mark failure deliberately leaves the claim to expire: the same stable
event ID is then redelivered. Delivery is therefore at least once. “Delivered”
means accepted by the configured transport, not processed by a consumer.

`EVENT_DISPATCHER_TRANSPORT=deterministic` is an explicit development/test
adapter and is forbidden in production. Production requires EventBridge,
PostgreSQL TLS with a trusted CA, and workload IAM; static AWS credentials are
rejected. The SDK is configured for one attempt because retry ownership and
terminal evidence live in the dispatcher/database contract. Start from
`.env.example`, inject secrets through the runtime, and never commit env files.

```bash
npm ci
npm run typecheck
npm test
npm run build
npm start
```

The status listener exposes `GET /api/v1/health/live`,
`GET /api/v1/health/ready`, and Prometheus text at `GET /metrics`. Readiness is
false while disabled or draining. Metrics include backlog age, retry and
terminal-failure counts, success/failure counts, and average dispatch latency;
payloads and provider response bodies are never logged or exposed.
The private status listener also exposes bounded, PHI-minimal terminal evidence
at `GET /api/v1/operations/failures?limit=` for the authorized Identity Admin
aggregator. It includes IDs, producer/type, attempts, safe error, timestamps,
and correlation only—never the immutable payload or patient/facility context.

The database login must inherit only `hid_event_dispatcher`. That role can call
the exact delivery/status functions and has no direct table privileges. The non-login
`hid_event_delivery_commands` function owner is never inherited by a runtime
login. Use `iam-policy.example.json` after replacing its exact bus ARN; do not
add wildcard resources or unrelated AWS permissions.

## Container contract

Build from the repository root so the Dockerfile receives the expected locked
package inputs:

```bash
docker build \
  --file services/event-dispatcher/Dockerfile \
  --tag hid-event-dispatcher:<immutable-version> \
  .
```

The runtime stage contains only the dispatcher manifest/lockfile, production
dependencies, and compiled output. It runs as the image's `node` user, binds
the status listener to `0.0.0.0` inside the container, declares `SIGTERM` as
its stop signal, and uses the readiness endpoint for its image health check.
Host-process development retains the loopback-only default from `.env.example`.

Production must inject an explicit database URL, base64-encoded trusted
PostgreSQL CA, EventBridge bus name, and AWS region. TLS query parameters are
forbidden in the production database URL so they cannot override the dedicated
verified-CA settings. Configure the task termination grace period above the
dispatcher drain timeout and bounded database command timeout.

The dispatcher has no HID service-to-service workload JWT and therefore no HID
workload-token file mount. EventBridge authentication uses the normal AWS SDK
credential provider chain; on ECS/Fargate this should be the task role. Do not
bake or inject long-lived static AWS keys. The task role needs only the exact
bus actions documented in `iam-policy.example.json`.

Recommended ECS/Fargate inputs:

* private RDS endpoint and security-group path;
* verified PostgreSQL TLS CA through the secret/configuration delivery system;
* exact EventBridge bus and region;
* exact-bus task role;
* status port `3010` and `/api/v1/health/ready` health check;
* stdout/stderr log collection and `/metrics` scraping;
* stop timeout compatible with the configured bounded drain; and
* no writable or persistent application volume.

Publish only immutable image identities:

```text
locked build -> image scan -> immutable version/digest -> ECR -> task definition
```

Do not use `latest` as the only production identity. The verified and still
external evidence is recorded in
`docs/EVENT_DISPATCHER_DEPLOYMENT_ACCEPTANCE.md`.
