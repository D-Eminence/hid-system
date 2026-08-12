# Historical Web admin route

The former Web-embedded admin overview is retained only as HID 1.0 reference
code. The canonical governed administration application is `apps/admin`, hosted
independently at `admin.healthidentitydirectory.com` through Cloudflare Worker
Static Assets.

Admin data is supplied by the Identity-owned `/api/v1/admin/*` boundary. The
browser has no database or provider credentials. Platform-admin assignment uses
the governed bootstrap and command paths documented in
`docs/SUPER_ADMIN_FOUNDATION.md`; never update an account role directly in a
production database.

Sentry and PostHog remain optional, fail-open telemetry integrations with replay,
autocapture, and sensitive data collection disabled. Their server credentials
must not be added to frontend configuration.
