# Built locally by docker-compose.yml; nothing is published as an image.
# The proxy has zero dependencies, so there is no install step.
# NODE_ENV=production arms the token guards in index.mjs.
FROM node:22-alpine
ENV NODE_ENV=production
# Containers must bind wide for the port mapping to reach the process; the
# loopback default in index.mjs protects bare-metal runs, not this one.
ENV HOST=0.0.0.0
WORKDIR /app
COPY package.json index.mjs ./
COPY src ./src
# Nothing here writes to disk, so nothing here needs root.
USER node
EXPOSE 1250
CMD ["node", "index.mjs"]
