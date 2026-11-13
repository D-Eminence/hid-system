FROM node:22-bookworm-slim AS build
WORKDIR /app
# Shared privacy-scrubbed error reporting (@hid/server-telemetry) with its own lockfile.
# It is compiled with its development dependencies, then reinstalled production-only.
COPY packages/server-telemetry/package.json packages/server-telemetry/package-lock.json packages/server-telemetry/tsconfig.json ./packages/server-telemetry/
COPY packages/server-telemetry/src ./packages/server-telemetry/src
RUN cd packages/server-telemetry && npm ci && npm run build \
  && rm -rf node_modules && npm ci --omit=dev && npm cache clean --force
COPY services/support-api/package.json services/support-api/package-lock.json ./services/support-api/
RUN cd services/support-api && npm ci --omit=dev && npm cache clean --force
COPY services/support-api/src ./services/support-api/dist

FROM gcr.io/distroless/nodejs22-debian13@sha256:74224b87e0ca49c53adcc9b475d13f4080a10eea5ab2fdd4684e5094accd4041 AS runtime
ENV NODE_ENV=production
WORKDIR /app/services/support-api
COPY --chown=65532:65532 --from=build /app/packages/server-telemetry/package.json /app/packages/server-telemetry/package.json
COPY --chown=65532:65532 --from=build /app/packages/server-telemetry/node_modules /app/packages/server-telemetry/node_modules
COPY --chown=65532:65532 --from=build /app/packages/server-telemetry/dist /app/packages/server-telemetry/dist
COPY --chown=65532:65532 --from=build /app/services/support-api/node_modules ./node_modules
COPY --chown=65532:65532 --from=build /app/services/support-api/dist ./dist
USER 65532:65532
EXPOSE 3011
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3011/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["dist/main.mjs"]
