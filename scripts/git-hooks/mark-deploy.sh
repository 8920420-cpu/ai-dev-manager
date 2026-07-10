#!/bin/sh
# VERSION-KPI-TRACKING-001 — авто-метка деплоя из git-хука.
#
# Ставит метку kpi_markers type=deploy с коротким git-SHA текущего HEAD, чтобы на
# графиках KPI появилась вертикальная линия «обновили код до SHA». Вызывается из
# хуков post-merge / post-rewrite (git pull, rebase, amend). Идемпотентность по
# ref — на стороне оркестратора (recordDeployMarker не плодит метку того же SHA),
# так что повторные срабатывания безопасны.
#
# Установка хуков: git config core.hooksPath scripts/git-hooks (см. scripts/deploy.ps1
# --install-hooks или README). ORCHESTRATOR_URL переопределяет адрес (по умолчанию
# хостовый порт контейнера). Любой сбой (нет curl, сервис недоступен) тихо игнорим:
# хук НИКОГДА не должен ломать git-операцию.
sha=$(git rev-parse --short HEAD 2>/dev/null) || exit 0
[ -z "$sha" ] && exit 0
url="${ORCHESTRATOR_URL:-http://localhost:4186}"
command -v curl >/dev/null 2>&1 || exit 0
curl -fsS -m 5 -X POST "$url/api/kpi-markers" \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"deploy\",\"ref\":\"$sha\",\"description\":\"git → $sha\"}" >/dev/null 2>&1 || true
exit 0
