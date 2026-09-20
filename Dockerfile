ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY next.config.ts tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN node --import tsx scripts/deployment-build.ts

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 DATA_DIR=/data/private \
    TSX_DISABLE_CACHE=1 DEPLOYMENT_BIND_HOST=0.0.0.0 TMPDIR=/tmp
# tsx is intentionally retained: the worker and supervisor execute the same source
# and lockfile used by the Next build, not a separately installed worker artifact.
COPY --from=build /app/package.json /app/package-lock.json /app/.npmrc /app/next.config.ts /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/src ./src
COPY --from=build /app/public ./public
COPY --from=build /app/scripts ./scripts
USER 1000:1000
EXPOSE 4321
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "--import", "tsx", "scripts/deployment-health.ts", "readiness"]
CMD ["node", "--import", "tsx", "scripts/deployment-start.ts"]
