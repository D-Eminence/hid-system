# HID AWS and Cloudflare Cost Model

Status: quantity-based source model. No live account price, contract, traffic,
tax, credit posting, or load-test evidence is inferred. `infra/aws/cost-inventory.json`
is the deterministic IaC inventory and intentionally contains no fabricated
prices.

## Accounting views

HID tracks three distinct values:

1. **gross consumption** is AWS usage before promotional credits and excludes
   credits from the budget cost types;
2. **credit applied** is the portion of an eligible credit balance actually
   posted against eligible charges; and
3. **cash exposure** is the amount expected to be payable after included
   credits, refunds, discounts, tax, support, and other configured cost types.

These are accounting views, not interchangeable budget targets. The AWS
Activate balance used only for planning is **$10,000**. Spreading it evenly
over 24 months gives a reference of **$416.67/month**. That reference is not a
forecast or permission to spend, and the former $1,000 runway assumption is
incorrect.

## Deterministic resource quantities

Regenerate and verify the committed inventory with:

```bash
npm --prefix infra/aws run cost:inventory
npm --prefix infra/aws run cost:inventory:check
```

The inventory records AZs, NAT gateways, interface-endpoint/AZ attachments,
ALBs, estimated public IPv4 quantities, every workload's default/minimum/
normal/emergency task count, RDS shape, retention, repositories, KMS keys,
secret interfaces, WAF, queues, and buckets for development, staging sleep,
staging economy, staging fidelity, and production.

| Profile | AZ | NAT | Interface endpoint/AZ attachments | ALBs | RDS | Default runtime |
|---|---:|---:|---:|---:|---|---|
| staging sleep | 2 | 0 | 0 | 0 | `db.t4g.small`, single-AZ, operator-stopped | all 11 services at 0 |
| staging economy | 2 | 1 | 4 | 2 | `db.t4g.small`, single-AZ, 100 GiB | request services/Gateway 1; workers 0 |
| staging fidelity | 2 | 2 | 16 | 2 | `db.t4g.medium`, Multi-AZ, 100 GiB | request services/Gateway 2; workers 1 |
| production | 3 | 2 | 24 | 2 | `db.r6g.large`, Multi-AZ, 200 GiB | every service 2 |

Sleep is **not zero cost**. It retains the protected RDS instance/storage,
automated backups/PITR, snapshots, versioned S3 objects, KMS keys, secret
interfaces, ECR images, logs, EventBridge/SQS, and DNS metadata. RDS stopping
removes instance compute temporarily; AWS automatically restarts stopped RDS
instances after its bounded stop period. The sleep template installs one exact-
database, staging-only daily re-stop schedule with zero scheduler retries.

## Main variable drivers

```text
monthly gross = Fargate task-hours and scale-out
              + protected RDS/storage/backups
              + S3 versions, requests and KMS operations
              + Textract pages and bounded attempts
              + NAT/endpoints/ALB/WAF/public IPv4
              + EventBridge/SQS and providers
              + logs, metrics, Insights scans and retained evidence
              + ECR storage/scanning and Cloudflare delivery
```

Textract cost is driven by pages and operation. Identical exact-version PDF
requests use a deterministic `ClientRequestToken`; completed extractions are
reused only when object version, digest, provider, operation/features/model
contract all match. A cost threshold never hard-rejects a clinically required
document. Quality and clinical safety take precedence; cost signals trigger
review, queue controls, and bounded retries.

CloudWatch Logs cost includes ingestion, retention, and Logs Insights bytes
scanned. Economy retains runtime logs for about 30 days; production remains
365 days. Queries must be time/log-group bounded and must not emit PHI, OCR
text, NIN, tokens, or high-cardinality identifiers as metrics.

## Capacity and connection safety

Every workload owns typed CPU, memory, scaling signal, target, cooldown, pool
size, normal ceiling, and separately reviewed emergency ceiling. Production
does not scale to zero. Request APIs use ALB request count plus latency, 5xx,
CPU, and memory visibility. Notification Worker uses SQS visible/oldest/deleted
signals; OCR Worker uses queue depth, age, claims, pages, failures, retries, and
duplicate-avoidance signals; Event Dispatcher uses outbox depth, age and drain
rate while preserving at-least-once delivery.

Synth fails when `sum(normalMaxTasks * poolConnectionsPerTask)` exceeds the
profile's normal connection budget or the reviewed emergency sum exceeds its
separate budget. PostgreSQL `max_connections` is not raised to conceal an
unsafe service configuration.

No permanent “million-user” ceiling or claim is encoded. Normal ceilings are
starting guardrails. Raising them requires representative load/soak results,
latency/error/queue evidence, RDS connection and I/O headroom, restore/DR
evidence, a dated cost estimate, and external approval. The next production
network evolution can add a third NAT gateway or egress redesign after measured
AZ-failure and traffic evidence; the current 3-AZ/2-NAT topology is preserved
to avoid an unapproved production cost increase.

## Notification-only billing governance

`HID_COST_GOVERNANCE_ENABLED=true` optionally synthesizes a separate account
stack. It requires `CostNotificationEmail` and accepts an optional existing
`CostNotificationSnsArn`. It creates no Budget Action, IAM action, service
update, or shutdown path.

- Cash exposure: actual 50/80/100%, forecast 80/100%, credits included.
- Gross consumption: actual 50/75/90/100%, forecast 80/100%, credits excluded.
- Cost anomalies: account/service and `Project=HID` tag monitors, daily email,
  configurable absolute threshold starting at `max($10, 2% of monthly gross)`.

AWS Budgets permits five notifications per budget, so gross forecast alerts use
a second identically bounded gross budget view. Alerts inform human decisions;
production is never automatically stopped.

## Non-negotiable controls

Do not optimize away production Multi-AZ, PITR/backups, deletion protection,
encryption, TLS, WAF, private database placement, versioned clinical records,
audit/RLS/workload identity, minimum replicas, provider isolation, immutable
rollback images, or release evidence solely to meet a cost target. Before any
deployment, attach dated calculator exports and provider quotes. Reconcile
gross, credits applied, and cash exposure after the first 30 days and after
every material load or architecture change.
