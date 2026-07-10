# MCP-SERVICE-001 — образ MCP-сервера AI Dev Manager.
# Контекст сборки — каталог mcp-service/ (см. docker-compose: build ./mcp-service).
FROM node:24-alpine
WORKDIR /app
# Сначала манифесты — для кэширования слоя зависимостей.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY bin ./bin
EXPOSE 4190
# В контейнере поднимаем HTTP-режим (health на :4190 + Streamable MCP /mcp).
CMD ["node", "bin/mcp-service.js", "--http-only"]
