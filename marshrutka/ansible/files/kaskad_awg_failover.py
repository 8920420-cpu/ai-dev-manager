# Вотчдог туннеля Каскад -> timeweb (AmneziaWG, интерфейс Wireguard1).
#
# Зачем: провайдер Каскада с 22.07.2026 режет UDP от белого IP VPS (72.56.73.96)
# в сторону площадки — хендшейк уходит, ответ хаба не доходит, туннель лежит.
# Обход: слать не напрямую, а через релей за giga (проброс 9099/udp на
# 192.168.1.211, где socat пересылает на 72.56.73.96:42666) — на хабе Каскад
# виден с адреса giga, который не заблокирован.
#
# Логика: раз в запуск смотрим `show interface Wireguard1`. Туннель online —
# ничего не делаем. Лежит — переключаем endpoint на альтернативный путь
# (прямой <-> релей) и сохраняем конфиг. Пока работает один из путей, вотчдог
# на нём и остаётся; обратно на прямой сам не возвращается — блокировку надо
# сначала увидеть снятой (см. README, раздел про Каскад).
#
# Запуск: RPASS=... python kaskad_awg_failover.py [--dry-run]
import os
import re
import sys
import time

import paramiko

ROUTER = os.environ.get("KASKAD_HOST", "kaskadvrn.keenetic.link")
USER = os.environ.get("KASKAD_USER", "Semaphore")
IFACE = "Wireguard1"
PEER = "Rq5d1vL2pMienYqhcqN1bXP0vMNUrqug3V+y25rkK0k="

DIRECT = "72.56.73.96:42666"          # прямой путь до хаба
RELAY = "195.98.86.63:9099"           # через giga -> socat на 192.168.1.211

PROMPT = re.compile(r"\([\w./-]+\)>\s*$")
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def run(cmds, timeout=30):
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(ROUTER, username=USER, password=os.environ["RPASS"], timeout=20,
                allow_agent=False, look_for_keys=False)
    ch = cli.invoke_shell(term="vt100", width=200)
    out = []

    def wait(deadline):
        buf = ""
        while True:
            if ch.recv_ready():
                buf += ch.recv(65536).decode("utf-8", "replace")
                if PROMPT.search(ANSI.sub("", buf)):
                    return ANSI.sub("", buf)
            elif time.time() > deadline:
                raise RuntimeError("prompt timeout: " + buf[-200:])
            else:
                time.sleep(0.2)

    wait(time.time() + 20)
    for cmd in cmds:
        ch.send(cmd + "\r")
        out.append(wait(time.time() + timeout))
    ch.send("exit\r")
    time.sleep(1)
    cli.close()
    return "\n".join(out)


def state():
    text = run(["show interface " + IFACE])
    online = re.search(r"online:\s*(\w+)", text)
    addr = re.search(r"remote-endpoint-address:\s*([\d.]+)", text)
    port = re.search(r"remote-port:\s*(\d+)", text)
    endpoint = "{}:{}".format(addr.group(1), port.group(1)) if addr and port else "?"
    return (online.group(1) == "yes" if online else False), endpoint


def main():
    dry = "--dry-run" in sys.argv
    up, endpoint = state()
    if up:
        print("OK: {} online, endpoint {}".format(IFACE, endpoint))
        return 0

    target = DIRECT if endpoint.startswith("195.98.86.63") else RELAY
    print("DOWN: {} лежит на endpoint {} -> переключаю на {}".format(IFACE, endpoint, target))
    if dry:
        return 0

    run(["interface " + IFACE,
         "wireguard peer " + PEER,
         "endpoint " + target,
         "exit", "exit",
         "system configuration save"])

    time.sleep(25)
    up, endpoint = state()
    print("после переключения: endpoint {}, online {}".format(endpoint, "yes" if up else "no"))
    # Не считаем провалом: второй путь мог тоже лежать, следующий запуск вернёт обратно.
    return 0


if __name__ == "__main__":
    sys.exit(main())
