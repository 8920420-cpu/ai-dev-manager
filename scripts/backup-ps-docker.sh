#!/usr/bin/env bash
# Ночной ПОЛНЫЙ бэкап СТАРОГО docker-инфра Postgres (Patroni на хосте 211) на ту же
# сетевую папку, что и k8s-бэкап.
#
# Зачем отдельно от backup-ps-prod.sh (который дампит CNPG в k8s):
#  - docker-контур и k8s-контур ЖИВЫ ОБА (fan-out мастер-данных пишет в оба), и часть
#    данных резидентно лежит только/преимущественно в docker и в k8s-дамп НЕ попадает:
#      * тела документов Archivum (upds/upds_outbox, ~7.5 ГБ) — в CNPG только метаданные;
#      * orchestrator_db (~120 МБ) — только в docker;
#      * beeline_db, dynamic_data (docker крупнее) — частично.
#    До этого скрипта весь docker-контур не бэкапился ничем.
#
# Почему через docker exec / docker cp, а не SSH+kubectl как в backup-ps-prod.sh:
#  - контейнер Patroni живёт НА ЭТОМ хосте, docker daemon локальный — стрим
#    pg_dumpall|gzip не пересекает сеть и не рвётся (та причина, по которой k8s-дамп
#    сжимается на ноде). Дампим и сжимаем ВНУТРИ контейнера, наружу забираем готовый
#    .gz через docker cp — целостный перенос, симметрично scp в k8s-скрипте.
#
# Критерий целостности = РОВНО один "database cluster dump complete" (footer
# pg_dumpall). Проверяется внутри контейнера до переноса и локально после.
#
# Ротация: держим последние $KEEP (7) файлов на шаре. Запуск: Scheduled Task
# "ai-dev-manager ps-docker backup" (см. CLAUDE.md); разнесён по времени с k8s-бэкапом.
set -uo pipefail

CONTAINER="infra-patroni1-1"   # primary Patroni docker-контура (haproxy:5000 рутит на него)
SHARE="//192.168.1.114/общая/BackupPS"
STAGE="/e/git/_backups"
LOG="$STAGE/backup-ps.log"
KEEP=7
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="ps-docker-pgdumpall-$STAMP.sql.gz"
REMOTE="/tmp/$NAME"

mkdir -p "$STAGE"
log(){ echo "$(date '+%F %T') | $*" | tee -a "$LOG"; }
fail(){ log "ERROR(docker): $*"; exit 1; }

log "=== docker backup start $NAME ==="

# 0) контейнер жив и это primary (не реплика — иначе дамп с отстающей копии)
docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true \
  || fail "контейнер $CONTAINER не запущен"
ROLE=$(docker exec "$CONTAINER" psql -U postgres -tAc \
  "SELECT CASE WHEN pg_is_in_recovery() THEN 'replica' ELSE 'primary' END" 2>>"$LOG") \
  || fail "не удалось определить роль $CONTAINER"
[ "$(echo "$ROLE" | tr -d '[:space:]')" = "primary" ] || fail "$CONTAINER не primary (role=$ROLE)"

# 1) dump+gzip ВНУТРИ контейнера, проверка footer прямо там.
# Именно bash, а не sh: /bin/sh в контейнере — dash, а pipefail нужен, чтобы падение
# pg_dumpall (а не только gzip в хвосте пайпа) считалось ошибкой.
docker exec "$CONTAINER" bash -c "set -o pipefail; pg_dumpall -U postgres | gzip -1 > $REMOTE" 2>>"$LOG" \
  || fail "pg_dumpall внутри контейнера завершился ошибкой"
OUT=$(docker exec "$CONTAINER" bash -c \
  "FC=\$(zcat $REMOTE | grep -c 'database cluster dump complete'); echo \"FOOTER=\$FC SIZE=\$(stat -c%s $REMOTE)\"" 2>>"$LOG") \
  || fail "проверка дампа в контейнере не прошла"
log "container: $OUT"
echo "$OUT" | grep -q 'FOOTER=1' || fail "footer check failed: $OUT"

# 2) забрать готовый .gz на хост (docker cp — целостный перенос)
docker cp "$CONTAINER:$REMOTE" "$STAGE/$NAME" >>"$LOG" 2>&1 || fail "docker cp failed"
gzip -t "$STAGE/$NAME" || fail "local gzip -t failed"

# 3) опубликовать на сетевую папку
cp -f "$STAGE/$NAME" "$SHARE/$NAME" || fail "copy to share failed"
[ -s "$SHARE/$NAME" ] || fail "published file empty"

# 4) убрать temp в контейнере; локально держим 2 последних docker-дампа
docker exec "$CONTAINER" rm -f "$REMOTE" >>"$LOG" 2>&1 || true
ls -1t "$STAGE"/ps-docker-pgdumpall-*.sql.gz 2>/dev/null | tail -n +3 | xargs -r rm -f

# 5) ротация на шаре: оставить последние KEEP
ls -1t "$SHARE"/ps-docker-pgdumpall-*.sql.gz 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f

CNT=$(ls -1 "$SHARE"/ps-docker-pgdumpall-*.sql.gz 2>/dev/null | wc -l)
SZ=$(stat -c%s "$SHARE/$NAME" 2>/dev/null)
log "=== docker backup OK $NAME (${SZ} bytes); files on share=$CNT ==="
