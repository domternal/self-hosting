# Built locally by docker-compose.yml; this repository never pushes an image.
# The exact tag makes the runtime version visible and the digest makes the
# bytes immutable. Dependabot may refresh the digest without silently moving
# this deployment to a new Node major.
FROM node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS dependencies
WORKDIR /app

# better-sqlite3 is deliberately compiled against this image instead of
# trusting a separately distributed prebuilt binary. The compiler, make and
# Python remain behind in this discarded stage.
RUN apk add --no-cache g++ make python3
ENV npm_config_build_from_source=true \
    NPM_CONFIG_USERCONFIG=/dev/null \
    NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ \
    NPM_CONFIG_REPLACE_REGISTRY_HOST=never

# npm ci refuses manifest/lock drift and never rewrites the committed lock.
# The cache mount speeds rebuilds without copying npm's cache into the image.
# The package glob copies the manifest and its mandatory lock together;
# default-deny .dockerignore admits no other match.
COPY package*.json LICENSE ./
COPY scripts/check-artifacts.mjs scripts/check-lockfile.mjs scripts/runtime-dependencies.mjs scripts/sqlite-maintenance.mjs ./scripts/
RUN node scripts/check-lockfile.mjs /app
# Fetch the frozen tree without executing arbitrary dependency lifecycle
# scripts, then run only the reviewed native build that this service needs.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts --strict-peer-deps --no-audit --no-fund && \
    npm rebuild better-sqlite3 --omit=dev --build-from-source --no-audit --no-fund
COPY index.mjs ./
COPY src ./src
RUN npm ls --omit=dev --all && node scripts/check-artifacts.mjs /app

# NODE_ENV=production arms the placeholder-token guards in index.mjs.
FROM node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    REST_HOST=0.0.0.0 \
    REST_PORT=1235 \
    SQLITE_PATH=/data/collab.sqlite
WORKDIR /app

# Package managers are build-time tools. Remove them from the runtime image so
# their unused dependency trees cannot add vulnerabilities or executable tools.
RUN rm -rf \
      /opt/yarn-v1.22.22 \
      /usr/local/lib/node_modules/corepack \
      /usr/local/lib/node_modules/npm && \
    rm -f \
      /usr/local/bin/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/pnpm \
      /usr/local/bin/pnpx \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg
COPY --from=dependencies --chown=node:node /app/package.json /app/package-lock.json /app/LICENSE ./
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node index.mjs ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/check-artifacts.mjs scripts/check-lockfile.mjs scripts/runtime-dependencies.mjs scripts/sqlite-maintenance.mjs ./scripts/
RUN node scripts/check-lockfile.mjs /app && node scripts/check-artifacts.mjs /app

# Only /data is mutable. Docker copies this ownership into a new named volume;
# an old root-owned volume needs the documented one-time migration.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 1234 1235
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:1234/',{signal:AbortSignal.timeout(2000)}).then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "index.mjs"]
