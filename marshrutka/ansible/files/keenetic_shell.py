#!/usr/bin/env python3
# Прогон команд по интерактивному CLI Keenetic (NDMS) через SSH.
# Keenetic не даёт exec-канал — только interactive shell; пейджер обходим
# высоким pty. Пароль берётся из переменной окружения, имя которой передано
# вторым аргументом после логина (секреты не светятся в argv/логах Semaphore).
# Использование:
#   keenetic_shell.py <host> <user> <PASS_ENV_NAME> "cmd1" "cmd2" ...
# Команда с префиксом "-" может завершиться ошибкой CLI без падения скрипта
# (как в make), например "-no ip host x.ps.lan" когда записи ещё нет.
import os
import re
import sys
import time

import paramiko

host, user, pass_env = sys.argv[1], sys.argv[2], sys.argv[3]
cmds = sys.argv[4:]
password = os.environ[pass_env]

PROMPT = re.compile(r"\([\w./-]+\)>\s*$")
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
CLI_ERROR = re.compile(r"\berror\b", re.IGNORECASE)

cli = paramiko.SSHClient()
cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cli.connect(host, username=user, password=password, timeout=20,
            allow_agent=False, look_for_keys=False)
ch = cli.invoke_shell(term="vt100", width=250, height=5000)


def wait_prompt(deadline):
    buf = ""
    while True:
        if ch.recv_ready():
            buf += ch.recv(65536).decode("utf-8", "replace")
            if PROMPT.search(ANSI.sub("", buf)):
                return ANSI.sub("", buf)
        elif time.time() > deadline:
            raise RuntimeError("prompt timeout; tail: " + buf[-300:])
        else:
            time.sleep(0.2)


wait_prompt(time.time() + 25)
failed = False
for cmd in cmds:
    lenient = cmd.startswith("-")
    if lenient:
        cmd = cmd[1:]
    ch.send(cmd + "\r")
    out = wait_prompt(time.time() + 60)
    print("### CMD: " + cmd)
    print(out)
    if CLI_ERROR.search(out) and not lenient:
        failed = True
ch.send("exit\r")
time.sleep(1)
cli.close()
sys.exit(2 if failed else 0)
