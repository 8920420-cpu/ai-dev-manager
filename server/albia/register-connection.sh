#!/bin/sh
set -eu

: "${ALBIA_REGISTRY_DIR:=/opt/albia/registry}"
mkdir -p "$ALBIA_REGISTRY_DIR"

IFS= read -r request_line || request_line=""
request_line="${request_line%$(printf '\r')}"
method="$(printf '%s' "$request_line" | awk '{print $1}')"
path="$(printf '%s' "$request_line" | awk '{print $2}')"

content_length="0"
while IFS= read -r header; do
  header="${header%$(printf '\r')}"
  [ -n "$header" ] || break
  key="$(printf '%s' "$header" | cut -d: -f1 | tr 'A-Z' 'a-z')"
  value="$(printf '%s' "$header" | cut -d: -f2- | sed 's/^ *//')"
  if [ "$key" = "content-length" ]; then
    content_length="$value"
  fi
done

body=""
if [ "$content_length" -gt 0 ] 2>/dev/null; then
  body="$(dd bs=1 count="$content_length" 2>/dev/null || true)"
fi

# iPXE-гард: boot.ipxe спрашивает по MAC, ставилась ли нода (см. www/cgi-bin/boot-guard).
case "$method $path" in
  "GET /cgi-bin/boot-guard"*)
    query=""
    case "$path" in *\?*) query="${path#*\?}" ;; esac
    printf 'HTTP/1.1 200 OK\r\nConnection: close\r\n'
    QUERY_STRING="$query" ALBIA_REGISTRY_DIR="$ALBIA_REGISTRY_DIR" /opt/albia/www/cgi-bin/boot-guard
    exit 0
    ;;
esac

if [ "$method" != "POST" ] || [ "$path" != "/cgi-bin/register" ]; then
  printf 'HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"ok":false,"error":"not_found"}\n'
  exit 0
fi

registered_at="$(date -Iseconds 2>/dev/null || date)"
remote_addr="${REMOTE_ADDR:-unknown}"
node_id="$(printf '%s' "$body" | sed -n 's/.*"nodeId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
hostname="$(printf '%s' "$body" | sed -n 's/.*"hostname"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"

[ -n "$node_id" ] || node_id="node-$(date +%s)"
[ -n "$hostname" ] || hostname="unknown"
[ -n "$body" ] || body='{}'

printf '{"registeredAt":"%s","remoteAddr":"%s","nodeId":"%s","hostname":"%s","payload":%s}\n' \
  "$registered_at" "$remote_addr" "$node_id" "$hostname" "$body" >> "$ALBIA_REGISTRY_DIR/nodes.jsonl"

printf 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"ok":true,"nodeId":"%s","hostname":"%s"}\n' "$node_id" "$hostname"
