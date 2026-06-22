# Статический SPA (Vite/React) отдаётся через nginx.
# В репозитории присутствует только готовая сборка dist/, поэтому
# образ собирается из неё напрямую, без этапа npm build.
FROM nginx:1.27-alpine

# Конфиг nginx с SPA-фолбэком и кэшированием ассетов
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Собранная статика
COPY dist/ /usr/share/nginx/html/

EXPOSE 80

# Проверка живости контейнера
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
