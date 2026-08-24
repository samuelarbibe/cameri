# syntax=docker/dockerfile:1

# One image, both halves: the API and the dashboard it serves. Splitting them
# would mean running a second container and a reverse proxy to put them back on
# one origin, which is a lot of moving parts for a self-hosted deployment whose
# whole appeal is `docker run`.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# Dependencies first, keyed only on the manifests, so editing source does not
# reinstall the world. Every workspace package's manifest has to be here or the
# lockfile check fails.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/cli/package.json packages/cli/
COPY packages/contract/package.json packages/contract/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/reporter/package.json packages/reporter/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build
# Resolves the workspace links into a real, production-only `node_modules`.
# The server bundle inlines `@camerihq/*` but leaves npm dependencies external,
# so the runtime stage needs them — and only them.
#
# `--legacy` because pnpm 10 otherwise insists on `inject-workspace-packages`,
# which would change how every developer's install is laid out for the sake of
# one command that runs only here.
RUN pnpm deploy --legacy --filter @camerihq/server --prod /out

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Tini, so signals reach node: the server drains its pool on SIGTERM and would
# otherwise be killed outright when the orchestrator stops it.
RUN apk add --no-cache tini

COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /repo/apps/web/dist ./web
COPY --from=build /repo/packages/db/drizzle ./drizzle

ENV WEB_DIST=/app/web
ENV MIGRATIONS_DIR=/app/drizzle
ENV STORAGE_LOCAL_DIR=/data
ENV HOST=0.0.0.0
ENV PORT=3000

# Attachment bytes when running without object storage. Mount something here,
# or traces vanish with the container.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
