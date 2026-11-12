FROM node:22-alpine

WORKDIR /app
COPY sandbox_gateway.js ./sandbox_gateway.js
COPY sandbox_admission.js ./sandbox_admission.js
COPY sandbox_metrics.js ./sandbox_metrics.js

EXPOSE 8080
CMD ["node", "sandbox_gateway.js"]
