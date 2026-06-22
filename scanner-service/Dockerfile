FROM node:24-alpine
WORKDIR /app
COPY scanner-service/package.json ./
COPY scanner-service/src ./src
COPY scanner-service/bin ./bin
CMD ["node", "bin/scanner-service.js"]
