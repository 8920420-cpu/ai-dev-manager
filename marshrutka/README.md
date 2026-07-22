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

## Вход для фронтов ПС: балансировщик Timeweb → k3s

Публичная точка входа сайтов — балансировщик Timeweb Cloud **«Humble Hoopoe»**
(id 134251, floating IP **186.246.1.150**, локация ru-3; управление — API-токен
`TIMEWEB_CLOUD_TOKEN` из `.env`, дубль в Key Store Semaphore
«timeweb-cloud-api (token)»). DNS сайтов наводить на 186.246.1.150.
Настроен 08.07.2026:

- правило `:80 (tcp) → server_port 30080 (tcp)` (id 185349), health-check
  `GET /healthz` (inter 10 c, rise 2 / fall 3), алгоритм roundrobin.
  ВНИМАНИЕ: изначально правило было `http`, но в http-режиме haproxy Timeweb
  **перехватывает путь `/.well-known/acme-challenge/*`** (под собственную
  LE-интеграцию LB) и отвечает 503 «No server is available», не пропуская
  challenge к бэкендам — HTTP-01 cert-manager из-за этого не проходил вовсе.
  08.07 переведено в `tcp` (L4-passthrough, PATCH /balancers/134251/rules/185349) —
  challenge стал доходить до ingress, сертификаты выпустились;
- правило `:443 (tcp) → server_port 30443 (tcp)` (id 185391, добавлено 08.07) —
  TLS-passthrough, терминация в ingress-nginx; на giga добавлен DNAT
  `ip static tcp ISP 30443 192.168.1.157 30443`. Сертификаты — cert-manager
  v1.20.3 в кластере (ClusterIssuer `letsencrypt-prod`, HTTP-01 через LB:80,
  манифест `cert-manager-issuer.yaml`): выпуск сработает сам после перевода
  DNS домена на 186.246.1.150, до этого Certificate в Pending и ingress отдаёт
  fake-cert. 08.07 выпущены pstroy-tls (приоритетстрой.рф) и pschat-tls
  (пс-чат.рф); clear36.ru/happypartyvrn.ru выпустятся сами, когда их DNS
  переведут на LB (пока смотрят на старые хостинги 176.57.66.144/185.215.4.51).
  При TLS на хосте ingress включает redirect 80→443 (308) — health
  `/healthz` не задет (default backend);
- **coredns-custom** (манифест `coredns-custom.yaml`): статичные A-записи
  доменов сайтов → 186.246.1.150 внутри кластера. Нужны, потому что self-check
  HTTP-01 у cert-manager ходит через DNS кластера, а апстрим-резолверы (giga/
  провайдер) держали старый A 195.98.86.63 с TTL 86400 — self-check упирался в
  старый nginx-146 (404) и challenge не отправлялся на валидацию. После
  протухания кэшей записи можно убрать (но не вредят: совпадают с публичным DNS);
- бэкенды — **белые IP трёх площадок** (решение: LB заходит на площадки
  снаружи через их WAN; VPN-сервер 72.56.73.96 бэкендом НЕ является):
  - **195.98.86.63** базовая (giga): DNAT `ip static tcp ISP 30080
    192.168.1.157 30080` → нода k3s — **работает** (сквозной путь подтверждён
    tcpdump'ом на ноде: src 186.246.1.150 приходит через WAN giga);
  - **5.187.76.240** Каскад и **188.235.1.207** Барикадная (psvrn) — прописаны
    «на вырост», health держит их в down: на площадках пока нет нод кластера,
    а NDMS не пробрасывает порты за site-to-site туннель. Когда появятся ноды
    (5.3 на Каскаде зарезервирована): на роутере `ip static tcp ISP 30080
    <локальная-нода> 30080` — и бэкенд поднимется сам. ВНИМАНИЕ: WAN обоих —
    DHCP, при смене белого IP обновить бэкенд через API balancers/…/ips;
- родной floating IP LB **85.198.81.20 был битым**: ICMP отвечал отовсюду, а
  TCP:80 проходил лишь из 2 точек мира из 12 (даже из Москвы — таймаут);
  до кучи ломался и исходящий путь LB → базовая. 08.07.2026 заменён через API
  floating-ips (unbind/bind, старый удалён) на 186.246.1.150 — TCP из 12/12
  точек, путь до базовой ожил. Симптом на будущее: «health зелёный, а сайт
  не открывается» → `check-host.net/check-tcp`;
- **timeweb-vpn (72.56.73.96)** — не бэкенд, но запасной вход в кластер
  оставлен: nginx `k3s-ingress` (80+30080 → upstream 10.10.8.8/.9:30080 через
  awg0); вернуть в LB при нужде: `POST …/ips {"ips":["72.56.73.96"]}`;
- в кластере развёрнут **ingress-nginx** (controller-v1.15.1, Service NodePort
  **30080/30443**) — фронты подключаются обычными Ingress-манифестами;
  `/healthz` его default-backend'а — общий health-эндпоинт всей цепочки;
- обе ноды k3s — пиры awg0 хаба timeweb-vpn: 157 = **10.10.8.8**, ВМ «ПС-2» =
  **10.10.8.9** (`awg-quick@awg0`, конфиги `/etc/amnezia/amneziawg/awg0.conf`
  на нодах; на хабе пиры `k3s-node-*` дописаны в `awg0.conf`, бэкап
  `awg0.conf.bak-20260708`).

**Каскад и Барикадная (psvrn) бэкендами быть пока не могут**: NDMS пробрасывает
порты только в собственные сегменты — DNAT в адрес за site-to-site туннелем
(проверено на Каскаде, NDMS 5.0.12) пакеты не пересылает, а SNAT для симметрии
ответа Keenetic не умеет. Станет возможно, когда на их площадках появятся ноды
кластера (нода 5.3 на Каскаде зарезервирована) — тогда DNAT в локальную ноду и
`POST /api/v1/balancers/134251/ips` с их белым IP. Диагностические правила с
Каскада откачены (`no ip static…30080/30081`, `no ip route 10.10.8.8…`).

Инструменты: `tools/kssh.py` — драйвер CLI Keenetic с хоста (аналог kssh.rb;
выручает, когда контейнер oxidized не видит 192.168.1.1: `RPASS=... python
tools/kssh.py 192.168.1.1 Semaphore "команда"`); `tools/kuma-add-balancer.js` —
мониторы Kuma на LB и оба бэкенда.

## Внутренняя DNS-зона ps.lan

Статические A-записи заведены на **всех трёх Keenetic** (giga/Каскад/ПС,
08.07.2026, `ip host <имя> <ip>` + `system configuration save`) — резолвятся
с любой площадки; при переезде машины правится одна запись на роутерах,
конфиги потребителей не трогаются:

| Имя | Адрес | Что это |
|---|---|---|
| `k3s-1.ps.lan` | 192.168.1.157 | нода k3s №1 (192.168.5.1, железо, базовая) |
| `k3s-2.ps.lan` | 192.168.1.213 | нода k3s №2 (192.168.5.2, ВМ «ПС-2» на 211) |
| `registry.ps.lan` | 192.168.1.211 | docker registry :5000 |
| `orchestrator.ps.lan` | 192.168.1.211 | оркестратор :4186 |
| `nginx-146.ps.lan` | 192.168.1.146 | главный nginx предприятия (ВМ) |

Правка записей: `RPASS=... python tools/kssh.py <роутер> <логин>
"ip host имя ip" "system configuration save"` — обязательно на всех трёх.

Потребители:

- **kubeconfig** (`F:\git\server\albia\registry\kubeconfig`) ходит на
  `https://k3s-1.ps.lan:6443`; имена `k3s-{1,2}.ps.lan` добавлены в `--tls-san`
  юнитов k3s обеих нод (бэкап старого kubeconfig — рядом,
  `kubeconfig.bak-ip-20260708`);
- **wg-cluster** (mesh кластера, UDP 51830) — dial-out схема: у каждой пары
  один звонящий (5.1→5.2 по `k3s-2.ps.lan`, будущая 5.3→обе, см.
  `server/www/scripts/wg-join.sh`), у принимающей стороны endpoint для
  звонящего НЕ прописан — его адрес учится по роумингу WireGuard из
  подписанных пакетов (проверено вживую 08.07: якорь 5.2 без endpoint выучил
  адрес 5.1 сам). Переезд ноды на другую площадку = обновить её `ip host`
  на роутерах; звонящие стороны ре-резолвят, принимающие выучат сами;
- на нодах зона прибита к giga drop-in'ом
  `/etc/systemd/resolved.conf.d/ps-lan.conf` (`DNS=192.168.1.1`,
  `Domains=~ps.lan`) — порядок DNS-серверов интерфейсов не влияет.

Pod-трафик flannel (wireguard-native, порт 51820) в зоне не нуждается:
endpoint'ы берутся из аннотаций нод и обновляются сами при старте k3s.

## Вотчдог бэкендов балансировщика

WAN Каскада и Барикадной — DHCP: белый IP может смениться, KeenDNS-имя
обновится, а бэкенд LB (только литеральные IP) — нет. Синхронизацию держит
`ansible/files/lb_sync_backends.py` (stdlib, без зависимостей): резолвит
`kaskadvrn`/`psvrn.keenetic.link`, сравнивает с `GET /balancers/134251/ips`,
добавляет новые и удаляет протухшие (сначала add, потом delete; 195.98.86.63
базовой — статика-константа `STATIC_IPS`). Если имя не резолвится — ничего не
меняет и падает красным. Запуск руками:
`TIMEWEB_CLOUD_TOKEN=... python ansible/files/lb_sync_backends.py [--dry-run]`.

В Semaphore («Маршрутка», id=2): шаблон **«Вотчдог бэкендов LB (Timeweb)»**
(id=5, плейбук `playbooks/lb-sync-backends.yml`), Environment `timeweb-cloud`
(id=2, несёт `TIMEWEB_CLOUD_TOKEN`), расписание `lb-sync-10min`
(`*/10 * * * *`). Проверен боевым запуском 08.07.2026 (task 14, success).

**Смена основного входа 14.07 → 20.07.2026.** 14.07 базовую giga временно
подменили на timeweb-vpn (`STATIC_IPS = {"72.56.73.96"}`): прямой giga-NAT давал
плавающие 504/долгий TTFB под конкурентной нагрузкой LB, а WG-релей держал
150/150. 20.07 вернули giga — приоритет у прямого входа на ноду базовой.
Вотчдог снёс оставшийся в LB 72.56.73.96, после чего тот вписан в
`KEEP_EXTRA` — аварийный возврат руками
(`POST …/ips {"ips":["72.56.73.96"]}`) теперь переживает вотчдог, но постоянным
бэкендом VPN не станет. Если после переключения вернутся 504/долгий TTFB —
это тот самый симптом 14.07.

**Грабля, из-за которой переключение 20.07 не состоялось с первого раза.**
Semaphore монтирует `/ansible` из **`F:\git\ai-dev-manager\marshrutka\ansible`**
(ro), а правится **`E:\git`** — это разные клоны на разных коммитах. Правку
20.07 сделали в E:, в F: осталась версия от 14.07, и вотчдог ещё 10 дней форсил
VPN бэкендом, а `195.98.86.63` (лежавший в `KEEP_EXTRA` — «не удалять», но и
«не добавлять») сам не вернулся. **После любой правки в `marshrutka/ansible/`
копировать файл в F:**, иначе Semaphore крутит старьё.

**Как диагностировать «health зелёный, а половина людей не заходит».** LB
роундробинит бэкенды поровну, а через WG-релей VPS статика идёт **~28 КБ/с
против ~620 КБ/с у giga** (замер на
`/sys/static/applications/bundled/checkBrowser.js`). `/healthz` — мелкий ответ и
проходит быстро при любой скорости, поэтому health остаётся зелёным, а
1С:Элемент с мегабайтами bundled-js у половины пользователей грузится минутами.
Мерить скорость на крупной статике, а не код ответа.

## Туннель Каскада до timeweb: релей через giga (22.07.2026)

22.07.2026 в 16:15 MSK лёг `Wireguard1` («timeweb-awg-kaskad», 10.10.8.7) на
Каскаде — тот, через который `dns-proxy route object-group domain-list0..6`
гонит обход блокировок (bungie, chatgpt, meta, steam, telegram, youtube,
claude.com). Симптом: `link: down`, txbytes растёт, **rxbytes ровно 0**.

**Диагноз — блокировка, а не поломка.** Дамп на самом хабе показал, что пакеты
Каскада доходят (junk-пачка + handshake initiation 260 байт каждые ~7 с) и хаб
отвечает (response 171 байт), но до роутера не доходит ни один ответ. ICMP и
TCP 443 от 72.56.73.96 при этом проходят, остальные 5 пиров хаба живут, второй
туннель Каскада `Wireguard0` (udp 9090 до giga) работает. Значит провайдер
Каскада режет UDP от адреса VPS. **Перебор портов бесполезен** — проверено на
42666, 443 и нейтральном 21823 (REDIRECT на VPS + `endpoint` у пира): ответ
хаба уходил, rx оставался 0. Конфиг роутера при этом не менялся (дифф с
бэкапом Oxidized от 16.07 чист), ребут не помогает, ACL `_MARSHRUTKA_ISP3`
заканчивается `permit ip any any` и UDP не трогает.

**Рабочий обход — релей за giga.** Каскад шлёт на `195.98.86.63:9099`, giga
пробрасывает (`ip static udp ISP 9099 192.168.1.211 9099`) на сервис
`awg-relay` этого же стека (socat, `docker-compose.yml`), тот пересылает на
`72.56.73.96:42666`. На хабе пир Каскада виден с адреса giga — не блокируемого,
— и туннель поднимается; доменные списки, MTU и всё остальное на Каскаде
остаются как были. Переключает пути вотчдог (ниже).

Тупики, которые проверены и отвергнуты (не повторять):

- **OpenConnect до giga** (`OpenConnect0` на Каскаде, юзер `Kaskad` с тегом
  `vpn-oc`) не поднять: внешний 443 у giga отдан кластеру
  (`ip static tcp ISP 443 192.168.1.213 30443`), клиент попадает в ingress-nginx
  и получает 404 + «certificate does not match SNI». Проброс `ISP 4443 →
  127.0.0.1:443` оживляет oc-server снаружи (проверено с VPS: отдаёт
  `config-auth`), но **с Каскада TCP 4443 таймаутит** — у него режется и это;
- **пустить `Wireguard1` внутрь туннеля WG0** нельзя: NDMS привязывает WG-пир к
  WAN (`via: GigabitEthernet0/Vlan2`) и игнорирует статический маршрут до
  endpoint'а — даже когда endpoint частный (192.168.1.211). По той же причине
  бесполезен `ip route <endpoint> … Wireguard0`;
- **DNAT на giga прямо в интернет** (`ip static udp ISP 9099 72.56.73.96 42666`)
  правило принимает, но не пересылает — NDMS не умеет SNAT для симметрии ответа
  (тот же ограничитель, что и с бэкендами LB выше);
- **перенос обхода на giga** (домены Каскада через `Wireguard0`, DNS на giga):
  giga не заворачивает транзит из туннеля в свой `Wireguard2` — сайт не
  открылся. Доменная маршрутизация Keenetic вообще не видна в `show ip route`,
  проверять её можно только реальным клиентом площадки.

### Вотчдог переключения путей

`ansible/files/kaskad_awg_failover.py` + `playbooks/kaskad-awg-failover.yml`,
шаблон Semaphore «Вотчдог туннеля Каскад → timeweb» (id=7), Environment
`kaskad-router` (id=4, несёт `RPASS`), расписание `kaskad-awg-10min`
(`*/10 * * * *`). Смотрит `show interface Wireguard1`: online — не трогает;
лежит — переставляет `endpoint` на другой путь (прямой `72.56.73.96:42666` ↔
релей `195.98.86.63:9099`) и делает `system configuration save`.

Обратно на прямой путь сам не возвращается (пока один из путей работает, на нём
и остаётся) — когда блокировку снимут, вернуть вручную:
`RPASS=… python tools/kssh.py 5.187.76.240 Semaphore "interface Wireguard1"
"wireguard peer Rq5d1vL2pMienYqhcqN1bXP0vMNUrqug3V+y25rkK0k="
"endpoint 72.56.73.96:42666" "exit" "exit" "system configuration save"`.

Проверка состояния: `RPASS=… KASKAD_HOST=5.187.76.240 python
ansible/files/kaskad_awg_failover.py --dry-run`.

## Порты подсистемы

4231 (Semaphore), 4232 (Kuma), 4233 (Oxidized REST/web), 4234-4235 (Gitea, опц.) —
диапазон выбран свободным от остальных сервисов машины (4186-4196 — оркестратор и раннеры).
