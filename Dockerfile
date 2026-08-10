# Blackbox API and detection loop.
#
# Built in two stages so the shipped image carries compiled JavaScript and the
# dependencies needed to run it, not the toolchain that produced it.
#
# Note that drizzle-kit is deliberately kept in the runtime image: the schema
# has to be applied to a fresh database before the first query, and a deploy
# that boots against tables which do not exist fails on its first tick rather
# than at startup — the worst possible time to find out. `compose.deploy.yml`
# runs the migration as its own service before the API is allowed to start.

FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable

# Manifests first, so a change to source does not invalidate the dependency
# layer. The lockfile is copied with them or the install is not reproducible.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api/package.json          packages/api/
COPY packages/core/package.json         packages/core/
COPY packages/store/package.json        packages/store/
COPY packages/detector/package.json     packages/detector/
COPY packages/recorder/package.json     packages/recorder/
COPY packages/remediator/package.json   packages/remediator/
COPY packages/diagnostician/package.json packages/diagnostician/
COPY packages/chaos/package.json        packages/chaos/
COPY packages/mcp/package.json          packages/mcp/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages ./packages
RUN pnpm -r build

FROM node:24-slim AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./

# Never root. Nothing here needs it, and the container faces the public
# internet.
RUN useradd --system --uid 10001 blackbox && chown -R blackbox:blackbox /app
USER blackbox

# Cloud-agnostic: the platform supplies PORT, and binding 0.0.0.0 is what makes
# the container reachable from outside itself.
ENV PORT=4000
EXPOSE 4000

CMD ["node", "packages/api/dist/server.js"]
