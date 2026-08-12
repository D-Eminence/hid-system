# HID Cloudflare frontend edge

The seven directories under `workers/` are independent Cloudflare Workers
Static Assets deployments. Each builds one canonical application at `/`, has
one exact custom domain, and invokes the shared Worker before assets so the
fixed `/api/v1/*` AWS proxy and response security policy cannot be bypassed.

`API_ORIGIN` is deliberately fixed to `https://api.healthidentitydirectory.com`.
`ORIGIN_AUTH_TOKEN`, when the AWS origin-authentication design is activated,
must be installed with `wrangler secret put`; it must never be placed in
`vars`, a frontend build, a command log, or this repository. Deployment also
requires the account/zone identifiers through the authorized environment.

Build a root-hosted artifact with the corresponding `build:cloudflare:*` root
script, verify with `npm --prefix infra/cloudflare test` and
`npm --prefix infra/cloudflare run verify`, then deploy only from the future
authorized pipeline. This repository stage performs no Wrangler deploy and no
DNS mutation. Hostinger remains registrar; Cloudflare becomes authoritative
DNS/TLS only after the separately approved nameserver cutover.

The apex redirect is a separate originless Worker because it serves no
application artifact. Its fixed 308 retains the path and query and never reads
a redirect target from request input.
