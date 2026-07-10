# Аудит AI-оркестратора — Principal AI Orchestrator Auditor

**Дата:** 2026-06-28 · **Объект:** orchestrator-service (backend) + runners + frontend
**Метод:** статический разбор кода (roleEngine, db, rolePipeline, projectRoute, connectorLimiter, taskStats), без прогона модели.

> Часть находок уже переведена в наблюдаемость: добавлен раздел **«Монитор производительности»**
> (`GET /api/performance`) с live-KPI без участия ИИ (throughput, retry rate, очередь, нагрузка по ролям,
> ёмкость коннектора). Это инструмент измерения для пунктов KPI ниже.

---

## Executive Summary

Оркестратор зрелый: динамический маршрут из этапов проекта, контракт полей ролей с входным
гейтом (роль не запускается и не тратит токены, если нет обязательного входа), компрессия истории
(`summarizePriorRuns` — только статус/summary/findings, без полного текста ответов), адаптивный
AIMD-лимитер вызовов с учётом TPM, обрезка результатов инструментов (`compactToolResult`),
сторожа от рассинхрона часов и сирот. 306 unit-тестов, чистые функции вынесены и покрыты.

Главные точки роста — **переиспользование контекста между ролями** (нет общего Artifact/Snapshot:
ARCHITECT/DECOMPOSER/REVIEWER читают файлы заново через tool-loop) и **кэш результатов пайплайна**
(build/test прогоняются заново на каждом цикле доработки). Это основной источник перерасхода
токенов и времени при rework-петлях.

**Интегральная оценка: ~64/100.**

---

## Architecture Score (0–100)

| Направление          | Балл | Обоснование |
|----------------------|------|-------------|
| Token Efficiency     | 62→66 | Компактная сериализация контекста (исправлено). Нет кросс-ролевого кэша файлов; статичное правило данных шлётся в каждый промпт. |
| Context Management   | 70 | Minimum-context: summary прошлых ролей, входной гейт до траты токенов, компактный контекст (12 событий, 8 в выжимку). |
| Prompt Design        | 65 | Промпты в БД + skills + `DATA_DISCIPLINE_RULE`. Правило (~1.5 КБ) дублируется в каждый системный промпт. |
| Routing              | 72 | Маршрут из `project_stages`, фолбэк `ROLE_FLOW`, ветвление через FAILURE_ANALYST, потолок rework=3. |
| Pipeline             | 58 | Нет result-cache: повторные build/test/review на каждой петле доработки. |
| Scalability          | 55 | Один процесс-оркестратор, in-proc tick-runner, одноузловой Patroni (флаппинг). |
| Maintainability      | 75 | Чистая модульность, 306 тестов, тестируемые pure-функции. |
| Cost Efficiency      | 60 | AIMD-лимитер + `max_tokens` cap. Нет кэша результатов и промптов. |
| Parallelism          | 60 | Параллельность на роль + worktree на микросервис у программиста; жёсткие потолки (3). |
| Fault Tolerance      | 68 | clockGuard, reset/release stale claims, DB-resilience listener. Дыра: boot-storm вешает RUNNING. |

---

## Critical Issues

Блокирующих (ломающих корректность) не выявлено. Перечисленное ниже — про стоимость/скорость.

## High Priority

1. **Нет Artifact/Snapshot контекста на задачу (дубль-чтения файлов).**
   Рассуждающие роли читают файлы проекта через tool-loop независимо. ARCHITECT прочитал карту/код —
   DECOMPOSER и TASK_REVIEWER читают то же заново.
   *Эффект:* перерасход токенов на повторные чтения + задержка на каждый tool-цикл.
   *Решение:* Context Broker / Artifact Store — на задачу один снапшот прочитанных файлов
   (ключ = путь+hash), последующие роли берут из снапшота, дочитывают лениво только недостающее.

2. **Нет кэша результатов пайплайна (повторные build/test).**
   PIPELINE_SERVICE гоняет полный build/test; при возврате REVIEW→FAILURE_ANALYST→PROGRAMMER цикл
   повторяется целиком.
   *Решение:* Result Cache по content-hash дерева/диффа сервиса — пропускать неизменившиеся шаги.

3. **Компактная сериализация контекста (ИСПРАВЛЕНО).**
   `buildUserPayload` использовал `JSON.stringify(context, null, 2)` — отступы/переносы в каждый
   вызов модели (≈10–20% лишних токенов на вложенном контексте). Переведено на компактный JSON.

## Medium Priority

4. **`DATA_DISCIPLINE_RULE` дублируется в каждый системный промпт** (~1.5 КБ × каждый вызов).
   На провайдерах без prompt-cache это прямой перерасход.
   *Решение:* выносить статичный префикс в кэшируемую часть (prompt cache), либо отправлять правило
   один раз на сессию роли.

5. **DOCUMENTATION_AUDITOR + DOCUMENTATION_KEEPER оба ведут к GIT_INTEGRATOR** — риск дублирующего
   анализа документации. Проверить, не пересекаются ли зоны ответственности.

6. **Boot-storm вешает RUNNING-прогоны** (см. известную проблему): жнец сирот только на старте + cap=3
   заклинивает роль на таймаут.
   *Решение:* периодический reaper RUNNING вне момента загрузки (по `started_at` + timeout), не только on-boot.

7. **Масштаб 1000+ задач:** один процесс-оркестратор и in-proc tick-runner становятся узким местом
   (claim-contention, single-writer). Горизонтальные runners + очередь (claim через `FOR UPDATE SKIP LOCKED`,
   что уже частично есть) и вынос реасонинга в отдельные воркеры.

## Nice to Have

8. **KPI стоимости на задачу:** `agent_runs` хранит `token_input/output/cost` — добавить в монитор
   «стоимость на задачу» и «токены по ролям» (данные уже есть, нужен агрегат).
9. **Prompt cache hit rate:** инструментировать (нет метрики). 
10. **Decision Log:** фиксировать решения ARCHITECT/REVIEWER как переиспользуемые артефакты, чтобы
    FAILURE_ANALYST не выводил контекст заново.

---

## KPI (как измерять)

Все ниже теперь снимаются из `GET /api/performance` (раздел «Монитор производительности») и `agent_runs`:

| KPI | Источник | Статус |
|-----|----------|--------|
| Pipeline Throughput | `throughput.completedLast1h/24h` | live |
| Retry Rate | `rework.retryRate` (лишние входы в этап / все переходы) | live |
| Queue depth | `queue.{backlog,codingUnclaimed,review,restart}` | live |
| Avg task latency | `timings.averageCompletedDurationMs` | live |
| Role load / fail rate | `roleLoad[].{runs,failed,timeout,avgDurationMs}` | live |
| Connector TPM / capacity | `connector[].{tpm,limit,active}` | live |
| Avg Cost Per Task | `agent_runs.cost` агрегат по задаче | данные есть, агрегат TODO |
| Avg Prompt/Completion Size | `agent_runs.token_input/output` | данные есть, агрегат TODO |
| Context Compression Ratio | сравнить размер истории vs `summarizePriorRuns` | оценочно ~5–10× |
| Cache Hit Rate (файлы/пайплайн) | требует Artifact/Result Cache (п.1–2) | 0% (кэша нет) |

---

## Roadmap

| # | Шаг | Эффект | ↓ Стоимость | ↓ Токены | Скорость | Качество | Сложность | Приоритет |
|---|-----|--------|------------|----------|----------|----------|-----------|-----------|
| 1 | Компактный контекст (сделано) | меньше токенов на вызов | ~10–15% контекста | ↓↓ | = | = | низкая | ✅ done |
| 2 | Artifact/Snapshot файлов на задачу | убрать дубль-чтения | средне-высоко | ↓↓↓ | ↑↑ | ↑ | средняя | High |
| 3 | Result Cache пайплайна (build/test по hash) | пропуск повторов | высоко | — | ↑↑↑ | = | средняя | High |
| 4 | Prompt cache для статичного правила/префикса | дешевле каждый вызов | средне | ↓↓ | = | = | низкая | Medium |
| 5 | Периодический reaper RUNNING (не только on-boot) | меньше клинов | низко | — | ↑ | ↑ | низкая | Medium |
| 6 | Cost/Token KPI в мониторе из agent_runs | видимость стоимости | — | — | = | ↑ | низкая | Medium |
| 7 | Горизонтальные reasoning-воркеры + очередь | масштаб 1000+ | при росте | — | ↑↑↑ | = | высокая | Medium |
| 8 | Decision Log как артефакт для FAILURE_ANALYST | меньше повторного вывода | средне | ↓↓ | ↑ | ↑ | средняя | Nice |

**Применено в этом проходе:** п.1 (компактная сериализация контекста) + инфраструктура измерения
(Монитор производительности, роль аудитора, очередь запусков аудита).
