# HID Transactional Event Delivery Architecture

## Status and scope

The repository implements the neutral transactional delivery foundation in
`services/event-dispatcher` and additive migration
`0026_transactional_event_delivery.sql`. Local PostgreSQL, service, build, and
topology acceptance pass. Deployment-structure, representative non-owner
LOGIN, verified-TLS, host health/metrics/SIGTERM, and two-instance acceptance
are recorded in `EVENT_DISPATCHER_DEPLOYMENT_ACCEPTANCE.md`. Image build/scan,
container execution, EventBridge/AWS execution, production database LOGIN, and
real consumer integration remain external-environment evidence.

The current convergence adds one implemented consumer path: an allowlisted
subset of ordinary domain events is routed by EventBridge to a KMS-encrypted
SQS queue/DLQ and consumed by Notification Worker through Novu, with FCM as the
server-side push boundary. Authentication OTP is explicitly excluded and uses
Identity -> workload-authenticated Notification API -> SES/Termii/Meta with
bounded Infobip fallback. The generic inbox remains available for future
governed consumers; no other product effect or EHR producer is invented.

## Producer inventory

| Producer | Active outbox | Stable ID | Version | Dispatcher state | Active consumer |
| --- | --- | --- | --- | --- | --- |
| Identity | `identity.outbox_events` | `event_id` UUID | implicit v1 | `integration` | allowlisted ordinary events -> Notification Worker |
| OCR | `ocr.outbox_events` | `id` UUID | `event_version=1` | `integration` | allowlisted ordinary events -> Notification Worker |
| Lab | `lab.outbox_events` | `id` UUID | `event_version=1` | `integration` | allowlisted ordinary events -> Notification Worker |
| Pharmacy | `pharmacy.outbox_events` | `id` UUID | `event_version=1` | `integration` | allowlisted ordinary events -> Notification Worker |
| Outreach | `outreach.outbox_events` | `event_id` UUID | implicit v1 | `integration` | allowlisted ordinary events -> Notification Worker |
| EHR | no outbox producer | n/a | n/a | n/a | none |

All five producers commit their current minimum-necessary event row in the
same transaction as their domain transition. Migration `0026` makes those
source rows immutable and leaves historical `published_at`, attempt, and
next-attempt columns as compatibility metadata. New delivery authority lives
only in `integration.outbox_delivery_state` and
`integration.outbox_delivery_attempts`.

The inventory also found an obsolete Lab foreign key from migration `0017`
that constrained every later Lab event aggregate to imported evidence. The
additive migration replaces it with exact event-type-to-aggregate validation
for imported evidence, work items, accessions, specimens, executions, and
results.

## Normalized envelope v1

`integration.outbox_envelopes` normalizes the two historical column shapes.
The dispatcher validates and emits this stable contract:

```json
{
  "schema": "ng.hid.event-envelope",
  "schemaVersion": 1,
  "id": "stable-event-uuid",
  "type": "PatientRegistered",
  "version": 1,
  "occurredAt": "RFC-3339 timestamp",
  "producer": "identity",
  "aggregate": { "type": "identity-registration-case", "id": "uuid", "version": 2 },
  "correlationId": "opaque-correlation-id",
  "causationId": null,
  "context": { "facilityId": "uuid-or-null", "patientId": "uuid-or-null" },
  "payload": { "source": "governed-nin-registration" }
}
```

The event ID is never regenerated during retry. Event type/version pairs and
producer payload keys are explicitly registered. Payloads are limited to 8 KiB
and recursively checked for raw identifiers, demographics/contact fields, OCR
text, Lab values, and medication text. Unsupported versions, unknown fields,
invalid identifiers, or sensitive payload keys become safe terminal delivery
evidence; payload content is never logged.

## Claim and retry lifecycle

```text
pending/retry_scheduled
        |
        | claim_outbox_events + FOR UPDATE SKIP LOCKED
        v
     claimed -- transport accepted --> delivered
        |
        +-- retryable failure --> retry_scheduled
        |
        +-- terminal/max attempts --> failed_terminal
        |
        +-- lease expires --> claimed again with the same event ID
```

Claims have a dispatcher identity, random claim token, start time, and expiry.
Only the active unexpired token can complete an attempt. `SKIP LOCKED` prevents
two replicas from owning the same eligible event; expired leases are recorded
as attempt evidence and reclaimed. Retry uses bounded exponential equal-jitter
backoff and a configured maximum attempt count. Error codes and summaries are
bounded, provider-safe metadata; raw provider response bodies are not stored.

Delivery is at least once. If EventBridge accepts an event and the process dies
before `record_outbox_delivered`, the claim expires and the same stable event
is published again. The dispatcher deliberately does not record a transport
failure when the post-publish database mark fails. Therefore:

- `delivered` means the transport accepted the event;
- it does not mean a consumer processed the event;
- duplicate transport delivery is expected and must be harmless to consumers;
- ordering across producers is not promised.

## Transport boundary

`EventTransport` is independent of every domain service. The explicit
non-production deterministic adapter returns stable acceptance IDs. The real
adapter uses EventBridge `PutEvents` batches of at most ten, maps each response
entry independently, owns the request timeout, and configures the AWS SDK with
`maxAttempts: 1` so retry evidence is not split across layers. It checks the
exact bus with `DescribeEventBus` before accepting claims.

Production requires EventBridge, workload IAM, HTTPS custom endpoints if any,
and PostgreSQL TLS with a trusted CA. Static AWS keys and deterministic
transport are rejected. The example IAM policy permits only
`events:DescribeEventBus` and `events:PutEvents` on one exact event-bus ARN.

## Durable consumer inbox

`integration.inbox_messages` has primary key `(consumer_name,event_id)` and
stores only contract identity, payload digest, lease/retry state, and safe
failure code—not the event payload. `integration.inbox_consumers` binds each
logical consumer name to an administrator-provisioned database role, so one
consumer cannot claim another consumer's namespace by changing an argument.
No consumer is registered by the migration.

A real consumer must use one database transaction:

```text
BEGIN
  claim_inbox_message(consumer, stable event identity + payload digest)
  if already_processed/busy/retry_scheduled/failed_terminal: do no business work
  apply the consumer-owned business effect
  complete_inbox_message(consumer, event_id, claim_token)
COMMIT
```

The business effect and processed marker must commit or roll back together. A
hard crash rolls back both. A handled error may roll back the effect to a
savepoint and call `fail_inbox_message` before committing retry evidence.
Different consumers process the same event independently; the same consumer
does not apply it twice. Consumer-specific wrapper/grant provisioning and a
real product handler are deferred until a real consumer is approved.

## Security and operations

The runtime login inherits only `hid_event_dispatcher`, which can execute
claim, delivered, failure, and status commands and has no direct table access.
The never-inherited `hid_event_delivery_commands` technical owner can read only
the five RLS-protected outbox tables and mutate only delivery/inbox state. It
cannot mutate a domain outbox. Domain API roles receive no `integration`
privileges.

The status listener uses port 3010 by default and exposes liveness, truthful
readiness, and Prometheus metrics for accepting-dispatch state, backlog counts
and age, retry/terminal counts, success/failure counts, and average dispatch
latency. Its private read-only
`GET /api/v1/operations/failures?limit=<bounded>` endpoint calls the exact
database listing function added by migration `0027` and returns only stable
event identity, producer/type/version, bounded attempt state, timestamps, and
safe failure codes/summaries. It never returns an envelope or payload. Identity
aggregates that surface for the capability-protected Admin API; no browser calls
the dispatcher directly and no arbitrary retry command exists. Logs contain
stable event/correlation IDs, type/version, producer, attempt, and safe codes
only.

## Acceptance and next boundary

Local acceptance proves all migrations through `0026`, corrective/repeatable
runtime grants, forced-RLS role assertions, source immutability, concurrent
claim exclusion, expired-lease reclaim, stale-token rejection, partial
transport success, bounded retry and terminal evidence, the publish/mark crash
window, duplicate inbox delivery, independent consumers, and consumer crash
rollback/retry. Service tests, strict build, root orchestration, Docker/IAM
contract inspection, and platform graph verification pass.

The repository-side deployment contract and representative host/database
acceptance are complete. The remaining delivery stage requires an authorized
external image/AWS environment for the exact container, production LOGIN/RDS
CA, bus/task role, ECS/ECR, and monitoring evidence. The next consumer stage
begins only after a real business consumer and effect are approved; it must bind
a dedicated consumer role and prove the same transaction rule against that
effect.
