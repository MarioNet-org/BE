FROM node:22-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json yarn.lock ./
RUN  yarn install --frozen-lockfile
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
RUN yarn run db:generate && yarn run build

FROM base AS runtime
# Retain Prisma CLI for migrations at startup (it is currently a devDependency).
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=node:node /app/package.json /app/yarn.lock ./
RUN mkdir -p /app/.local/mail && chown -R node:node /app/.local
USER node
ENV HOST=0.0.0.0 PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:4000/health', { signal: AbortSignal.timeout(3000) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && exec node dist/index.js"]
