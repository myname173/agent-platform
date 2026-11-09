FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY worker.js ./
COPY event-publisher.js ./
COPY outbox-publisher.js ./
COPY test-runtime.mjs ./
COPY load-test.mjs ./

EXPOSE 3220
CMD ["node", "server.js"]
