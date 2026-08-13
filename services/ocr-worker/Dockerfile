FROM node:22-bookworm-slim AS build
WORKDIR /app/services/ocr-worker
COPY services/ocr-worker/package.json services/ocr-worker/package-lock.json ./
RUN npm ci
COPY services/ocr-worker/tsconfig.json services/ocr-worker/tsconfig.build.json ./
COPY services/ocr-worker/src ./src
RUN npm run build

FROM node:22-bookworm-slim AS production-dependencies
ENV NODE_ENV=production
WORKDIR /app/services/ocr-worker
COPY services/ocr-worker/package.json services/ocr-worker/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM gcr.io/distroless/nodejs22-debian13@sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167 AS runtime
ENV NODE_ENV=production
WORKDIR /app/services/ocr-worker
COPY --chown=65532:65532 --from=production-dependencies /app/services/ocr-worker/node_modules ./node_modules
COPY --chown=65532:65532 --from=build /app/services/ocr-worker/dist ./dist
USER 65532:65532
STOPSIGNAL SIGTERM
CMD ["dist/main.js"]
