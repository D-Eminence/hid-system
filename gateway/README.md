# HID API gateway

This image is the regional API routing boundary behind the AWS public ALB and
WAF. It contains no frontend artifacts. Web, EHR, Lab, Pharmacy, OCR, Outreach,
and Admin are built and released independently through Cloudflare Workers
Static Assets.

Build from the repository root:

```bash
docker build -f gateway/Dockerfile -t hid/gateway:local .
```

The image renders `nginx.conf.template` with envsubst at start-up. Every
variable it uses has a local default in the Dockerfile, and the CDK sets each
one in AWS:

| Variable | Local default | AWS (CDK) | Meaning |
|---|---|---|---|
| `IDENTITY_API_UPSTREAM` and five other `*_API_UPSTREAM` | `http://<service>:<port>` | Cloud Map names | Owner of each `/api/v1/*` prefix |
| `GATEWAY_DNS_RESOLVER` | `127.0.0.11` (Docker DNS) | VPC CIDR base plus two | Resolver for the upstream names |
| `VPC_CIDR` | `127.0.0.1/32` | the VPC CIDR | Only peer range whose `X-Real-IP` is trusted |
| `HID_REQUIRE_CLIENT_IP` | `false` | `true` (staging, production) | Refuse API requests without a client address |
| `HID_ENABLED_API_ROUTES` | `identity,ehr` | `identity,ehr` unless staging opts in | Modules whose routes are proxied |

Behaviour:

- Each location proxies to a variable (`$hid_upstream`), so nginx resolves the
  upstream name per request (answers cached for 10 s) instead of once at
  start-up. The gateway starts when a module's name does not resolve, follows
  task replacements without a restart, and answers `503 UPSTREAM_UNAVAILABLE`
  for a module with no task (a name that does not resolve). The upstream values carry no URI part, so the
  client's request URI reaches the backend unchanged.
- The realip module takes the client address from `X-Real-IP`, which the
  Cloudflare Worker sets from `CF-Connecting-IP`, only on connections from
  `VPC_CIDR`. The gateway sends that address as `X-Forwarded-For` and drops
  the raw header. When `HID_REQUIRE_CLIENT_IP` is anything but `false`, a
  proxied API request without a usable client address answers
  `403 CLIENT_ADDRESS_REQUIRED`. Workers built before this change delete a
  caller's `X-Real-IP`, so behind such a Worker requests are refused, never
  trusted with an address the caller chose.
- A proxied request whose target holds a backslash before the query, or a `#`
  anywhere, answers `400 INVALID_REQUEST_TARGET` before the client-address
  check. Express parses a target holding `#` with `url.parse`, which turns
  those backslashes into slashes, so it could route to a path the location's
  deny expression did not match; a browser never sends either character
  through the Worker. A backslash in the query is proxied.
- A module not named in `HID_ENABLED_API_ROUTES` answers
  `404 API_ROUTE_NOT_FOUND` before proxying. Identity owns `/api/v1/auth`,
  `/identity`, `/audit`, `/admin` and `/commercial`; `ehr`, `lab`,
  `pharmacy`, `ocr` and `outreach` own their prefixes.
- Service-to-service routes answer `404 API_ROUTE_NOT_FOUND` in any letter
  case, with a trailing slash, dot segments, repeated slashes or
  percent-encodings (nginx matches its decoded, normalized URI):
  `/api/v1/auth/service-session`,
  `/api/v1/identity/service/*`, `/api/v1/identity/outreach/*`,
  `/api/v1/ehr/internal/*`, `/api/v1/ehr/documents/scan-events` (the document
  scanner's callback; ADR-055), `/api/v1/lab/work-items/accept-ehr-order`,
  `/api/v1/lab/imports/from-ocr`,
  `/api/v1/pharmacy/work-items/accept-ehr-prescription` and
  `/api/v1/pharmacy/imports/from-ocr`. Callers use the private service names.
- An upstream's own answer reaches the client unchanged, 5xx included: its
  status, Problem Details `code`, `Set-Cookie`, `Retry-After` and
  `X-Correlation-ID` (`proxy_intercept_errors` stays off). Only when nginx
  itself gets no answer (the upstream refuses or resets the connection, times
  out, does not resolve or closes without responding) does it answer
  `503 UPSTREAM_UNAVAILABLE` with `Cache-Control: no-store` (ADR-055, A8).
- Request bodies are bounded at 512 KiB (`client_max_body_size 512k`, the
  ehr-api JSON limit; identity-api refuses more than 256 KiB itself). A larger
  body answers `413 PAYLOAD_TOO_LARGE` Problem Details before any backend sees
  it. The WAF's 8 KB body rule no longer applies to the encounter-scoped
  clinical writes, so this is the edge bound for them (ADR-055, WAF-CRS-BODY).
- The access log is one JSON object per request (format `hid_api`): time,
  client address, method, path (`$uri`, never the query string), status,
  bytes, request and upstream timings, upstream status, nginx's `request_id`
  and the `X-Correlation-ID`. It replaces the image's `main` format, which
  logged the whole request line, so administrator search terms in query
  strings never reach CloudWatch. It is written to the image's
  `/var/log/nginx/access.log`, which the image links to stdout. Health checks
  are not logged. Never add `$request`, `$request_uri`, `$args`,
  `$query_string`, `$http_referer`, cookies or credentials to it (ADR-055, D7).
- The Worker's origin secret (`X-HID-Origin-Authorization`), which only the
  WAF checks, is not forwarded to any backend.

Notification API, Notification Worker, Event Dispatcher, and OCR Worker are
intentionally not browser-routed. The gateway overwrites forwarding headers at
its trust boundary, preserves Cookie, Origin, CSRF, and correlation evidence,
and returns bounded Problem Details for unavailable or unknown routes. Every
non-API path returns `API_ONLY_ORIGIN` with `Cache-Control: no-store`.

`scripts/tests/gateway-config.test.mjs` and `scripts/verify-container-platform.mjs`
check this configuration against a model of nginx
(`scripts/lib/nginx-config-model.mjs`); they do not run nginx.
`scripts/verify-gateway-runtime.mjs` runs the shipped configuration under a
real nginx binary against stub upstreams on 127.0.0.1 and checks upstream
error pass-through, the unreachable-upstream answer, the scanner-callback
denial, the body bound, the origin-secret strip and the access-log format:

```bash
HID_NGINX_BINARY=/path/to/nginx-1.29 npm run verify:gateway-runtime
```

It exits 2 without a binary and verifies nothing then. It is not part of
`npm run verify`, which needs no nginx. The rendered configuration has been
run this way with nginx 1.29.8 (release checklist §8). The image itself
running in ECS is staging acceptance evidence.

The image accepts no frontend configuration, workload tokens, database
credentials, provider secrets, or AWS credentials as build inputs.
