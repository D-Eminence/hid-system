# HID Migrate Phase 5 change summary

Phase 5 adds durable `security_scan`, `image_process` and `ocr` jobs with atomic
`SKIP LOCKED` leases, heartbeats, lease expiry recovery, bounded attempts,
exponential retry scheduling and dead-letter state. Security scanning controls
quarantine release; rejected assets never advance.

Page quality results retain algorithm version, blur/blank/crop/resolution measures,
duplicate references and rescan reasons. OCR results are append-versioned and retain
provider/model/request provenance, normalized text, blocks, tables, confidence,
latency and cost. The worker interface is authenticated separately, while the OCR
adapter contract remains vendor-neutral.

The Processing screen now lists uploaded folders and live jobs, queues eligible
assets, exposes errors and permits capability-checked retries. `npm run build` and
`git diff --check` pass.

Deployment still requires a selected malware/image/OCR worker implementation,
provider credentials and regional data terms. No test adapter is permitted to
process production data.
