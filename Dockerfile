# syntax=docker/dockerfile:1

# ---- build: install all dependencies (native SQLite needs a toolchain) and compile the app ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The webpack builder and a capped heap keep peak memory near 1.4 GB so the image builds on default Docker Desktop VMs.
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_BUILD_CPUS=2 NODE_OPTIONS=--max-old-space-size=1280
# The parse worker thread needs a compiled entry point of its own (the image ships only .next and node_modules).
RUN npx next build --webpack && node tools/build-worker.mjs && npm prune --omit=dev

# ---- lean: the Lean 4 toolchain for formal verification, reduced to what proof checking needs ----
# Kept: the lean binary, its shared runtime, the cadical SAT solver (bv_decide) and the compiled library modules
# (.olean with their .private and .server parts, all of which Lean loads). Removed: the C compiler, linker and LLVM,
# static libraries, Lake, sources, editor indexes (.ilean) and interpreter IR (.ir), which only native compilation or
# editors use. tests/formal.test.ts passes against exactly this reduction.
FROM debian:bookworm-slim AS lean
ARG LEAN_TOOLCHAIN=leanprover/lean4:v4.34.0
ENV ELAN_HOME=/opt/elan
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates zstd \
    && curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -o /tmp/elan-init.sh \
    && sh /tmp/elan-init.sh -y --no-modify-path --default-toolchain "$LEAN_TOOLCHAIN" \
    && mv "$(/opt/elan/bin/lean --print-prefix)" /opt/lean \
    && cd /opt/lean \
    && rm -rf src include lib/clang lib/libLLVM* lib/libclang* lib/libc lib/*.a lib/lean/*.a lib/lean/Lake lib/lean/Lake.* \
              bin/clang* bin/ld* bin/llvm-ar bin/leanc bin/leanmake bin/lake bin/leantar \
    && find lib/lean \( -name '*.ilean' -o -name '*.ir' -o -name '*.ir.sig' \) -delete \
    && /opt/lean/bin/lean --version

# ---- runtime: production dependencies only, non-root, with Ruff for Python analysis and Lean 4 for formal verification ----
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3003 \
    ALLOWED_HOSTS=brody \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/data/brody.db
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages ruff \
    && apt-get purge -y python3-pip && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /root/.cache
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/next.config.ts ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/public ./public
COPY --from=lean /opt/lean /opt/lean
ENV LEAN_BIN=/opt/lean/bin/lean
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3003
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3003,path:'/api/status',headers:{host:'brody'}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["npm", "run", "start"]
