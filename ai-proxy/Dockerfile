# Built locally by docker-compose.yml; this repository never pushes an image.
# The proxy has zero dependencies, so an install stage would only add surface.
FROM node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
ENV NODE_ENV=production
# Containers must bind wide for the port mapping to reach the process; the
# loopback default in index.mjs protects bare-metal runs, not this one.
ENV HOST=0.0.0.0
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
COPY --chown=node:node package.json index.mjs LICENSE ./
COPY --chown=node:node src ./src
# Nothing here writes to disk, so nothing here needs root.
USER node
EXPOSE 1250
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:1250/',{signal:AbortSignal.timeout(2000)}).then((r)=>process.exit(r.status===405?0:1),()=>process.exit(1))"]
CMD ["node", "index.mjs"]
