FROM node:22-bookworm-slim AS build
WORKDIR /app/services/event-dispatcher
COPY services/event-dispatcher/package.json services/event-dispatcher/package-lock.json ./
# Shared privacy-scrubbed error reporting (@hid/server-telemetry) with its own lockfile.
COPY packages/server-telemetry/package.json packages/server-telemetry/package-lock.json packages/server-telemetry/tsconfig.json /app/packages/server-telemetry/
COPY packages/server-telemetry/src /app/packages/server-telemetry/src
RUN cd /app/packages/server-telemetry && npm ci && npm run build
RUN npm ci
COPY services/event-dispatcher/tsconfig.json services/event-dispatcher/tsconfig.build.json ./
COPY services/event-dispatcher/src ./src
RUN npm run build

FROM node:22-bookworm-slim AS production-dependencies
ENV NODE_ENV=production
WORKDIR /app/services/event-dispatcher
COPY services/event-dispatcher/package.json services/event-dispatcher/package-lock.json ./
COPY packages/server-telemetry/package.json packages/server-telemetry/package-lock.json /app/packages/server-telemetry/
RUN cd /app/packages/server-telemetry && npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/packages/server-telemetry/dist /app/packages/server-telemetry/dist
RUN npm ci --omit=dev && npm cache clean --force

FROM gcr.io/distroless/nodejs22-debian13@sha256:74224b87e0ca49c53adcc9b475d13f4080a10eea5ab2fdd4684e5094accd4041 AS runtime
ENV NODE_ENV=production \
    EVENT_DISPATCHER_STATUS_HOST=0.0.0.0
WORKDIR /app/services/event-dispatcher
COPY --chown=65532:65532 --from=production-dependencies /app/services/event-dispatcher/node_modules ./node_modules
COPY --chown=65532:65532 --from=production-dependencies /app/packages/server-telemetry /app/packages/server-telemetry
COPY --chown=65532:65532 --from=build /app/services/event-dispatcher/dist ./dist
USER 65532:65532
EXPOSE 3010
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=15s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "const port=process.env.EVENT_DISPATCHER_STATUS_PORT||'3010';fetch('http://127.0.0.1:'+port+'/api/v1/health/ready').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["dist/main.js"]
