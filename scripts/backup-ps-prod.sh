#!/usr/bin/env bash
# Ночной ПОЛНЫЙ бэкап БД ПС (k3s ns ps-prod, единый postgres) на сетевую папку.
#
# Почему так (важно):
#  - pg_dumpall делается И сжимается НА НОДЕ (поток pg_dumpall|gzip не пересекает
#    сеть) — длинный сырой поток через kubectl exec/SSH обрывается под конец
#    (проверено 16.07: стрим давал битый дамп без footer). Готовый .gz забираем
#    scp'ом (целостный перенос).
#  - Критерий целостности дампа = РОВНО один "database cluster dump complete"
#    (grep '^\connect' для формата pg_dumpall не работает — не использовать).
#  - Пишем на \\192.168.1.114\общая\BackupPS (в bash/MSYS путь с кириллицей ок).
#
# Ротация: держим последние $KEEP (7) файлов на шаре (1 бэкап/сутки = 7 дней).
# Запуск: Scheduled Task "ai-dev-manager ps-prod backup" в 01:00 (см. CLAUDE.md).
set -uo pipefail

KEY="/c/Users/Админ/.ssh/albia_tmp_key"
OPTS="-i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=8"
NODE="admin@192.168.1.213"
SHARE="//192.168.1.114/общая/BackupPS"
STAGE="/e/git/_backups"
LOG="$STAGE/backup-ps.log"
KEEP=7
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="ps-prod-pgdumpall-$STAMP.sql.gz"
REMOTE="/tmp/$NAME"

mkdir -p "$STAGE"
log(){ echo "$(date '+%F %T') | $*" | tee -a "$LOG"; }
fail(){ log "ERROR: $*"; exit 1; }

log "=== backup start $NAME ==="

# 1) dump+gzip НА НОДЕ (root через sudo-обёртку), проверка footer прямо там
REMOTE_SCRIPT=$(cat <<EOF
set -o pipefail
# цель дампа = ТЕКУЩИЙ primary CNPG-кластера pg-ps (по лейблу — следует за failover),
# НЕ осиротевший старый Deployment/postgres (после миграции на CNPG он застыл).
PRIMARY=\$(k3s kubectl -n ps-prod get pod -l cnpg.io/cluster=pg-ps,cnpg.io/instanceRole=primary -o jsonpath='{.items[0].metadata.name}')
[ -n "\$PRIMARY" ] || { echo NO_PRIMARY; exit 5; }
k3s kubectl -n ps-prod exec "\$PRIMARY" -c postgres -- pg_dumpall -U postgres | gzip -1 > $REMOTE
rc=\$?
[ \$rc -eq 0 ] || { echo "PGDUMP_RC=\$rc"; exit 3; }
FC=\$(zcat $REMOTE | grep -c 'database cluster dump complete')
echo "FOOTER=\$FC SIZE=\$(stat -c%s $REMOTE)"
[ "\$FC" -eq 1 ] || { echo BAD_FOOTER; exit 4; }
EOF
)
B64=$(printf '%s' "$REMOTE_SCRIPT" | base64 -w0)
OUT=$(ssh $OPTS "$NODE" "echo admin | sudo -S -p '' bash -c \"\$(echo $B64 | base64 -d)\"" 2>>"$LOG") \
  || fail "remote dump failed (rc=$?): $OUT"
log "node: $OUT"
echo "$OUT" | grep -q 'FOOTER=1' || fail "footer check failed: $OUT"

# 2) забрать готовый .gz на хост (scp — целостный перенос)
scp $OPTS "$NODE:$REMOTE" "$STAGE/$NAME" >>"$LOG" 2>&1 || fail "scp failed"
gzip -t "$STAGE/$NAME" || fail "local gzip -t failed"

# 3) опубликовать на сетевую папку
cp -f "$STAGE/$NAME" "$SHARE/$NAME" || fail "copy to share failed"
[ -s "$SHARE/$NAME" ] || fail "published file empty"

# 4) убрать temp на ноде; локально держим 2 последних
ssh $OPTS "$NODE" "rm -f $REMOTE" >>"$LOG" 2>&1 || true
ls -1t "$STAGE"/ps-prod-pgdumpall-*.sql.gz 2>/dev/null | tail -n +3 | xargs -r rm -f

# 5) ротация на шаре: оставить последние KEEP
ls -1t "$SHARE"/ps-prod-pgdumpall-*.sql.gz 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f

CNT=$(ls -1 "$SHARE"/ps-prod-pgdumpall-*.sql.gz 2>/dev/null | wc -l)
SZ=$(stat -c%s "$SHARE/$NAME" 2>/dev/null)
log "=== backup OK $NAME (${SZ} bytes); files on share=$CNT ==="
