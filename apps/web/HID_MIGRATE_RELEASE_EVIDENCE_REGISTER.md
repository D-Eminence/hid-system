# HID Migrate release evidence register

All entries are `pending` until backed by a dated artifact and named approver.

| Gate | Status | Required evidence | Owner |
|---|---|---|---|
| Clean migration apply | pending | Fresh staging database log | Platform |
| RLS and IDOR suite | pending | Role/tenant test report | Security |
| Storage isolation | pending | Upload/download/expiry/malware report | Security |
| Pipeline accuracy | pending | Category/field/handwriting metrics | Clinical data |
| Matching safety | pending | False-positive/negative corpus results | Identity governance |
| Import atomicity | pending | Concurrency, retry, reconciliation report | Platform |
| Performance/SLO | pending | Pilot-scale load and saturation results | Operations |
| Accessibility/devices | pending | Desktop/tablet/mobile matrix | Product |
| Penetration test | pending | Zero unresolved critical/high findings | Security |
| Backup/restore | pending | Timestamped DB/storage restore drill | Operations |
| Privacy/vendor | pending | DPIA, DPA/BAA, region/retention/no-training | Privacy/legal |
| Hospital UAT | pending | Signed workflow acceptance | Pilot hospital |
| Clinical governance | pending | Category/schema/threshold approval | Clinical |
| Production go-live | pending | Signed go/no-go record | Release owner |
