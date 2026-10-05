FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY services/notification-api/package.json services/notification-api/package-lock.json ./services/notification-api/
RUN cd services/notification-api && npm ci
COPY services/notification-api/nest-cli.json services/notification-api/tsconfig.json services/notification-api/tsconfig.build.json ./services/notification-api/
COPY services/notification-api/src ./services/notification-api/src
RUN cd services/notification-api && npm run build

FROM node:22-bookworm-slim AS production-dependencies
ENV NODE_ENV=production
WORKDIR /app/services/notification-api
COPY services/notification-api/package.json services/notification-api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM gcr.io/distroless/nodejs22-debian13@sha256:55e7cd155c86d8956af63fec0a9d0790dd6d0ba98c7d38e63c0866557ee7aff8 AS runtime
ENV NODE_ENV=production
WORKDIR /app/services/notification-api
COPY --chown=65532:65532 --from=production-dependencies /app/services/notification-api/node_modules ./node_modules
COPY --chown=65532:65532 --from=build /app/services/notification-api/dist ./dist
USER 65532:65532
EXPOSE 3007
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "const p=process.env.PORT||'3007';fetch('http://127.0.0.1:'+p+'/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["dist/main.js"]
