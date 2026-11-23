FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY packages/api-client ./packages/api-client
COPY services/ehr-api/package.json services/ehr-api/package-lock.json ./services/ehr-api/
# Shared privacy-scrubbed error reporting (@hid/server-telemetry) with its own lockfile.
COPY packages/server-telemetry/package.json packages/server-telemetry/package-lock.json packages/server-telemetry/tsconfig.json /app/packages/server-telemetry/
COPY packages/server-telemetry/src /app/packages/server-telemetry/src
RUN cd /app/packages/server-telemetry && npm ci && npm run build
RUN cd services/ehr-api && npm ci
RUN services/ehr-api/node_modules/.bin/tsc -p packages/api-client/tsconfig.json
COPY services/ehr-api/nest-cli.json services/ehr-api/tsconfig.json services/ehr-api/tsconfig.build.json ./services/ehr-api/
COPY services/ehr-api/src ./services/ehr-api/src
RUN cd services/ehr-api && npm run build

FROM node:22-bookworm-slim AS production-dependencies
ENV NODE_ENV=production
WORKDIR /app
COPY packages/api-client/package.json packages/api-client/tsconfig.json ./packages/api-client/
COPY services/ehr-api/package.json services/ehr-api/package-lock.json ./services/ehr-api/
COPY packages/server-telemetry/package.json packages/server-telemetry/package-lock.json /app/packages/server-telemetry/
RUN cd /app/packages/server-telemetry && npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/packages/server-telemetry/dist /app/packages/server-telemetry/dist
RUN cd services/ehr-api && npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/packages/api-client/dist ./packages/api-client/dist

# Controlled deployment job target. APIs never race the central ledger at
# startup; an orchestrator may run this target once before rolling services.
FROM gcr.io/distroless/nodejs22-debian13@sha256:af2e7dd3017037b3ba73238b818c7273f3b4349c005f8bd1454b78d580fe7e37 AS migration
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=65532:65532 --from=production-dependencies /app/services/ehr-api/node_modules ./services/ehr-api/node_modules
COPY --chown=65532:65532 scripts/local-environment.mjs ./scripts/local-environment.mjs
COPY --chown=65532:65532 services/ehr-api/database ./services/ehr-api/database
COPY --chown=65532:65532 services/ehr-api/scripts ./services/ehr-api/scripts
# ORD-7's governed catalogue load (scripts/load-catalog.mjs, run by the deploy tool's opt-in catalogue phase with
# this image) reads /app/docs/codes: the sign-off (catalog-approvals.json), the Wave 0 codes (hid-lab-codes.json)
# and the signed seed files (hid-medicines.json, hid-lab-tests.json). Only these four, by name: nothing else under
# docs/codes (drafts never ship). The seed files are committed once the clinical lead signs them; until then their
# one-name pattern ("[n]") copies nothing, and the loader refuses a seed it cannot read.
COPY --chown=65532:65532 docs/codes/catalog-approvals.json docs/codes/hid-lab-codes.json docs/codes/hid-medicines.jso[n] docs/codes/hid-lab-tests.jso[n] ./docs/codes/
WORKDIR /app/services/ehr-api
USER 65532:65532
CMD ["scripts/apply-migrations.mjs"]

FROM gcr.io/distroless/nodejs22-debian13@sha256:af2e7dd3017037b3ba73238b818c7273f3b4349c005f8bd1454b78d580fe7e37 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=65532:65532 --from=production-dependencies /app/services/ehr-api/node_modules ./services/ehr-api/node_modules
COPY --chown=65532:65532 --from=production-dependencies /app/packages/server-telemetry /app/packages/server-telemetry
COPY --chown=65532:65532 --from=production-dependencies /app/packages/api-client/package.json ./packages/api-client/package.json
COPY --chown=65532:65532 --from=build /app/packages/api-client/dist ./packages/api-client/dist
COPY --chown=65532:65532 --from=build /app/services/ehr-api/dist ./services/ehr-api/dist
WORKDIR /app/services/ehr-api
USER 65532:65532
EXPOSE 3002
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "const port=process.env.PORT||'3002';fetch('http://127.0.0.1:'+port+'/api/v1/health/ready').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["dist/main.js"]
