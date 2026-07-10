# Схема работы Kubernetes-кластера

Источник данных: `orchestrator_db`, снято из реальной БД 2026-07-08 через контейнер `infra-patroni1-1`.

Важное ограничение: в БД нет отдельных таблиц Kubernetes-объектов (`Ingress`, `Service`, `Pod`, `Node`). Поэтому внешний контур кластера взят из текущих k8s-манифестов `deploy/k8s`, а сервисный слой, проекты, зависимости, роли, задачи и подключение к БД подписаны фактическими строками из `orchestrator_db`.

```mermaid
flowchart TB
  user["Пользователь / клиент"]
  lb["Cloudflare / внешний балансировщик"]

  subgraph cluster[Kubernetes k3s cluster: ai-prod]
    direction TB

    subgraph nodes["3 ноды с белыми IP"]
      n1["Нода 1\ningress-nginx DaemonSet\nhostPort 80/443"]
      n2["Нода 2\ningress-nginx DaemonSet\nhostPort 80/443"]
      n3["Нода 3\ningress-nginx DaemonSet\nhostPort 80/443"]
    end

    ing["Ingress ai-prod\nhost: orchestrator.example.com\nTLS: origin-ca-tls"]

    svc_orch["Service orchestrator-service:80"]
    pod_orch["Deployment orchestrator-service\nreplicas: 1\nRUNNER_ENABLED=true"]

    svc_tools["Service tools-service:4188\nвнутренний сервис"]
    pod_tools["Deployment tools-service\nreplicas: 1\nhostPath /srv/projects -> /projects"]

    subgraph app_data["Данные из orchestrator_db"]
      db_projects["projects\n2 активных проекта:\nPROJECT Оркестратор\nPROJECT_2 ПС"]
      db_services["services\n45 сервисных записей"]
      db_tasks["tasks\n13 638 задач всего\n340 активных"]
      db_roles["roles/connectors\n19 ролей, 1 MCP-роль\n5 коннекторов включено"]
      db_deps["service_dependencies\n3 зависимости:\nCatalog_Service -> IAM_Service GRPC\nChat_Service -> Connector_Service REST\nChat_Service -> IAM_Service GRPC"]
    end

    subgraph pg["PostgreSQL в кластере"]
      pg_rw["Service pg-main-rw:5432\nprimary / write"]
      pg_ro["Service pg-main-ro:5432\nread replicas"]
      pg_cluster["CNPG Cluster pg-main\ninstances: 3\nDB: orchestrator_db\nowner: orchestrator\nstorage: local-path 20Gi"]
      pg1["pg-main pod primary"]
      pg2["pg-main pod replica"]
      pg3["pg-main pod replica"]
    end
  end

  subgraph current_db["Текущая реальная БД, откуда взяты подписи"]
    haproxy["infra-haproxy-1:5000\nлокально опубликовано 127.0.0.1:5432/6432"]
    pgbouncer["infra-pgbouncer-1:5432"]
    patroni["infra-patroni1-1\nPostgreSQL 16 / Patroni"]
    realdb[(orchestrator_db)]
    dbconn["database_connections\ninfra-postgres (orchestrator_db)\nhost infra-postgres-1:5432\nuser postgres\nssl disable"]
  end

  user --> lb
  lb --> n1
  lb --> n2
  lb --> n3
  n1 --> ing
  n2 --> ing
  n3 --> ing
  ing --> svc_orch
  svc_orch --> pod_orch

  pod_orch --> svc_tools
  svc_tools --> pod_tools

  pod_orch --> pg_rw
  pg_rw --> pg_cluster
  pg_ro --> pg_cluster
  pg_cluster --> pg1
  pg_cluster --> pg2
  pg_cluster --> pg3
  pg1 -. WAL replication .-> pg2
  pg1 -. WAL replication .-> pg3

  pod_orch -. читает/пишет .-> db_projects
  db_projects --> db_services
  db_services --> db_tasks
  db_services --> db_deps
  db_tasks --> db_roles

  dbconn --> haproxy
  haproxy --> pgbouncer
  pgbouncer --> patroni
  patroni --> realdb
  realdb -. источник фактических подписей .-> app_data
```

## Факты из БД

| Область | Факт |
| --- | --- |
| Проекты | `PROJECT` (`Оркестратор`), `PROJECT_2` (`ПС`), оба `active` |
| Root paths | `F:\git\ai-dev-manager`, `F:\git\PS` |
| Подключение к БД | `infra-postgres (orchestrator_db)` -> `infra-postgres-1:5432/orchestrator_db`, `ssl_mode=disable` |
| Сервисы | 45 записей в `services` |
| Задачи | `PROJECT`: 2912 всего / 154 активных; `PROJECT_2`: 10726 всего / 186 активных |
| Роли и коннекторы | 19 ролей, 1 MCP-роль, 5 включенных коннекторов |
| Deployments в БД | 0 записей |

## Самые активные сервисы по задачам

| Проект | Сервис | Активные | Всего |
| --- | --- | ---: | ---: |
| `PROJECT` | `orchestrator-service` | 7 | 103 |
| `PROJECT` | `host-runner` | 2 | 12 |
| `PROJECT_2` | `catalog_service` | 2 | 11 |
| `PROJECT_2` | `front_salesflow` | 2 | 6 |
| `PROJECT` | `PIPELINE_RUNNER` | 1 | 5 |
| `PROJECT` | `pipeline-runner` | 1 | 4 |
| `PROJECT_2` | `Mail/Mail_Service` | 1 | 4 |

## Поток запроса

1. Пользователь приходит на Cloudflare / внешний балансировщик.
2. Балансировщик отправляет HTTPS на белый IP любой из трех нод.
3. На каждой ноде слушает `ingress-nginx` как DaemonSet через `hostPort 80/443`.
4. `Ingress ai-prod` по host `orchestrator.example.com` ведет на `Service orchestrator-service:80`.
5. `orchestrator-service` работает в одном pod и обращается к:
   - `tools-service:4188` внутри кластера;
   - `pg-main-rw:5432` для записи в PostgreSQL;
   - таблицам `projects`, `services`, `tasks`, `roles`, `connectors` внутри `orchestrator_db`.
6. PostgreSQL в k8s описан как CNPG `pg-main` из 3 экземпляров: primary + 2 streaming replicas.
