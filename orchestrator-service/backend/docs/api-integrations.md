# Контракт `/api/integrations/:id/invoke` (orchestrator-service)

LEGACY-CONNECTOR-PROMPT-ALIAS-001 (ORCHESTRATOR-P2.2). Зафиксированный контракт
вызова коннектора AI для frontend (FRONTEND-P2.2). Все ответы — JSON. Если задан
`ORCHESTRATOR_API_TOKEN`, требуется `Authorization: Bearer <token>`.

Реальный вызов модели идёт с backend (обход CORS, секрет коннектора не покидает
сервер). Каждый вызов записывается в журнал `prompt_exchanges`.

---

## `POST /api/integrations/:id/invoke`

Канонический request-контракт:

```json
{
  "system": "",        // опц.: системная часть промта
  "user": "привет",    // ЕДИНСТВЕННОЕ пользовательское поле
  "isManual": true     // опц.: вызов через UI считается ручным (по умолчанию true)
}
```

Требуется непустой `user` **или** `system` (после trim). Иначе — `422 prompt_required`.

Успешный ответ:

```json
{
  "ok": true,
  "response": "…",
  "exchange": { "id": "…", "status": "завершен", "httpStatus": 200, "durationMs": 5 }
}
```

## Удалённый legacy-alias `input.prompt`

Поле `prompt` **больше не поддерживается**. Ранее `invokeConnector` принимал
`input.user ?? input.prompt`; этот fallback удалён. Старый payload `{ "prompt": "…" }`
без `user`/`system` теперь получает стабильную ошибку `422 prompt_required`
вместо молчаливого принятия. Поле `prompt` в теле запроса игнорируется.

> Поле `prompt` в строках журнала `prompt_exchanges` (и в ответе
> `GET /api/integrations/:id/exchanges`) — это сохранённый текст обмена, а не
> входной alias; оно не относится к request-контракту invoke.

Содержимое промта не попадает в telemetry и диагностические логи.

## Коды ошибок

| Код | Значение |
|---|---|
| `422 prompt_required` | пустой `user`/`system` либо старый payload только с `prompt` |
| `404 connector_not_found` | коннектор не найден |
| `409 connector_disabled` | коннектор выключен (`is_enabled = false`) |
| `502 <upstream>` | ошибка вызова провайдера |
