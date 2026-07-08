# Маршрутка — подсистема управления роутерами и серверами

Отдельный docker-стек для управления тремя (и более) роутерами и внешними
серверами: плейбуки, бэкапы конфигов в git, мониторинг живости.

## Состав

| Сервис | Что делает | Порт |
|---|---|---|
| **Semaphore UI** | Ansible с веб-интерфейсом: запуск плейбуков кнопкой, расписания, история, хранилище секретов | http://localhost:4231 |
| **Uptime Kuma** | Мониторинг живости роутеров (ping/TCP), алерты (Telegram и др.) | http://localhost:4232 |
| **Oxidized** | Автобэкап конфигов роутеров по SSH → git с диффами (наследник RANCID) | http://localhost:4233 |
| **Gitea** (опц.) | Свой веб-git, профиль `git-server` | http://localhost:4234 |

Отличия от исходной идеи «голый Ansible + git руками»:

- Ansible обёрнут в **Semaphore** — не надо ходить в консоль контейнера, есть история запусков и cron-расписания.
- Хранение конфигов в git делает **Oxidized автоматически**: раз в час снимает конфиг с каждого роутера и коммитит только при изменениях — получается журнал «кто когда что поменял» с диффами.
- **NetBox** сознательно не развёрнут (тянет postgres+redis+worker) — на 3 роутера избыточен. Когда сетей/IP станет много: `https://github.com/netbox-community/netbox-docker`, поднять рядом с профилем `ipam`.
- Плейбуки пишет Claude Code прямо в `marshrutka/ansible/` — каталог примонтирован в Semaphore как локальный репозиторий `/ansible`.

## Быстрый старт

```powershell
cd k:\Роботы\Golang\git\ai-dev-manager\marshrutka
copy .env.example .env    # поменять пароль админа Semaphore
docker compose up -d
```

Дальше руками (один раз):

1. **Заполнить реальные адреса/учётки роутеров** (внесены: №1 «Каскад» — kaskadvrn.keenetic.link по SSH; №2 «Giga» — Keenetic Giga KN-1012, шлюз LAN 192.168.1.1, по SSH (security-level private — только LAN; telnet оставлен запасным); №3 «ПС» — psvrn.keenetic.link, Keenetic Voyager Pro KN-3510, по SSH, зажат таким же ACL, как «Каскад»). `oxidized/router.db` содержит пароли и НЕ в git — шаблон: `router.db.example`.
   - `oxidized/router.db` — формат `имя:ip:модель:логин:пароль`; поле `ip` принимает только литеральный IP — для DNS-имени (KeenDNS) писать его в поле `имя`, а `ip` оставлять пустым; после правки `docker restart marshrutka-oxidized`;
   - `ansible/inventory/hosts.yml` — адреса + при необходимости `ansible_network_os`.
   - Keenetic: модель Oxidized — `ndms`; встроенная умеет только telnet, поддержка SSH добавлена кастомной моделью `oxidized/model/ndms.rb`. На самом роутере нужны: компонент `ssh` (ставится с перепрошивкой и перезагрузкой!), `service ssh` в конфиге (без него порт закрыт), право пользователя «Доступ к командной строке».
   - На «Каскаде» и «ПС» доступ снаружи зажат ACL `_MARSHRUTKA_ISP3` на WAN-интерфейсе («Каскад» — GigabitEthernet0/Vlan2, «ПС» — ISP): SSH 22 — только с наших IP (72.56.73.96 и 195.98.86.63 — у нашего провайдера разные адреса на разные направления!), 23/80 закрыты всем, 443 открыт. Кроме того, на обоих telnet-демон выключен совсем (`no service telnet`) — плейнтекст-доступ не светится и в LAN/туннель; на Giga telnet оставлен (LAN-only, запасной вход). CLI-драйверы для ручного управления — `tools/kssh.rb` (SSH, основной) и `tools/kcli.rb` (telnet, для устройств без SSH); запуск: `docker cp tools/kssh.rb marshrutka-oxidized:/tmp/ && docker exec -e RHOST=... -e RUSER=... -e RPASS=... marshrutka-oxidized sh -c 'ruby /tmp/kssh.rb "show system"'`.
2. **Uptime Kuma** (4232): админ создан, мониторы добавлены через socket.io API (04.07.2026): «Каскад» и «ПС» ping/SSH-порт/веб (интервал 60 с), «Giga» ping/веб/SSH + Semaphore и Oxidized через `host.docker.internal`, «Timeweb VPN» ping/SSH (08.07.2026) — итого 13. Не настроены уведомления (нужен Telegram-бот: токен + chat_id). Скрипты — `tools/kuma-setup.js`, `kuma-add-giga.js`, `kuma-giga-ssh.js`, `kuma-add-psvrn.js`, `kuma-add-timeweb.js` (запуск: `KUMA_PASS=... node <скрипт>`, нужен `npm i socket.io-client`). Пароль админа Kuma ≠ паролю Semaphore и в git не хранится. Грабли запуска: корневой `package.json` репозитория объявляет `type: module`, поэтому `.js`-скрипты внутри репо Node считает ESM — копировать во внешний каталог как `.cjs` и запускать оттуда.
3. **Semaphore** (4231, логин из `.env`): проект «Маршрутка» уже создан и заполнен через API (04.07.2026): Repository Local `/ansible`, Inventory File `inventory/hosts.yml` (+ключи router-kaskad/router-psvrn/router-giga, логины/пароли — те же, что в `oxidized/router.db`), шаблоны «Проверка доступности роутеров» (проверена, success) и два примера для MikroTik. Новые плейбуки: положить в `ansible/playbooks/` и добавить Task Template.
   - **Серверы** (группа `servers` в инвентаре) — полноценные Linux-хосты, Ansible ходит на них нативно по SSH. Первый: `timeweb-vpn` — VPS Timeweb Cloud (id 6276613, 72.56.73.96, Ubuntu 24.04, hostname 6276613-se625534), на нём живёт AmneziaWG (`awg0`, 10.10.8.1/24) — его конфигурацию не трогать без надобности. Доступ: ключ `marshrutka/keys/timeweb_ed25519` (каталог `keys/` в `.gitignore`), публичная часть добавлена root'у через панель Timeweb 08.07.2026; приватная — в Key Store Semaphore («server-timeweb-vpn (root)», тип ssh) и привязана к инвентарю (`ssh_key_id`; роутерам не мешает — они `connection: local`, до 08.07.2026 там висел парольный `router-kaskad`). В `check-alive.yml` для группы `servers` есть вторая игра с реальным SSH-заходом (`ansible.builtin.ping`); грабли: локальная игра обязана исполняться `ansible_playbook_python`, а серверам нужен явный `ansible_python_interpreter: /usr/bin/python3` — иначе interpreter discovery кэширует venv-путь Semaphore и SSH-игра падает с «module interpreter not found».
   - **Ключи шифрования** (`SEMAPHORE_ACCESS_KEY_ENCRYPTION` и пара cookie-ключей) обязаны быть зафиксированы в `.env`: без них entrypoint генерирует случайные при каждом пересоздании контейнера, и все секреты Key Store перестают расшифровываться («cannot decrypt access key», задачи падают на Preparing). Инцидент случился и починен 08.07.2026 — ключ запинен в `.env`, секреты перезаписаны. Env-переменные перекрывают сгенерированный `/etc/semaphore/config.json` (проверено пересозданием). При обновлении секрета через API нужен флаг `override_secret: true`, иначе PUT молча игнорирует пароль.

## Плейбуки

- `playbooks/check-alive.yml` — вендоро-независимая проверка: ping + открыт ли SSH;
- `playbooks/server-harden.yml` — харденинг Linux-серверов группы `servers` (шаблон «Харденинг серверов», расписание вс 05:30): sshd только по ключам (файл `40-hardening.conf` — имя обязано сортироваться раньше cloud-init'овского `50-…`, у sshd выигрывает первое значение), ufw c `DEFAULT_FORWARD_POLICY=ACCEPT` (транзит VPN не трогается — форвардингом рулят PostUp-правила Amnezia), 22/tcp + 42666/udp открыты, Zabbix 10050 только с мониторинга Timeweb (92.53.116.12/.111/.119), fail2ban (backend=systemd — на minimal-образах нет auth.log), swap 1 ГБ, `chmod 600` и fetch-бэкап `awg0.conf` в `ansible/backups/<host>/` (каталог в `.gitignore` — там ключи; в контейнер смонтирован отдельным rw-маунтом поверх ro `/ansible`). Применён к timeweb-vpn 08.07.2026 (+ apt full-upgrade и ребут — dkms-модуль amneziawg пересобрался, туннель поднялся сам);
- `playbooks/routeros-facts.yml` — сводка по железу/версии (MikroTik);
- `playbooks/routeros-export.yml` — ручной текстовый `/export` конфига (MikroTik).

Для Cisco/OpenWrt/Keenetic — поменять `ansible_network_os`/`ansible_connection`
в инвентаре (заготовки в комментариях) и модель в `oxidized/router.db`.

## Где лежат конфиги роутеров

Oxidized коммитит в bare-репозиторий `oxidized/configs.git` (в git основного репо
не попадает — в `.gitignore`, там пароли/ключи). Посмотреть историю:

```powershell
docker exec marshrutka-oxidized git -C /home/oxidized/.config/oxidized/configs.git log --stat
docker exec marshrutka-oxidized git -C /home/oxidized/.config/oxidized/configs.git show HEAD
```

Оттуда же можно `git push` на приватный remote (например, в Gitea: `docker compose --profile git-server up -d`).

## Порты подсистемы

4231 (Semaphore), 4232 (Kuma), 4233 (Oxidized REST/web), 4234-4235 (Gitea, опц.) —
диапазон выбран свободным от остальных сервисов машины (4186-4196 — оркестратор и раннеры).
