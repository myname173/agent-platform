FROM node:22-alpine

WORKDIR /app
COPY sandbox_gateway.js ./sandbox_gateway.js

EXPOSE 8080
CMD ["node", "sandbox_gateway.js"]
