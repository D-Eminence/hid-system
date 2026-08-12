# HID Cloudflare frontend edge

The seven directories under `workers/` are independent Cloudflare Workers
Static Assets deployments. Each builds one canonical application at `/`, has
one exact custom domain, and invokes the shared Worker before assets so the
fixed `/api/v1/*` AWS proxy and response security policy cannot be bypassed.

Each application requires an explicit Wrangler named environment. `production`
uses the approved production hostname and the fixed
`https://api.healthidentitydirectory.com` origin; `staging` uses the paired
staging hostname and the fixed `https://api.staging.healthidentitydirectory.com`
origin. The Worker rejects any mismatched application, host, environment, or
origin combination, so browser input, Host headers, and query strings cannot
select an upstream. The production apex redirect is explicit and has no staging
counterpart because `staging.healthidentitydirectory.com` is the staging Web
application.

`ORIGIN_AUTH_TOKEN` is one secret binding in each named environment, but its
staging and production values must be generated and stored independently. It
must be installed with `wrangler secret put ORIGIN_AUTH_TOKEN --env <environment>`;
it must never be placed in `vars`, a frontend build, a command log, or this
repository. The Worker fails closed if the binding is absent or malformed.
Deployment also requires the account/zone identifiers through the authorized
environment.

Build a root-hosted artifact with the corresponding `build:cloudflare:*` root
script, verify with `npm --prefix infra/cloudflare test` and
`npm --prefix infra/cloudflare run verify`, then run
`npm --prefix infra/cloudflare run dry-run:production` and
`npm --prefix infra/cloudflare run dry-run:staging`. The dry-run scripts invoke
Wrangler's build-only deployment check and do not publish a Worker or mutate
DNS. Deploy only from the future authorized pipeline. Hostinger remains
registrar; Cloudflare becomes authoritative DNS/TLS only after the separately
approved nameserver cutover.

The apex redirect is a separate originless Worker because it serves no
application artifact. Its fixed 308 retains the path and query and never reads
a redirect target from request input.
