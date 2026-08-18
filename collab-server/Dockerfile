# Built locally by docker-compose.yml; nothing is published as an image.
# NODE_ENV=production arms the placeholder-token guards in index.mjs.
FROM node:22-alpine
ENV NODE_ENV=production
# Containers must bind wide for the port mappings to reach the process; the
# loopback default in index.mjs protects bare-metal runs, not this one. The
# SQLite file lives under /data so a bare `docker run` works and compose can
# mount its named volume over it. REST_PORT is baked so the EXPOSEd REST
# port actually listens in a bare run, not only under compose.
ENV HOST=0.0.0.0 REST_HOST=0.0.0.0 REST_PORT=1235 SQLITE_PATH=/data/collab.sqlite
WORKDIR /app
COPY package.json LICENSE ./
RUN npm install --omit=dev
COPY index.mjs ./
COPY src ./src
# The server needs no root: only /data is written. The chown reaches a
# compose named volume only when that volume is first created empty; a
# volume that already exists from an older root-based image keeps its root
# ownership and needs the one-time migration in the repository README.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 1234 1235
CMD ["node", "index.mjs"]
