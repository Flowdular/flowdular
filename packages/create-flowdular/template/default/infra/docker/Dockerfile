# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

# The image only builds: tests and checks run in CI before a tag is cut. The
# package store is fetched from the lockfile alone, so this layer is reused
# until the lockfile changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm build
RUN mkdir -p module-plans \
	&& if [ ! -f flowdular.modules.lock.json ]; then printf '{"schemaVersion":1,"modules":[]}\n' > flowdular.modules.lock.json; fi \
	&& if [ ! -f flowdular.module-sources.json ]; then printf '{"schemaVersion":1,"sources":[]}\n' > flowdular.module-sources.json; fi
RUN mkdir -p /sdk-manifests && node infra/sdk-module-manifests.mjs . /sdk-manifests

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

RUN groupadd --system --gid 1001 octane \
	&& useradd --system --uid 1001 --gid octane octane \
	&& mkdir -p /data \
	&& chown octane:octane /data

# The server bundle is self-contained: platform/dist/server/entry.js imports
# only node:* built-ins, so no node_modules (and no devDependencies) ship. The
# platform does read the manifests and specs of the modules @flowdular/sdk
# ships, so the last copy puts those files alone where platform/ resolves them.
COPY --from=builder --chown=octane:octane /workspace/platform/dist ./platform/dist
COPY --from=builder --chown=octane:octane /workspace/platform/package.json ./platform/package.json
COPY --chown=octane:octane infra/docker/app-entrypoint.mjs infra/docker/database-urls.mjs ./infra/docker/
COPY --from=builder --chown=octane:octane /workspace/flowdular.json ./flowdular.json
COPY --from=builder --chown=octane:octane /workspace/flowdular.modules.lock.json ./flowdular.modules.lock.json
COPY --from=builder --chown=octane:octane /workspace/flowdular.module-sources.json ./flowdular.module-sources.json
COPY --from=builder --chown=octane:octane /workspace/module-plans ./module-plans
COPY --from=builder --chown=octane:octane /workspace/modules ./modules
COPY --from=builder --chown=octane:octane /sdk-manifests/ ./

USER octane
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "--import", "./infra/docker/app-entrypoint.mjs", "platform/dist/server/entry.js"]
