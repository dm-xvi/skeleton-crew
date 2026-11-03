# The build context is the repo root, so roles/ is baked in next to the bridge.
# .dockerignore lets in only bridge sources and roles/; never data/ or credentials/.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY bridge/package.json bridge/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY bridge/tsconfig.json ./
COPY bridge/src ./src
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY bridge/package.json bridge/package-lock.json ./
# Keep optional dependencies: the Agent SDK ships its Claude Code binary as one.
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY roles ./roles
# A new named volume copies these owners, so the non-root user can write to it.
RUN mkdir -p /data /work && chown node:node /data /work

USER node
EXPOSE 3000
# tini is PID 1 so stop signals reach Node.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
