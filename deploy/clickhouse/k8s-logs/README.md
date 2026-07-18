# k8s-логи в ClickHouse — применение и деплой

Схема потока и стандарт полей: `docs/observability/k8s-logging-standard.md`.

## 1. ClickHouse (СДЕЛАНО в этой сессии)

`001_app_logs.sql` уже применён и верифицирован на живом CH `192.168.1.211:8123`
(`k8s.app_logs` + MV `k8s.app_logs_mv` + view + колонка `node` в `container_logs`).
Идемпотентно — повторный прогон безопасен:

```bash
# по одному выражению (HTTP-интерфейс CH не принимает мульти-стейтмент):
node -e '
const {readFileSync}=require("fs");
const sql=readFileSync("deploy/clickhouse/k8s-logs/001_app_logs.sql","utf8")
  .split("\n").filter(l=>!l.trimStart().startsWith("--")).join("\n")
  .split(";").map(s=>s.trim()).filter(Boolean);
(async()=>{for(const s of sql){const r=await fetch("http://192.168.1.211:8123/",{method:"POST",body:s});
  console.log(r.status, s.slice(0,60).replace(/\s+/g," "));}})();'
```

Проверка:
```
curl -s "http://192.168.1.211:8123/?query=SHOW+TABLES+FROM+k8s"
curl -s "http://192.168.1.211:8123/?query=SELECT+count()+FROM+k8s.app_logs"
```

## 2. Fluent Bit (ТРЕБУЕТ доступа к кластеру — НЕ применено в сессии)

Kubeconfig прод-кластера в этой сессии недоступен (`~/.kube/config` → localhost).
На машине с доступом к k3s (см. `deploy/k8s/README.md`, `$KUBECONFIG`):

```powershell
$env:KUBECONFIG = "K:\Роботы\Golang\git\server\albia\registry\kubeconfig"
kubectl apply -f deploy/k8s/60-k8s-logs-clickhouse.yaml
kubectl -n logging rollout restart ds/fluent-bit-clickhouse
kubectl -n logging rollout status  ds/fluent-bit-clickhouse
```

Смоук после деплоя (должны появиться структурные строки от Node-сервисов):
```
curl -s "http://192.168.1.211:8123/?query=SELECT+service,count()+FROM+k8s.app_logs+WHERE+ts>now()-INTERVAL+10+MINUTE+GROUP+BY+service+FORMAT+PrettyCompact"
# node проставлен?
curl -s "http://192.168.1.211:8123/?query=SELECT+DISTINCT+node+FROM+k8s.container_logs+WHERE+ts>now()-INTERVAL+10+MINUTE"
# метки пода доехали (kubernetes-фильтр)?
curl -s "http://192.168.1.211:8123/?query=SELECT+service,any(labels)+FROM+k8s.app_logs+WHERE+ts>now()-INTERVAL+10+MINUTE+GROUP+BY+service+FORMAT+Vertical"
```

Откат Fluent Bit: `git checkout <prev> deploy/k8s/60-k8s-logs-clickhouse.yaml && kubectl apply -f …`.
`k8s.container_logs`/`k8s.app_logs` при этом не затрагиваются (аддитивная схема).

## 3. Образы сервисов (ТРЕБУЕТ docker+registry+кластер — НЕ применено)

Структурные JSON-логи начнут поступать после пересборки образов с новым `shared/logging`:

```powershell
docker compose build orchestrator-service tools-service mcp-service
.\deploy\k8s\publish-images.ps1
kubectl -n ai-prod rollout restart deploy/orchestrator-service deploy/tools-service deploy/mcp-service
```

До пересборки: текстовые логи старых образов продолжают идти в сырой `container_logs`
(app_logs просто не наполняется от этих подов) — деградации нет.

## Переменные окружения логгера (shared/logging)

| Env | Дефолт | Назначение |
|---|---|---|
| `LOG_LEVEL` | info | trace/debug/info/warn/error/fatal — порог |
| `LOG_PRETTY` | авто | `1` — человекочитаемо, `0` — JSON (в проде JSON) |
| `LOG_MAX_MESSAGE` | 8192 | лимит длины message/строк |
| `SERVICE_NAME` | из кода | имя сервиса (переопределение) |
| `APP_CODE_VERSION` | — | версия сборки → `service_version` |
