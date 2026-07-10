# MCP-SERVICE-001 — образ MCP-сервера AI Dev Manager.
# Контекст сборки — корень репозитория (см. docker-compose), чтобы подключать shared/.
FROM node:24-alpine
WORKDIR /app
# Сначала манифесты — для кэширования слоя зависимостей.
COPY mcp-service/package.json mcp-service/package-lock.json ./
RUN npm ci --omit=dev
COPY mcp-service/src ./src
COPY mcp-service/bin ./bin
COPY shared /shared
EXPOSE 4190
# В контейнере поднимаем HTTP-режим (health на :4190 + Streamable MCP /mcp).
CMD ["node", "bin/mcp-service.js", "--http-only"]
