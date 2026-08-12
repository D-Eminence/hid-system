# HID Migrate Phase 4 change summary

Status: implemented locally; infrastructure deployment and device testing pending

Phase 4 adds private `migration-source-files` storage plus tenant-scoped scan
sessions, source folders, documents, pages and immutable original-asset metadata.
The capture API derives all storage paths from authenticated project scope, accepts
only JPEG, PNG, WebP and PDF files up to 50 MB, requires SHA-256 metadata, verifies
object presence and leaves every upload quarantined for security processing.

The scanning screen now uses real camera/file input, creates recoverable client scan
sessions, uploads pages individually, exposes failure/retry states and prevents
folder submission while uploads remain incomplete. Source files are never
automatically deleted or promoted to clinical records.

`npm run build` and `git diff --check` pass. retired hosted identity backend migration execution, storage
isolation tests, physical device testing, true cross-restart blob persistence and
the malware scanner integration remain required before production. Phase 5 owns
quarantine release, image processing and OCR jobs.
