FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY packages/api-client/package.json packages/api-client/tsconfig.json ./packages/api-client/
COPY services/lab-api/package.json services/lab-api/package-lock.json ./services/lab-api/
RUN cd services/lab-api && npm ci
COPY packages/api-client/src ./packages/api-client/src
RUN services/lab-api/node_modules/.bin/tsc -p packages/api-client/tsconfig.json
COPY services/lab-api/nest-cli.json services/lab-api/tsconfig.json services/lab-api/tsconfig.build.json ./services/lab-api/
COPY services/lab-api/src ./services/lab-api/src
RUN cd services/lab-api && npm run build

FROM node:22-bookworm-slim AS production-dependencies
ENV NODE_ENV=production
WORKDIR /app
COPY packages/api-client/package.json ./packages/api-client/
COPY services/lab-api/package.json services/lab-api/package-lock.json ./services/lab-api/
RUN cd services/lab-api && npm ci --omit=dev && npm cache clean --force

FROM gcr.io/distroless/nodejs22-debian13@sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=65532:65532 --from=production-dependencies /app/services/lab-api/node_modules ./services/lab-api/node_modules
COPY --chown=65532:65532 --from=production-dependencies /app/packages/api-client/package.json ./packages/api-client/package.json
COPY --chown=65532:65532 --from=build /app/packages/api-client/dist ./packages/api-client/dist
COPY --chown=65532:65532 --from=build /app/services/lab-api/dist ./services/lab-api/dist
WORKDIR /app/services/lab-api
USER 65532:65532
EXPOSE 3003
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "const port=process.env.PORT||'3003';fetch('http://127.0.0.1:'+port+'/api/v1/health/ready').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["dist/main.js"]
