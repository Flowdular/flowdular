# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

# Delivery tests create real repositories; the slim Node image omits git.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git \
	&& rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm verify && pnpm build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

RUN groupadd --system --gid 1001 octane \
	&& useradd --system --uid 1001 --gid octane octane \
	&& mkdir -p /data \
	&& chown octane:octane /data

# The server bundle is self-contained: platform/dist/server/entry.js imports
# only node:* built-ins, so no node_modules (and no devDependencies) ship.
COPY --from=builder --chown=octane:octane /workspace/platform/dist ./platform/dist
COPY --from=builder --chown=octane:octane /workspace/platform/package.json ./platform/package.json

USER octane
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "platform/dist/server/entry.js"]
