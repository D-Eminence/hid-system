# HID Migrate Phase 6 change summary

Phase 6 adds append-versioned document classifications and schema-bound
extractions. Classification retains the selected controlled category, ranked
candidates, confidence, provider/model, prompt version and schema version.
Extraction fields must retain value, field confidence and one or more OCR source
spans.

Durable `classify` and `extract` jobs now follow OCR without writing canonical
clinical data. The provider-neutral intelligence adapter validates source lineage.
The validation route currently presents a read-only document intelligence view with
schema, model, field confidence and source page/span evidence; Phase 7 adds human
leases and decisions.

`npm run build` and `git diff --check` pass. Model/provider selection, representative
accuracy evaluation, prompt-injection testing and clinical schema governance remain
deployment gates.
