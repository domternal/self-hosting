# Built locally by docker-compose.yml; nothing is published as an image.
# NODE_ENV=production arms the placeholder-token guards in index.mjs.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.mjs ./
COPY src ./src
CMD ["node", "index.mjs"]
