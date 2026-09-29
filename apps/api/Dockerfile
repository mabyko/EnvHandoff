FROM node:24.21.0-bookworm-slim AS base
RUN npm install --global pnpm@12.3.4
WORKDIR /app

FROM base AS dependencies
ENV CI=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
RUN pnpm install --filter @envhandoff/api... --prod --frozen-lockfile --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production PORT=3000
COPY --from=dependencies /app/ /app/
COPY apps/api/src ./apps/api/src
COPY apps/api/sql ./apps/api/sql
COPY packages/protocol/src ./packages/protocol/src
# Preserve the workspace symlink: protocol TS resolves outside node_modules, where Node can strip types.
RUN mkdir -p /var/lib/envhandoff/objects /var/lib/envhandoff/deletions \
    && chown 1000:1000 /var/lib/envhandoff/objects /var/lib/envhandoff/deletions \
    && chmod 700 /var/lib/envhandoff/objects /var/lib/envhandoff/deletions
USER 1000:1000
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "src/server.ts"]
