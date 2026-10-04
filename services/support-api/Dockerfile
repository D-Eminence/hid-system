FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY services/support-api/package.json services/support-api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY services/support-api/src ./dist

FROM gcr.io/distroless/nodejs22-debian13@sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=65532:65532 --from=build /app/node_modules ./node_modules
COPY --chown=65532:65532 --from=build /app/dist ./dist
USER 65532:65532
EXPOSE 3011
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3011/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["dist/main.mjs"]
