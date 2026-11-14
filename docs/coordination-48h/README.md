# Coordination notes for the 48-hour push (not product code)

**Read `ADDENDUM-2026-11-03.md` first. It has the owner's go-ahead, migration numbers, reporting, the 24-hour wording and permission names, and it wins over the briefs.**

Shared notes for the parallel Claude Code sessions, owner-approved, 3 November 2026. They are not part of the website build and should never be merged.

- `owner-decisions.md`: the owner's decisions log. Each decision is final unless the owner changes it.
- `session-briefs-48h.md`: the brief for each session, A to E.
- `ehr-audit-plan.md`, `migrate-audit-plan.md`, `migrate-design-plan.md`: the counted audits and the approved Migrate flow.
- `clinical-parity.md`: the 252-row EHR parity list, as of 1 November.
- `ocr-fhir-design.md`, `ocr-fhir-decisions.md`, `ocr-records-processing-brief.md`, `migrate-plan-additions.md`: OCR design history. Where they differ from `owner-decisions.md`, the decisions log wins: the AI step is on the Claude API, not Bedrock, and working data is kept 24 hours, not 90 days.
- `ocr_extract_bedrock_draft.py`: an earlier Bedrock-based script. It has 19 open review findings; port it to the Claude API.
