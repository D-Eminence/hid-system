FROM node:22-bookworm-slim AS build
WORKDIR /app/services/event-dispatcher
COPY services/event-dispatcher/package.json services/event-dispatcher/package-lock.json ./
RUN npm ci
COPY services/event-dispatcher/tsconfig.json services/event-dispatcher/tsconfig.build.json ./
COPY services/event-dispatcher/src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    EVENT_DISPATCHER_STATUS_HOST=0.0.0.0
WORKDIR /app/services/event-dispatcher
COPY services/event-dispatcher/package.json services/event-dispatcher/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/services/event-dispatcher/dist ./dist
EXPOSE 3010
USER node
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=15s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const port=process.env.EVENT_DISPATCHER_STATUS_PORT||'3010';fetch('http://127.0.0.1:'+port+'/api/v1/health/ready').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
