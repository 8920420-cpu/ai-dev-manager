# Прод-деплой в k3s (шаги 5–6)

Продолжение `docs/SERVER_PXE_RUNBOOK.md`: кластер уже развёрнут
`provision-k3s.sh` (3 ноды, traefik отключён), kubeconfig лежит в
`$SERVER_DATA_ROOT/albia/registry/kubeconfig`.

Схема: Cloudflare → белые IP нод → **nginx на каждой ноде** (ingress-nginx
DaemonSet, hostPort 80/443) → Ingress-правила по доменам → сервисы.
Postgres — кластер CNPG `pg-main`: primary + 2 streaming-реплики, по одной
на ноду, репликация по LAN, кворумная синхронность (`synchronous: any 1`).

## Порядок

```powershell
$env:KUBECONFIG = "K:\Роботы\Golang\git\server\albia\registry\kubeconfig"

# 1. Локальный registry на PXE-хосте (если ещё не поднят):
docker compose --env-file .env -f server/docker-compose.yml --profile registry up -d registry

# 2. Собрать и опубликовать образы:
docker compose build
.\deploy\k8s\publish-images.ps1            # registry берётся из .env

# 3. Задать реальные значения:
#    - kustomization.yaml: apiToken (секрет orchestrator-secrets), registry/tag
#    - 50-ingress.yaml: домены вместо example.com
#    - TLS-секрет из сертификата Cloudflare Origin CA:
kubectl -n ai-prod create secret tls origin-ca-tls --cert=origin.pem --key=origin-key.pem

# 4. Применить (первый раз операторы ставятся пару минут; CRD Cluster
#    появится после старта cnpg — при ошибке про unknown kind повторить):
kubectl apply -k deploy/k8s
kubectl -n ai-prod get pods -w
```

## Миграция данных Postgres

Данные текущего однонодового Patroni переносятся дампом (объём БД небольшой):

```powershell
docker exec infra-patroni1-1 pg_dump -U postgres -d orchestrator_db -Fc -f /tmp/orch.dump
docker cp infra-patroni1-1:/tmp/orch.dump .
kubectl -n ai-prod cp orch.dump pg-main-1:/tmp/orch.dump
kubectl -n ai-prod exec pg-main-1 -- pg_restore -U postgres -d orchestrator_db --no-owner --role=orchestrator /tmp/orch.dump
```

Перед переносом остановить оркестратор (docker), после — переключить трафик.

## Cloudflare

- DNS-записи доменов (проксируемые) → белые IP всех трёх нод; или Cloudflare
  Load Balancer с health-check `https://<ip>/health` по каждой ноде.
- SSL/TLS mode: **Full (strict)**; на нодах сертификат Origin CA
  (секрет `origin-ca-tls`).
- На нодах ограничить 80/443 диапазонами Cloudflare, 22/6443 — только LAN.

## Замечания

- `tools-service` монтирует `/srv/projects` (hostPath) — на прод-нодах
  каталог пуст, пока туда не склонированы проекты; наружу сервис не
  публикуется.
- `orchestrator-service` — replicas: 1 (внутренний runner не проверялся в
  несколько экземпляров).
- PS-стек (ps-torg и остальное из докера) переезжает по этому же образцу:
  Deployment+Service+Ingress-host на сервис, образы через `publish-images.ps1`
  (добавить имена в список `$images`).
