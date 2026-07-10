# Микросервис «Тестировщик».
# ВАЖНО: контекст сборки — КОРЕНЬ репозитория (а не каталог tester-service),
# потому что зависимость pipeline-runner подключается как file:../pipeline-runner.
#
#   docker build -f tester-service/Dockerfile -t tester-service:latest .
#
FROM node:20-alpine

WORKDIR /app

# Локальная зависимость должна лежать рядом, как и в репозитории.
COPY pipeline-runner/ ./pipeline-runner/
COPY tester-service/package.json ./tester-service/package.json

WORKDIR /app/tester-service
RUN npm install --omit=dev

# Исходники сервиса
COPY tester-service/src/ ./src/
COPY tester-service/bin/ ./bin/

ENV TESTER_PORT=4187
EXPOSE 4187

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:4187/health >/dev/null 2>&1 || exit 1

CMD ["node", "bin/tester-service.js"]
