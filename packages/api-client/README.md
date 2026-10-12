# HID API Client Foundation

This package contains transport-only primitives shared by HID browser clients:
base-URL normalization, URL joining, bounded abortable requests, no-store
fetches, and JSON response decoding. Authentication, authorization, domain
DTOs, and response parsing remain owned by each application or service.

The EHR client uses the JSON request primitive. Identity uses the shared raw
fetch timeout and abort primitive while retaining its existing cookie, CSRF,
session, error, and legacy endpoint behavior in Identity-owned modules.

The typed Identity service client (`src/identity.ts`, `IdentityApiClient`)
sends the delegated user context of `IdentityDelegatedContext` separately from
the caller's workload headers. When the calling service sets `requestMethod`,
the method of the request it is serving, the client sends it upper-cased as
`X-HID-Original-Method`, and only when it is 1–16 letters. Identity honours it
only on the patient authorization check and, with the Outreach cookie-read fix
(ADR-045), on the Outreach authorization, and only from an authenticated
workload; see the Extracted Identity boundary in `docs/INTERFACE_CONTRACT.md`.
