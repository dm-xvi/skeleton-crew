# Throwaway image for AGE-17: the Agent SDK and its bundled Claude Code binary.
# Install inside the image so npm picks the linux-x64 (glibc) optional binary.
FROM node:24-slim

WORKDIR /app
RUN npm install --no-audit --no-fund \
      @anthropic-ai/claude-agent-sdk@0.3.317 \
      @anthropic-ai/sdk \
      @modelcontextprotocol/sdk \
      zod@4 \
  && chown -R node:node /app

USER node
CMD ["node", "spike.mjs", "env"]
