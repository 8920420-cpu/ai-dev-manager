# Подсистема Server: PXE → Albia → k3s

Подсистема живёт в `server/docker-compose.yml`. Целевая схема:

```
чистое железо ──PXE──> Ubuntu autoinstall ──firstboot──> регистрация в Albia
Albia (ssh-ключ) ──provision-k3s.sh──> HA-кластер k3s из 3 нод (embedded etcd)
локальный registry (:5000) ──> образы прод-версий сервисов ──> кластер
Cloudflare ──> белые IP нод ──> nginx на каждой ноде (ingress-nginx) ──> сервисы
LAN ──> etcd, flannel, репликация Postgres (наружу не выходит)
```

Сервисы compose:

- `render` — одноразовый шаг: рендерит `server/www/*` (шаблоны в git) в
  `$SERVER_DATA_ROOT/www` (боевые файлы), подставляя `PXE_SERVER_IP`,
  `PXE_HTTP_PORT`, `ALBIA_PORT` и публичный ключ из
  `$SERVER_DATA_ROOT/ssh/admin_ed25519.pub`. `nginx` стартует только после
  успешного рендера. Файлы в data-root руками больше не редактируются.
- `albia` — обёртка над образом Albia: приём регистраций
  (`POST /cgi-bin/register` → `registry/nodes.jsonl`) и скрипт
  `provision-k3s.sh` (ssh/curl/jq включены в образ).
- `dnsmasq` — DHCP + PXE + TFTP (host network).
- `nginx` — iPXE-скрипт, ISO/casper, autoinstall seed, firstboot.
- `registry` (профиль `registry`) — локальный Docker registry `:5000`,
  данные в `$SERVER_DATA_ROOT/registry`.
- `netbootxyz` (профиль `netbootxyz`) — опционально.

## Настройка

В `.env`:

```env
SERVER_DATA_ROOT=K:\Роботы\Golang\git\server   # обязательно ВНЕ репозитория
PXE_SERVER_IP=192.168.2.200                    # LAN IP докер-хоста
PXE_ROUTER=192.168.2.1
PXE_DNS=192.168.2.1
PXE_DHCP_RANGE=192.168.2.201,192.168.2.240,12h
PXE_HTTP_PORT=8087
ALBIA_PORT=8092
# REGISTRY_PORT=5000
```

Порты нигде больше не хардкодятся: `boot.ipxe`, `autoinstall/user-data` и
`scripts/firstboot.sh` — шаблоны, значения подставляет `render` из `.env`.

`dnsmasq` работает в host-сети, потому что DHCP-broadcast должен достигать
физической LAN. Запускайте только в сегменте провижининга и следите, чтобы
там не было конкурирующего DHCP.

> **ВАЖНО (Windows-хост):** на Docker Desktop/WSL2 «host»-сеть — это сеть
> внутренней VM (192.168.65.x за NAT), DHCP-broadcast и TFTP из физической
> LAN до dnsmasq **не доходят** (проверено: на Windows-хосте порт 69/UDP не
> слушается). Поэтому классический PXE с этого хоста не работает; основной
> путь загрузки — **iPXE-носитель** (см. раздел ниже). TCP-порты (8087,
> 8092, 5000) Docker Desktop пробрасывает на LAN корректно. dnsmasq
> пригодится, только если подсистему перенесут на Linux-хост.

## Ассеты

`$SERVER_DATA_ROOT/tftp/`: `undionly.kpxe`, `ipxe.efi`, `ipxe-arm64.efi`.
`$SERVER_DATA_ROOT/www/ubuntu/24.04/`: `ubuntu-live-server.iso`,
`casper/vmlinuz`, `casper/initrd`.
`$SERVER_DATA_ROOT/ssh/`: `albia_provision_ed25519` + `.pub` — ключ, которым
Albia ходит на ноды (публичный попадает в autoinstall через render).
**Обязательно без пассфразы**: albia использует его неинтерактивно
(старый `admin_ed25519` зашифрован пассфразой и автоматикой не используется).

Замечания:

- Secure Boot на нодах нужно выключить: iPXE-бинарники не подписаны.
- Пароль в `server/www/autoinstall/user-data` (`identity.password`) — хэш;
  вход по паролю выключен (`allow-pw: false`), доступ только по ключу.
- Hostname нода получает уникальный: `node-<последние 6 hex MAC>` —
  обязательно для k8s (три `ubuntu-server` в кластер не соберутся).

## Запуск

```powershell
docker compose --env-file .env -f server/docker-compose.yml up -d nginx dnsmasq albia
# render выполнится автоматически перед nginx; отдельно: ... up render
# локальный registry (см. миграцию ниже):
docker compose --env-file .env -f server/docker-compose.yml --profile registry up -d registry
```

Поток загрузки чистого сервера: iPXE (с носителя или по PXE) → HTTP
`/boot.ipxe` → Ubuntu autoinstall → первый бут запускает `albia-firstboot`,
нода регистрируется в Albia (`nodes.jsonl`: hostname, primaryIp, allIps,
serial и т.д.).

## Загрузка с iPXE-носителя (основной путь на Windows-хосте)

DHCP/TFTP с Windows-хоста не работают (см. выше), поэтому сервер грузится
с флешки/ISO iPXE со встроенным скриптом `dhcp` + `chain
http://<PXE_SERVER_IP>:<PXE_HTTP_PORT>/boot.ipxe` — дальше всё идёт по
HTTP как обычно. Носитель нужен только на время установки.

Сборка (готовые файлы кладутся в `$SERVER_DATA_ROOT/boot-media/`):

```bash
PXE_SERVER_IP=192.168.2.200 PXE_HTTP_PORT=8087 \
  OUT_DIR="K:/Роботы/Golang/git/server/boot-media" \
  sh server/scripts/build-ipxe-media.sh
```

- **UEFI** (типичный случай): FAT32-флешка, файл `ipxe.efi` → `EFI/BOOT/BOOTX64.EFI`.
  Secure Boot выключить.
- **BIOS/legacy**: `ipxe.iso` записать Rufus'ом (режим DD) или на CD.

Плюс такого пути: в LAN не появляется второй DHCP-сервер.

### Миграция ad-hoc registry

Сейчас на хосте крутится контейнер `local-registry` (registry:2, порт 5000),
запущенный руками, с данными в анонимном volume. Сервис `registry` в compose
— его кодифицированная замена. Перенос: остановить `local-registry`,
поднять профиль `registry`, перезалить образы (`docker push
localhost:5000/albia:latest` и т.д.). Одновременно оба не поднимутся —
конфликт порта 5000.

## Развёртывание k3s (Albia)

Когда все три ноды зарегистрированы:

```powershell
docker exec albia provision-k3s.sh                    # ноды из nodes.jsonl
docker exec albia provision-k3s.sh 192.168.2.51 192.168.2.52 192.168.2.53
```

Скрипт по ssh (ключ `ssh/admin_ed25519`):

1. пишет `/etc/rancher/k3s/registries.yaml` — доверие к
   `http://$PXE_SERVER_IP:5000` (локальный registry);
2. первая нода: `k3s server --cluster-init --node-ip <LAN-IP>`;
3. остальные: `k3s server --server https://<нода1>:6443` (HA, embedded etcd);
4. сохраняет токен и kubeconfig в `$SERVER_DATA_ROOT/albia/registry/`
   (`k3s-token`, `kubeconfig`).

Штатный traefik отключён (`--disable traefik`): ingress — свой nginx на
каждой ноде (ingress-nginx DaemonSet, hostPort 80/443), ставится манифестом
`deploy/k8s/10-ingress-nginx.yaml`.

Важно: передавайте **LAN-адреса** — `--node-ip` фиксирует etcd/flannel и весь
межнодовый трафик (включая репликацию Postgres) в локальной сети. Белые IP в
кластерный трафик не попадают. Доп. SAN для API-сертификата:
`docker exec -e K3S_TLS_SAN_EXTRA=203.0.113.10,203.0.113.11 albia provision-k3s.sh ...`.

## Внешний трафик: Cloudflare → белые IP

У каждой ноды свой белый IP; балансировщик — Cloudflare:

- На каждой ноде свой nginx (ingress-nginx DaemonSet, hostPort 80/443) —
  маршрутизирует запросы по микросервисам согласно Ingress-правилам
  (`deploy/k8s/50-ingress.yaml`).
- DNS-записи доменов (проксируемые, «оранжевое облако») → три белых IP
  (round-robin) или Cloudflare Load Balancer с health-check по каждому IP.
- Режим TLS — **Full (strict)**: на ingress ставится сертификат Cloudflare
  Origin CA (секрет `origin-ca-tls`). Не «Flexible» — иначе от CF до нод
  пойдёт открытый HTTP.
- На нодах ограничить 80/443 диапазонами Cloudflare (ufw), 6443/22 — только
  из LAN. Postgres наружу не публикуется вообще.

## Прод в кластере (шаги 5–6): deploy/k8s/

Полный порядок — `deploy/k8s/README.md`:

1. **Публикация образов**: `deploy/k8s/publish-images.ps1` — retag+push
   локальных образов в `$PXE_SERVER_IP:5000` (ноды доверяют registry через
   `registries.yaml`).
2. **Манифесты** (`kubectl apply -k deploy/k8s`): ingress-nginx (DaemonSet),
   оператор CloudNativePG, кластер Postgres `pg-main`, orchestrator/tools/mcp,
   Ingress по доменам. PS-стек переезжает по тому же образцу.
3. **Postgres**: CNPG-кластер — primary + 2 streaming-реплики по одной на
   ноду, репликация по LAN, кворумная синхронность. Текущий однонодовый
   Patroni в `infra` остаётся дев-средой; перенос данных — pg_dump/pg_restore
   (см. README).
