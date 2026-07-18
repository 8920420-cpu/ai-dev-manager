#!/usr/bin/env bash
# Ночной бэкап объектного хранилища MinIO ПС на сетевую папку.
# С 16.07 MinIO — распределённый Tenant (MinIO Operator, ns minio-tenant, EC:6),
# данные erasure-кодированы по 12 drive'ам, поэтому физический tar одного PVC НЕ годится.
# Логический бэкап: mc mirror бакета chat-files -> hostPath пода mc-backup (pinned
# node-01d306) -> tar.gz -> scp -> шара. Восстановление: mc mirror распакованного
# каталога обратно в бакет (mc mirror ./chat-files ps/chat-files).
# Ротация: последние $KEEP (7). Запуск: Scheduled Task "ai-dev-manager ps-minio backup" (01:15).
set -uo pipefail

KEY="/c/Users/Админ/.ssh/albia_tmp_key"
OPTS="-i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=8"
NODE="admin@192.168.1.213"
SHARE="//192.168.1.114/общая/BackupPS"
STAGE="/e/git/_backups"
LOG="$STAGE/backup-ps.log"
KEEP=7
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="ps-prod-minio-$STAMP.tar.gz"
REMOTE="/tmp/$NAME"

mkdir -p "$STAGE"
log(){ echo "$(date '+%F %T') | MINIO | $*" | tee -a "$LOG"; }
fail(){ log "ERROR: $*"; exit 1; }

log "=== minio backup start $NAME ==="

# 1) на ноде: mc mirror бакета в hostPath пода mc-backup, затем tar каталога
REMOTE_SCRIPT=$(cat <<EOF
set -o pipefail
AK=\$(k3s kubectl -n minio-tenant get secret ps-minio-app-creds -o jsonpath='{.data.accesskey}' | base64 -d)
SK=\$(k3s kubectl -n minio-tenant get secret ps-minio-app-creds -o jsonpath='{.data.secretkey}' | base64 -d)
k3s kubectl -n minio-tenant wait --for=condition=Ready pod/mc-backup --timeout=90s >/dev/null 2>&1 || { echo NO_MC_POD; exit 5; }
k3s kubectl -n minio-tenant exec mc-backup -- mc alias set ps http://minio.minio-tenant.svc.cluster.local:80 "\$AK" "\$SK" >/dev/null 2>&1 || { echo ALIAS_FAIL; exit 6; }
k3s kubectl -n minio-tenant exec mc-backup -- mc mirror --overwrite --remove ps/chat-files /backup/chat-files >/dev/null 2>&1 || { echo MIRROR_FAIL; exit 3; }
HP=/var/tmp/ps-minio-bk
OBJ=\$(find "\$HP" -type f 2>/dev/null | wc -l)
tar czf $REMOTE -C "\$HP" .
tar tzf $REMOTE >/dev/null 2>&1 || { echo BAD_TAR; exit 4; }
echo "TAR_OK size=\$(stat -c%s $REMOTE) objects=\$OBJ"
EOF
)
B64=$(printf '%s' "$REMOTE_SCRIPT" | base64 -w0)
OUT=$(ssh $OPTS "$NODE" "echo admin | sudo -S -p '' bash -c \"\$(echo $B64 | base64 -d)\"" 2>>"$LOG") \
  || fail "remote mirror/tar failed (rc=$?): $OUT"
log "node: $OUT"
echo "$OUT" | grep -q 'TAR_OK' || fail "backup check failed: $OUT"

# 2) забрать архив (scp)
scp $OPTS "$NODE:$REMOTE" "$STAGE/$NAME" >>"$LOG" 2>&1 || fail "scp failed"
tar tzf "$STAGE/$NAME" >/dev/null 2>&1 || fail "local tar verify failed"

# 3) опубликовать на шару
cp -f "$STAGE/$NAME" "$SHARE/$NAME" || fail "copy to share failed"
[ -s "$SHARE/$NAME" ] || fail "published file empty"

# 4) чистка ноды; локально держим 2 последних
ssh $OPTS "$NODE" "rm -f $REMOTE" >>"$LOG" 2>&1 || true
ls -1t "$STAGE"/ps-prod-minio-*.tar.gz 2>/dev/null | tail -n +3 | xargs -r rm -f

# 5) ротация на шаре: последние KEEP
ls -1t "$SHARE"/ps-prod-minio-*.tar.gz 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f

CNT=$(ls -1 "$SHARE"/ps-prod-minio-*.tar.gz 2>/dev/null | wc -l)
SZ=$(stat -c%s "$SHARE/$NAME" 2>/dev/null)
log "=== minio backup OK $NAME (${SZ} bytes); minio files on share=$CNT ==="
