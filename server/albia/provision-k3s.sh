#!/bin/sh
# Разворачивает HA-кластер k3s на зарегистрированных нодах (embedded etcd).
# Запуск изнутри контейнера albia:
#   docker exec albia provision-k3s.sh              # ноды из registry/nodes.jsonl
#   docker exec albia provision-k3s.sh 192.168.1.51 192.168.1.52
#   docker exec albia provision-k3s.sh 192.168.1.157:192.168.5.1 192.168.1.213:192.168.5.2
#
# Каждый аргумент — либо один IP, либо пара ssh_ip:node_ip:
#   ssh_ip  — как достучаться до ноды с машины управления (LAN площадки);
#   node_ip — адрес ноды в кластерной сети (WG-mesh wg-cluster 192.168.5.0/24,
#             см. runbook «Кластерная сеть»); туда биндятся etcd и API.
# Без пары ssh_ip = node_ip (кластер прямо на адресах площадок).
# Кластерный трафик ходит по node_ip; белые IP площадок используются
# только для входа от Cloudflare.
# flannel-backend=wireguard-native: flannel строит собственный шифрованный
# mesh между нодами и сам подбирает MTU — критично, т.к. путь между
# площадками идёт через WG-туннели (MTU ~1420, vxlan бы фрагментировался).
set -eu

: "${ALBIA_REGISTRY_DIR:=/opt/albia/registry}"
: "${ALBIA_PROVISION_USER:=admin}"
: "${ALBIA_PROVISION_SSH_KEY:=/opt/albia/ssh/admin_ed25519}"
: "${ALBIA_PROVISION_PXE_SERVER_IP:?Set ALBIA_PROVISION_PXE_SERVER_IP (LAN IP of the Docker host)}"
: "${K3S_REGISTRY:=${ALBIA_PROVISION_PXE_SERVER_IP}:5000}"
: "${K3S_TLS_SAN_EXTRA:=}" # запятая-список доп. SAN (белые IP, домен API)
: "${K3S_INSTALL_URL:=https://get.k3s.io}"

NODES_FILE="$ALBIA_REGISTRY_DIR/nodes.jsonl"
KUBECONFIG_OUT="$ALBIA_REGISTRY_DIR/kubeconfig"

[ -f "$ALBIA_PROVISION_SSH_KEY" ] || { echo "ERROR: ssh key not found: $ALBIA_PROVISION_SSH_KEY" >&2; exit 1; }

# Windows bind-mount отдаёт ключ с правами 0777 — ssh такой ключ отвергает.
# Копируем во временный файл с 600 и убираем возможный CRLF.
umask 077
SSH_KEY_TMP="$(mktemp)"
tr -d '\r' < "$ALBIA_PROVISION_SSH_KEY" > "$SSH_KEY_TMP"
trap 'rm -f "$SSH_KEY_TMP"' EXIT
ALBIA_PROVISION_SSH_KEY="$SSH_KEY_TMP"

if [ "$#" -gt 0 ]; then
  NODES="$*"
else
  [ -s "$NODES_FILE" ] || { echo "ERROR: no nodes given and $NODES_FILE is empty" >&2; exit 1; }
  # последняя регистрация каждого nodeId; берём LAN primaryIp
  NODES="$(jq -rs '
    [ .[] | {id: .nodeId, ip: (.payload.primaryIp // empty)} | select(.ip != "") ]
    | group_by(.id) | map(.[-1].ip) | unique | .[]' "$NODES_FILE")"
fi

set -- $NODES
[ "$#" -ge 1 ] || { echo "ERROR: node list is empty" >&2; exit 1; }
echo "Nodes: $*"

ssh_of()  { printf '%s' "${1%%:*}"; }
node_of() { case "$1" in *:*) printf '%s' "${1#*:}";; *) printf '%s' "$1";; esac; }

SSH_OPTS="-i $ALBIA_PROVISION_SSH_KEY -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"
run() { # run <node-entry> <command...>
  _run_ip="$(ssh_of "$1")"; shift
  ssh $SSH_OPTS "$ALBIA_PROVISION_USER@$_run_ip" "$@"
}

tls_san="--tls-san $ALBIA_PROVISION_PXE_SERVER_IP"
for e in "$@"; do
  _n="$(node_of "$e")"; _s="$(ssh_of "$e")"
  tls_san="$tls_san --tls-san $_n"
  if [ "$_s" != "$_n" ]; then tls_san="$tls_san --tls-san $_s"; fi
done
if [ -n "$K3S_TLS_SAN_EXTRA" ]; then
  for san in $(printf '%s' "$K3S_TLS_SAN_EXTRA" | tr ',' ' '); do
    tls_san="$tls_san --tls-san $san"
  done
fi

write_registries() { # доверие к локальному http-registry до старта k3s
  run "$1" "sudo mkdir -p /etc/rancher/k3s && printf '%s\n' \
'mirrors:' \
'  \"$K3S_REGISTRY\":' \
'    endpoint:' \
'      - \"http://$K3S_REGISTRY\"' | sudo tee /etc/rancher/k3s/registries.yaml >/dev/null"
}

node_ready() {
  run "$1" "systemctl is-active --quiet k3s" 2>/dev/null
}

first="$1"
first_node="$(node_of "$first")"
first_ssh="$(ssh_of "$first")"

echo "== bootstrap first server: $first =="
write_registries "$first"
if node_ready "$first"; then
  echo "k3s already active on $first, skip install"
else
  # traefik выключен: ingress — свой nginx (ingress-nginx DaemonSet) на каждой ноде,
  # см. deploy/k8s/10-ingress-nginx.yaml
  run "$first" "curl -sfL $K3S_INSTALL_URL | sudo sh -s - server --cluster-init \
    --node-ip $first_node --advertise-address $first_node $tls_san \
    --disable traefik \
    --flannel-backend=wireguard-native \
    --write-kubeconfig-mode 640"
fi

token="$(run "$first" 'sudo cat /var/lib/rancher/k3s/server/node-token')"
[ -n "$token" ] || { echo "ERROR: failed to read cluster token from $first" >&2; exit 1; }
umask 077
printf '%s\n' "$token" > "$ALBIA_REGISTRY_DIR/k3s-token"

for e in "$@"; do
  [ "$e" = "$first" ] && continue
  echo "== join server: $e =="
  write_registries "$e"
  if node_ready "$e"; then
    echo "k3s already active on $e, skip install"
    continue
  fi
  run "$e" "curl -sfL $K3S_INSTALL_URL | sudo K3S_TOKEN='$token' sh -s - server \
    --server https://$first_node:6443 --node-ip $(node_of "$e") $tls_san \
    --disable traefik \
    --flannel-backend=wireguard-native"
done

echo "== fetch kubeconfig =="
# в kubeconfig — ssh-адрес первой ноды: он достижим с машины управления
# (кластерный node_ip может жить в WG-сети, куда 211 не входит)
run "$first" 'sudo cat /etc/rancher/k3s/k3s.yaml' \
  | sed "s/127.0.0.1/$first_ssh/" > "$KUBECONFIG_OUT"
echo "kubeconfig: $KUBECONFIG_OUT (server https://$first_ssh:6443)"

echo "== cluster state =="
run "$first" 'sudo k3s kubectl get nodes -o wide' || true
echo "OK"
