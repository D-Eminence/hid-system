-- The reasons a receiving laboratory or pharmacy may give for "We can't
-- complete this order" (D18-5, migration 0091), by kind: the one list that
-- order-routes-cannot-complete.integration.sql reads (through \ir) and the
-- Lab and Pharmacy DTO tests read (the JSON between the quotes). 0091's
-- command and its endings table's CHECK hold the same lists.
\set cannot_complete_reasons '{"lab_request": ["test_not_offered", "supplies_unavailable", "equipment_unavailable", "sample_unusable", "sample_not_obtained", "cannot_meet_priority", "patient_declined", "patient_did_not_return", "other"], "prescription": ["out_of_stock", "medicine_unavailable", "needs_prescriber_review", "controlled_requirements", "cannot_meet_priority", "patient_declined", "patient_did_not_return", "other"]}'
