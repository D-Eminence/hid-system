FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY services/notification-api/package.json services/notification-api/package-lock.json ./services/notification-api/
RUN cd services/notification-api && npm ci
COPY services/notification-api/nest-cli.json services/notification-api/tsconfig.json services/notification-api/tsconfig.build.json ./services/notification-api/
COPY services/notification-api/src ./services/notification-api/src
RUN cd services/notification-api && npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/services/notification-api
COPY services/notification-api/package.json services/notification-api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/services/notification-api/dist ./dist
USER node
EXPOSE 3007
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const p=process.env.PORT||'3007';fetch('http://127.0.0.1:'+p+'/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
