FROM node:22-bookworm-slim AS build
WORKDIR /app/services/ocr-worker
COPY services/ocr-worker/package.json services/ocr-worker/package-lock.json ./
RUN npm ci
COPY services/ocr-worker/tsconfig.json services/ocr-worker/tsconfig.build.json ./
COPY services/ocr-worker/src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/services/ocr-worker
COPY services/ocr-worker/package.json services/ocr-worker/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/services/ocr-worker/dist ./dist
USER node
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
