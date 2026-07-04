#!/bin/sh
set -eu

ALBIA_URL="${ALBIA_URL:-http://${PXE_SERVER_IP}:${ALBIA_PORT}/cgi-bin/register}"
STATE_DIR="/var/lib/albia"
STATE_FILE="$STATE_DIR/registered"

mkdir -p "$STATE_DIR"

if [ -f "$STATE_FILE" ]; then
  echo "Albia registration already completed"
  exit 0
fi

hostname="$(hostname)"
machine_id="$(cat /etc/machine-id 2>/dev/null || true)"
primary_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
all_ips="$(hostname -I 2>/dev/null | tr ' ' ',' | sed 's/,*$//')"
serial="$(cat /sys/class/dmi/id/product_serial 2>/dev/null || true)"
product_name="$(cat /sys/class/dmi/id/product_name 2>/dev/null || true)"
manufacturer="$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null || true)"
registered_at="$(date -Iseconds 2>/dev/null || date)"

node_id="${machine_id:-$hostname}"

payload="$(cat <<EOF
{"nodeId":"$node_id","hostname":"$hostname","primaryIp":"$primary_ip","allIps":"$all_ips","sshUser":"admin","machineId":"$machine_id","serial":"$serial","manufacturer":"$manufacturer","productName":"$product_name","registeredAt":"$registered_at"}
EOF
)"

tmp_response="$STATE_DIR/register-response.json"

if command -v curl >/dev/null 2>&1; then
  curl -fsS -X POST -H 'Content-Type: application/json' --data "$payload" "$ALBIA_URL" -o "$tmp_response"
else
  wget -qO "$tmp_response" --header='Content-Type: application/json' --post-data="$payload" "$ALBIA_URL"
fi

printf '%s\n' "$payload" > "$STATE_DIR/register-payload.json"
printf '%s\n' "$registered_at" > "$STATE_FILE"

echo "Albia registration completed: $ALBIA_URL"
