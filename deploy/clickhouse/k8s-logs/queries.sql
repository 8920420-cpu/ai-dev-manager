-- LOGGING-STANDARD-001 — готовые запросы по логам k8s (таблицы k8s.app_logs — структурные,
-- k8s.container_logs — сырой поток). Замените плейсхолдеры {service}/{from}/{to}/{trace} и т.п.

-- 1. Все ошибки конкретного сервиса за период.
SELECT ts, level, event_code, error_code, error_message, trace_id, pod
FROM k8s.app_logs
WHERE service = {service:String} AND level IN ('error','fatal')
  AND ts BETWEEN {from:DateTime} AND {to:DateTime}
ORDER BY ts DESC LIMIT 500;

-- 2. Все события одного trace_id (сквозь сервисы).
SELECT ts, service, level, event_code, operation, status, duration_ms, message
FROM k8s.app_logs
WHERE trace_id = {trace:String}
ORDER BY ts ASC;

-- 3. Полная цепочка запроса между микросервисами (span-дерево по trace).
SELECT ts, service, span_id, parent_span_id, operation, status_code, duration_ms
FROM k8s.app_logs
WHERE trace_id = {trace:String} AND event_category = 'http.request'
ORDER BY ts ASC;

-- 4. Наиболее частые error_code.
SELECT error_code, error_type, count() AS n, any(operator_hint) AS hint
FROM k8s.app_logs
WHERE level IN ('error','fatal') AND ts >= now() - INTERVAL 24 HOUR AND error_code != ''
GROUP BY error_code, error_type ORDER BY n DESC LIMIT 50;

-- 5. Новые error_code, которых не было в предыдущем окне.
SELECT error_code, min(ts) AS first_seen, count() AS n
FROM k8s.app_logs
WHERE level IN ('error','fatal') AND ts >= now() - INTERVAL 6 HOUR AND error_code != ''
  AND error_code NOT IN (
    SELECT DISTINCT error_code FROM k8s.app_logs
    WHERE ts BETWEEN now() - INTERVAL 7 DAY AND now() - INTERVAL 6 HOUR AND error_code != '')
GROUP BY error_code ORDER BY first_seen DESC;

-- 6. Ошибки после нового деплоя (по смене service_version).
SELECT service, service_version, countIf(level IN ('error','fatal')) AS errors, count() AS total,
       round(countIf(level IN ('error','fatal'))/count(),4) AS ratio
FROM k8s.app_logs
WHERE ts >= now() - INTERVAL 3 HOUR
GROUP BY service, service_version ORDER BY service, service_version;

-- 7. Медленные HTTP-запросы.
SELECT ts, service, route, status_code, duration_ms, trace_id
FROM k8s.app_logs
WHERE event_category = 'http.request' AND duration_ms > {slow_ms:Float64}
  AND ts >= now() - INTERVAL 1 HOUR
ORDER BY duration_ms DESC LIMIT 100;

-- 8. Медленные gRPC-вызовы (когда появятся gRPC-сервисы).
SELECT ts, service, operation, duration_ms, status, trace_id
FROM k8s.app_logs
WHERE protocol = 'grpc' AND duration_ms > {slow_ms:Float64} AND ts >= now() - INTERVAL 1 HOUR
ORDER BY duration_ms DESC LIMIT 100;

-- 9. Медленные запросы к БД.
SELECT ts, service, operation, duration_ms, attributes['db_statement'] AS stmt, trace_id
FROM k8s.app_logs
WHERE event_category = 'database.query' AND duration_ms > {slow_ms:Float64}
  AND ts >= now() - INTERVAL 1 HOUR
ORDER BY duration_ms DESC LIMIT 100;

-- 10. Ошибки внешних интеграций.
SELECT ts, service, attributes['dependency_name'] AS dep, error_code, error_message, trace_id
FROM k8s.app_logs
WHERE event_category = 'external_api.request' AND level IN ('error','fatal')
  AND ts >= now() - INTERVAL 6 HOUR
ORDER BY ts DESC LIMIT 200;

-- 11. Количество retry.
SELECT service, operation, sum(retry_count) AS retries, count() AS ops
FROM k8s.app_logs
WHERE retry_count > 0 AND ts >= now() - INTERVAL 6 HOUR
GROUP BY service, operation ORDER BY retries DESC LIMIT 50;

-- 12. Ошибки по tenant_id.
SELECT tenant_id, count() AS errors, uniqExact(error_code) AS distinct_codes
FROM k8s.app_logs
WHERE level IN ('error','fatal') AND tenant_id != '' AND ts >= now() - INTERVAL 24 HOUR
GROUP BY tenant_id ORDER BY errors DESC LIMIT 50;

-- 13. Ошибки конкретной бизнес-сущности.
SELECT ts, service, event_code, error_code, error_message, trace_id
FROM k8s.app_logs
WHERE entity_type = {entity_type:String} AND entity_id = {entity_id:String}
ORDER BY ts DESC LIMIT 200;

-- 14. Последовательность изменения документа/сущности.
SELECT ts, service, event_code, status, user_id, trace_id
FROM k8s.app_logs
WHERE entity_id = {entity_id:String} AND event_category NOT IN ('http.request')
ORDER BY ts ASC;

-- 15. Ошибки по pod и node.
SELECT node, pod, service, count() AS errors
FROM k8s.app_logs
WHERE level IN ('error','fatal') AND ts >= now() - INTERVAL 6 HOUR
GROUP BY node, pod, service ORDER BY errors DESC LIMIT 100;

-- 16. Сравнение версий микросервиса (латентность/ошибки).
SELECT service_version, count() AS events,
       round(quantile(0.95)(duration_ms)) AS p95_ms,
       round(countIf(level IN ('error','fatal'))/count(),4) AS error_ratio
FROM k8s.app_logs
WHERE service = {service:String} AND ts >= now() - INTERVAL 2 DAY
GROUP BY service_version ORDER BY service_version;

-- 17. Рост WARN и ERROR по часам.
SELECT toStartOfHour(ts) AS hour, service,
       countIf(level='warn') AS warns, countIf(level IN ('error','fatal')) AS errors
FROM k8s.app_logs
WHERE ts >= now() - INTERVAL 24 HOUR
GROUP BY hour, service ORDER BY hour DESC, errors DESC;

-- 18. Операции без финального события success/failed (started без завершения).
SELECT s.trace_id, s.service, s.operation, s.ts AS started_at
FROM (SELECT trace_id, service, operation, ts FROM k8s.app_logs
      WHERE status = 'started' AND ts >= now() - INTERVAL 2 HOUR) AS s
LEFT JOIN (SELECT DISTINCT trace_id, operation FROM k8s.app_logs
           WHERE status IN ('success','failed') AND ts >= now() - INTERVAL 2 HOUR) AS f
  ON s.trace_id = f.trace_id AND s.operation = f.operation
WHERE f.trace_id = '' ORDER BY started_at ASC;

-- 19. Фоновые задания, которые зависли (started, нет completed/failed).
SELECT trace_id, service, operation, min(ts) AS started_at
FROM k8s.app_logs
WHERE event_category = 'background_job' AND ts >= now() - INTERVAL 6 HOUR
GROUP BY trace_id, service, operation
HAVING countIf(event_code IN ('JOB_COMPLETED','JOB_FAILED')) = 0 AND countIf(event_code='JOB_STARTED') > 0
ORDER BY started_at ASC;

-- 20. Сообщения очереди, обрабатываемые повторно (retry_count растёт).
SELECT attributes['message_id'] AS mid, service, max(retry_count) AS retries, count() AS attempts
FROM k8s.app_logs
WHERE event_category = 'message.consume' AND ts >= now() - INTERVAL 6 HOUR
GROUP BY mid, service HAVING retries >= 1 ORDER BY retries DESC LIMIT 100;

-- 21. Ошибки, требующие вмешательства оператора.
SELECT ts, service, error_code, action_required, operator_hint, trace_id
FROM k8s.app_logs
WHERE level IN ('error','fatal') AND action_required != '' AND ts >= now() - INTERVAL 12 HOUR
ORDER BY ts DESC LIMIT 200;

-- 22. Ошибки, для которых retryable=true.
SELECT service, error_code, count() AS n
FROM k8s.app_logs
WHERE level IN ('error','fatal') AND retryable = 1 AND ts >= now() - INTERVAL 12 HOUR
GROUP BY service, error_code ORDER BY n DESC LIMIT 50;

-- 23. События запроса с отсутствующим trace_id (нарушение корреляции).
SELECT service, event_category, count() AS n
FROM k8s.app_logs
WHERE trace_id = '' AND event_category IN ('http.request','grpc.request')
  AND ts >= now() - INTERVAL 6 HOUR
GROUP BY service, event_category ORDER BY n DESC;

-- 24. События, нарушающие стандарт (нет event_code при ошибке, нет service).
SELECT service, level, count() AS n
FROM k8s.app_logs
WHERE ts >= now() - INTERVAL 6 HOUR
  AND ((level IN ('error','fatal') AND error_code = '') OR service = '')
GROUP BY service, level ORDER BY n DESC;

-- 25. Наиболее шумные event_code (объём).
SELECT event_code, service, count() AS n
FROM k8s.app_logs
WHERE ts >= now() - INTERVAL 6 HOUR AND event_code != ''
GROUP BY event_code, service ORDER BY n DESC LIMIT 50;

-- Bonus. Сырые не-JSON логи (nginx/Go/kube-system) за период — то, что НЕ попало в app_logs.
SELECT ts, namespace, pod, container, log
FROM k8s.container_logs
WHERE namespace = {namespace:String} AND ts >= now() - INTERVAL 1 HOUR AND log NOT LIKE '{%'
ORDER BY ts DESC LIMIT 200;
