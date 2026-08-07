# Built locally by docker-compose.yml; nothing is published as an image.
# The proxy has zero dependencies, so there is no install step.
# NODE_ENV=production arms the token guards in index.mjs.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json index.mjs ./
COPY src ./src
CMD ["node", "index.mjs"]
