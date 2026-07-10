# Аналог marshrutka/tools/kssh.rb на Python/paramiko: интерактивный CLI Keenetic по SSH.
# Использование: python kssh.py <host> <user> <pass-env:RPASS> "cmd1" "cmd2" ...
import os
import re
import sys
import time

import paramiko

host, user = sys.argv[1], sys.argv[2]
password = os.environ["RPASS"]
cmds = sys.argv[3:]

PROMPT = re.compile(r"\([\w./-]+\)>\s*$")
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

cli = paramiko.SSHClient()
cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cli.connect(host, username=user, password=password, timeout=20,
            allow_agent=False, look_for_keys=False)
ch = cli.invoke_shell(term="vt100", width=200)


def wait_prompt(deadline):
    buf = ""
    while True:
        if ch.recv_ready():
            buf += ch.recv(65536).decode("utf-8", "replace")
            if PROMPT.search(ANSI.sub("", buf)):
                return buf
        elif time.time() > deadline:
            raise RuntimeError("prompt timeout; buf tail: " + buf[-200:])
        else:
            time.sleep(0.2)


wait_prompt(time.time() + 20)
for cmd in cmds:
    ch.send(cmd + "\r")
    out = wait_prompt(time.time() + 30)
    print("### CMD: " + cmd)
    print(ANSI.sub("", out))
ch.send("exit\r")
time.sleep(1)
cli.close()
