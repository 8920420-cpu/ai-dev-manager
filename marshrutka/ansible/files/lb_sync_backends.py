#!/usr/bin/env python3
# Вотчдог бэкендов балансировщика Timeweb (id 134251, вход фронтов ПС).
# Проблема: WAN Каскада и Барикадной — DHCP, белые IP могут смениться, а LB
# принимает бэкенды только литеральными IP. KeenDNS-имена роутеров всегда
# указывают на текущий WAN — скрипт резолвит их, сравнивает с текущим списком
# бэкендов и добавляет новые / убирает протухшие (сначала add, потом delete,
# чтобы число живых бэкендов не проседало).
# Безопасность: если хоть одно имя не резолвится или API недоступен — ничего
# не удаляет и выходит с кодом 1 (Semaphore покажет задачу красной).
# Запуск: TIMEWEB_CLOUD_TOKEN=... python3 lb_sync_backends.py [--dry-run]
import json
import os
import socket
import sys
import urllib.request

BALANCER_ID = 134251
API = "https://api.timeweb.cloud/api/v1/balancers/%d/ips" % BALANCER_ID
STATIC_IPS = {"195.98.86.63"}  # базовая (giga) — статический WAN
DDNS_NAMES = [
    "kaskadvrn.keenetic.link",  # Каскад
    "psvrn.keenetic.link",      # Барикадная
]
# Бэкенды, которые скрипт не трогает, даже если их нет в желаемом списке
# (запасной вход через VPN-сервер, может добавляться руками при инцидентах):
KEEP_EXTRA = {"72.56.73.96"}

DRY_RUN = "--dry-run" in sys.argv[1:]
TOKEN = os.environ.get("TIMEWEB_CLOUD_TOKEN", "")
if not TOKEN:
    print("FATAL: нет TIMEWEB_CLOUD_TOKEN в окружении")
    sys.exit(1)


def api(method, body=None):
    req = urllib.request.Request(API, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    data = None
    if body is not None:
        req.add_header("Content-Type", "application/json")
        data = json.dumps(body).encode()
    with urllib.request.urlopen(req, data, timeout=30) as resp:
        raw = resp.read()
    return json.loads(raw) if raw.strip() else {}


def resolve4(name):
    return {ai[4][0] for ai in socket.getaddrinfo(name, None, socket.AF_INET)}


desired = set(STATIC_IPS)
for name in DDNS_NAMES:
    try:
        ips = resolve4(name)
    except OSError as e:
        print("FATAL: %s не резолвится (%s) — ничего не меняю" % (name, e))
        sys.exit(1)
    print("resolve %s -> %s" % (name, ", ".join(sorted(ips))))
    desired |= ips

current = set(api("GET")["ips"])
print("LB backends: %s" % ", ".join(sorted(current)))

to_add = sorted(desired - current)
to_del = sorted(current - desired - KEEP_EXTRA)

if not to_add and not to_del:
    print("OK: расхождений нет")
    sys.exit(0)

print("CHANGED: add=%s del=%s%s"
      % (to_add or "-", to_del or "-", " (dry-run)" if DRY_RUN else ""))
if DRY_RUN:
    sys.exit(0)
if to_add:
    api("POST", {"ips": to_add})
    print("added: %s" % ", ".join(to_add))
if to_del:
    api("DELETE", {"ips": to_del})
    print("deleted: %s" % ", ".join(to_del))
print("итог: %s" % ", ".join(sorted(api("GET")["ips"])))
