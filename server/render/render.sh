#!/bin/sh
# Рендерит PXE-файлы из шаблонов repo (server/www) в SERVER_DATA_ROOT/www.
# Подставляются ТОЛЬКО перечисленные переменные — ${...} iPXE и shell-скриптов
# остаются нетронутыми.
set -eu

: "${PXE_SERVER_IP:?Set PXE_SERVER_IP (LAN IP of the Docker host)}"
: "${PXE_HTTP_PORT:=8088}"
: "${ALBIA_PORT:=8090}"

SRC=/render/src
DST=/render/dst

if [ -e "$DST/boot.ipxe" ] && [ "$SRC/boot.ipxe" -ef "$DST/boot.ipxe" ]; then
  echo "ERROR: SERVER_DATA_ROOT указывает внутрь repo (src == dst)." >&2
  echo "Задайте SERVER_DATA_ROOT вне репозитория (см. docs/SERVER_PXE_RUNBOOK.md)." >&2
  exit 1
fi

if [ -z "${ALBIA_SSH_PUBKEY:-}" ]; then
  # tr -d: pub-ключ может быть сохранён на Windows с CRLF — CR в authorized-keys недопустим
  if [ -f /render/ssh/albia_provision_ed25519.pub ]; then
    ALBIA_SSH_PUBKEY="$(tr -d '\r' < /render/ssh/albia_provision_ed25519.pub)"
  elif [ -f /render/ssh/admin_ed25519.pub ]; then
    echo "WARN: albia_provision_ed25519.pub не найден, использую admin_ed25519.pub" >&2
    ALBIA_SSH_PUBKEY="$(tr -d '\r' < /render/ssh/admin_ed25519.pub)"
  else
    echo "ERROR: нет ALBIA_SSH_PUBKEY и не найден pub-ключ в /render/ssh/" >&2
    echo "Положите публичный ключ в \$SERVER_DATA_ROOT/ssh/albia_provision_ed25519.pub" >&2
    exit 1
  fi
fi
export PXE_SERVER_IP PXE_HTTP_PORT ALBIA_PORT ALBIA_SSH_PUBKEY

VARS='${PXE_SERVER_IP} ${PXE_HTTP_PORT} ${ALBIA_PORT} ${ALBIA_SSH_PUBKEY}'

mkdir -p "$DST/autoinstall" "$DST/scripts"
envsubst "$VARS" < "$SRC/boot.ipxe" > "$DST/boot.ipxe"
envsubst "$VARS" < "$SRC/autoinstall/user-data" > "$DST/autoinstall/user-data"
envsubst "$VARS" < "$SRC/scripts/firstboot.sh" > "$DST/scripts/firstboot.sh"
cp "$SRC/autoinstall/meta-data" "$DST/autoinstall/meta-data"
# пустой vendor-data обязателен: без него cloud-init бракует весь NoCloud-сид
# (10 ретраев 404 → datasource failed → установщик уходит в интерактив)
cp "$SRC/autoinstall/vendor-data" "$DST/autoinstall/vendor-data"

for f in "$DST/boot.ipxe" "$DST/autoinstall/user-data" "$DST/scripts/firstboot.sh"; do
  if grep -q 'PXE_SERVER_IP\|PXE_HTTP_PORT\|ALBIA_PORT\|ALBIA_SSH_PUBKEY' "$f"; then
    echo "ERROR: в $f остались неподставленные переменные" >&2
    exit 1
  fi
done

echo "render ok: boot.ipxe, autoinstall/user-data, scripts/firstboot.sh -> $DST"
echo "  PXE_SERVER_IP=$PXE_SERVER_IP PXE_HTTP_PORT=$PXE_HTTP_PORT ALBIA_PORT=$ALBIA_PORT"
