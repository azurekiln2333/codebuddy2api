# Gateway runtime image. Build context must contain the compiled gateway and a
# UI dist directory (or UI is mounted at runtime via UI_STATIC_DIR).
#
#   docker build -t codebuddy2api-gateway:local .
#
# The gateway never publishes the private FastAPI port; only Nginx (or the
# compose reverse proxy) exposes the gateway listener.
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
# `npm run build` runs `tsc -p tsconfig.build.json`, and that file `extends`
# ./tsconfig.json. Both must be present or the image build fails.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Only production dependencies and compiled output ship in the runtime layer.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi && npm cache clean --force

COPY --from=build /app/dist ./dist

# Non-root, no shell login. The UI build is mounted/copied read-only at runtime.
RUN useradd --system --uid 10001 --create-home gateway
USER gateway

# Internal listener only; the container port is not published to the host by
# the example compose file. Nginx reaches it over the private network.
ENV HOST=0.0.0.0 \
    PORT=8788
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
