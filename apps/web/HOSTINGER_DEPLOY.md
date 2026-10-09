# Hostinger registrar boundary

Hostinger remains the registrar for `healthidentitydirectory.com`; it is not the
canonical application host. Do not upload the Web artifact to `public_html` or
place provider credentials in Hostinger configuration.

The approved target is:

- Cloudflare: authoritative DNS, TLS, edge security, Turnstile, and seven
  independent Worker Static Assets applications;
- AWS: API-only Gateway, services, PostgreSQL, object storage, event delivery,
  notification services, audit, and observability infrastructure.

Registrar nameserver changes, Cloudflare resource creation, and deployment are
external change-controlled actions and are not performed from this repository
stage.
