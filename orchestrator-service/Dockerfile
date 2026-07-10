# Один образ: Node-бэкенд раздаёт React-фронтенд (Vite) и предоставляет API.
# Контекст сборки — КОРЕНЬ репозитория (см. docker-compose: context=.),
# чтобы получить доступ и к исходникам фронтенда (src/), и к backend.

# --- Stage 1: сборка React-фронтенда ---
FROM node:24-alpine AS frontend
WORKDIR /web
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build
# результат: /web/dist

# --- Stage 2: backend + собранная статика ---
FROM node:24-alpine
WORKDIR /app

# Зависимости бэкенда
COPY orchestrator-service/backend/package.json orchestrator-service/backend/package-lock.json* ./backend/
RUN cd backend && npm install --omit=dev --no-audit --no-fund

# Исходники бэкенда (включая db/migrations, db/seed)
COPY orchestrator-service/backend ./backend

# React-сборка вместо прежней plain-HTML страницы.
# backend раздаёт ../../frontend (см. FRONTEND_DIR в src/server.js) с SPA-фолбэком.
COPY --from=frontend /web/dist ./frontend

# Промты ролей: ИИ-движок runner (roleEngine.js) читает их из ROLES_DIR.
# Контекст сборки — корень репозитория, поэтому каталог roles/ доступен.
COPY roles ./roles

ENV PORT=80
ENV ROLES_DIR=/app/roles
# VERSION-KPI-TRACKING-001: git-SHA на момент сборки образа. Прокидывается build-arg
# из docker-compose (build.args.APP_CODE_VERSION) и читается на старте сервера для
# авто-метки деплоя (kpi_markers type=deploy). Пусто — метка не ставится.
ARG APP_CODE_VERSION=
ENV APP_CODE_VERSION=$APP_CODE_VERSION
EXPOSE 80

# 127.0.0.1, а не localhost: alpine резолвит localhost в IPv6 ::1, а сервер
# слушает IPv4 0.0.0.0 — иначе healthcheck даёт Connection refused.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/health >/dev/null 2>&1 || exit 1

CMD ["node", "backend/bin/server.js"]
