FROM node:24-alpine
WORKDIR /app
COPY tools-service/package.json ./
COPY tools-service/src ./src
COPY tools-service/bin ./bin
EXPOSE 4188
CMD ["node", "bin/tools-service.js"]
