# HID API Client Foundation

This package contains transport-only primitives shared by HID browser clients:
base-URL normalization, URL joining, bounded abortable requests, no-store
fetches, and JSON response decoding. Authentication, authorization, domain
DTOs, and response parsing remain owned by each application or service.

The EHR client uses the JSON request primitive. Identity uses the shared raw
fetch timeout and abort primitive while retaining its existing cookie, CSRF,
session, error, and legacy endpoint behavior in Identity-owned modules.
