# Laboratory boundary

The first Lab-owned slice accepts and reads imported external laboratory
evidence through `/api/v1/lab/imports`. It owns immutable imported observations,
exact source/provenance references, semantic audit, idempotency, and a
minimum-necessary transactional outbox in the `lab` schema.

Imported evidence is not native HID Lab execution. It does not claim an HID
accession, specimen custody, instrument execution, QC, or Lab-staff
verification. Those operational workflows remain future Lab-owned work.

It must not issue patient identities, write EHR encounters, or persist a second
patient profile. Patient references will be canonical Identity `patient_id`
UUIDs and accepted work will originate from authorized EHR lab requests.

Migration `0019` adds Lab-owned accessions, specimen requirements, physical
specimens, and explicit collection/receipt/rejection commands. Lab-only
sequences generate identifiers with no patient-derived data. Optimistic specimen
versions and append-only events preserve custody history. Receipt is not
analysis, QC, verification, or a result.

Migration `0018` adds that acceptance boundary. An authorized active EHR
request is accepted idempotently as an immutable Lab work item bound to its
canonical patient, same facility, request ID, and exact row version. Database
validation preserves the exact requested-test snapshot and provenance. Lab
owns the acceptance event, semantic audit, and `LabWorkItemCreated` outbox
record; EHR calls the typed Lab service and does not write Lab tables. The
`accepted` state implies no accession, specimen collection, execution, QC, or
result.

Migration `0020` permits execution only from a received specimen and its exact
requested-test snapshot. Manual numeric/text results are immutable revisions
labeled `unverified`; correction appends history. Entry does not imply
verification or release, and no analyzer, instrument, reagent, calibration, or
QC evidence is fabricated.
# Result verification and release

Manual result entry creates an immutable, unverified revision. Verification is an independent exact-version action (the entry actor cannot verify their own revision); release is a separate authenticated manual approval of that verified version. Neither action represents analyzer integration, calibration, QC, a cryptographic signature, or critical-result acknowledgement.

Corrections and amendments append a new unverified revision. A previously released revision remains immutable history, while the new head must be verified and released independently. Non-Lab EHR readers use the released-result history permission and do not receive an unreleased-only result.
