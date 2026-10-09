FROM node:22-bookworm-slim AS build
WORKDIR /app/services/notification-worker
COPY services/notification-worker/package.json services/notification-worker/package-lock.json ./
RUN npm ci
COPY services/notification-worker/tsconfig.json services/notification-worker/tsconfig.build.json ./
COPY services/notification-worker/src ./src
RUN npm run build

FROM node:22-bookworm-slim AS production-dependencies
ENV NODE_ENV=production
WORKDIR /app/services/notification-worker
COPY services/notification-worker/package.json services/notification-worker/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM gcr.io/distroless/nodejs22-debian13@sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167 AS runtime
ENV NODE_ENV=production \
    NOTIFICATION_WORKER_STATUS_HOST=0.0.0.0
WORKDIR /app/services/notification-worker
COPY --chown=65532:65532 --from=production-dependencies /app/services/notification-worker/node_modules ./node_modules
COPY --chown=65532:65532 --from=build /app/services/notification-worker/dist ./dist
USER 65532:65532
EXPOSE 3008
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=15s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "const port=process.env.NOTIFICATION_WORKER_STATUS_PORT||'3008';fetch('http://127.0.0.1:'+port+'/api/v1/health/ready').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["dist/main.js"]
