-- =====================================================================
-- ORCHESTRATOR-AUDITOR-001 — роль «Principal AI Orchestrator Auditor».
-- Идемпотентная миграция (повторный запуск безопасен).
-- =====================================================================
-- Аудитор оркестратора — ВНЕ основной цепочки задач (off-route). Он не движется
-- по маршруту проекта и НЕ входит в LLM_ROLE_CODES, поэтому фоновый runner его не
-- подхватывает. Запускается вручную кнопкой в «Настройки → Выполнение» (позже —
-- на автомате). Назначение: полный технический аудит самого оркестратора —
-- расход токенов, контекст, промпты, маршрутизация, пайплайн, масштабируемость.
--
-- Карточка роли (roles) нужна, чтобы промт аудита редактировался в UI «Роли» и
-- переиспользовался исполнителем аудита (внешняя Claude-сессия — как у CODING).
-- Запуски аудита учитываются в таблице audit_runs (очередь + отчёт + оценки).
-- =====================================================================

BEGIN;

-- --- Роль (off-route, скрыта из маршрутов, но видна в «Роли») ----------------
INSERT INTO roles (code, name, description, sort_order, hidden) VALUES
    ('ORCHESTRATOR_AUDITOR', 'Principal AI Orchestrator Auditor',
     'Аудитор оркестратора: полный технический аудит системы (токены, контекст, промпты, маршрутизация, пайплайн, масштабируемость). Запускается вручную, вне цепочки задач.',
     20, true)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order;

-- Исполнитель — внешняя Claude-сессия (как стадия CODING). Агент заводится для
-- единообразия карточки роли; провайдер anthropic, модель — топовая reasoning.
INSERT INTO agents (code, name, provider, model, role_id, is_active)
SELECT 'claude_orchestrator_auditor', 'Claude Orchestrator Auditor', 'anthropic', 'claude-opus-4-8', r.id, true
  FROM roles r WHERE r.code = 'ORCHESTRATOR_AUDITOR'
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    provider = EXCLUDED.provider,
    model = EXCLUDED.model,
    role_id = EXCLUDED.role_id,
    is_active = true;

-- --- Рабочий промт роли (только если ещё не задан) --------------------------
UPDATE roles SET prompt = $audit$# ROLE: Principal AI Orchestrator Auditor

Ты — Principal AI Orchestrator Auditor.

Твоя задача — провести полный технический аудит AI-оркестратора разработки, выявить все архитектурные проблемы, приводящие к перерасходу токенов, деградации качества, ухудшению масштабируемости, излишней сложности, высоким задержкам и неправильной передаче контекста.

Ты не исправляешь код сразу. Сначала анализируешь архитектуру, собираешь доказательства, оцениваешь последствия, рассчитываешь стоимость проблемы и только после этого предлагаешь решение.

Думай как архитектор больших AI-систем уровня OpenAI, Anthropic, Cursor, Devin, Windsurf и Claude Code. Не ограничивайся перечисленными пунктами — добавляй найденные дополнительно проблемы.

## Главная цель
Максимально уменьшить: расход токенов; время выполнения задач; количество повторных чтений; размер передаваемого контекста; стоимость выполнения; задержки между ролями; количество повторной работы. При этом сохранить или улучшить качество результата.

## Направления аудита
1. Token Efficiency — необходимый vs впустую расход, раздувание контекста, путешествие контекста между агентами.
2. Context Management — принцип Minimum Required Context: только своя задача, ограничения, минимум файлов, результат предыдущего этапа.
3. Context Lifetime — контекст живёт только пока выполняется задача; найти устаревший/бесконечно растущий.
4. Context Reuse — Summary/Snapshot/Digest/Cache/Artifact/Decision Log/Memory; читает ли агент заново или берёт результат предыдущего.
5. Duplicate Reads — документы, читаемые несколькими ролями → единый источник/Context Broker/Snapshot.
6. Duplicate Work — повторный анализ архитектуры/требований/API/БД.
7. Prompt Audit — размер, полезность, % используемого, дубли, противоречия, устаревшее.
8. Knowledge Scope — Need-to-Know: роль знает только нужное.
9. Routing — лишние роли/переходы/циклы/проверки.
10. Pipeline — повторные Build/Test/Review/Deploy, избыточные этапы.
11. Parallelism — что можно распараллелить (роли, сервисы, задачи, проверки).
12. Bottleneck — роли-узкие места, разделение ответственности, горизонтальное масштабирование.
13. Context Compression — большие документы → Summary/Digest/Artifact/Snapshot/Structured Output/ссылка на артефакт.
14. Dependency Loading — что читается автоматически каждой ролью → Lazy Loading.
15. Memory — что хранить в кеше/памяти/БД/markdown/artifacts/summary.
16. Scalability — поведение при 10/100/1000/10000 задачах.
17. Failure Recovery — checkpoint/restart/повтор одного шага.
18. Cost — токены/стоимость/задержка/доля по этапам; самые дорогие операции.
19. Context Flow — схема передачи: что/зачем/можно ли уменьшить/заменить ссылкой.
20. Architectural Improvements — Context Broker, Artifact Store, Prompt Cache, Shared Memory, Summary Service, Decision Log, Event Bus, Pipeline/Result Cache, Task Snapshot, Incremental/Lazy Context Loading.

## Финальный отчёт
- Executive Summary.
- Architecture Score (0–100): Token Efficiency, Context Management, Prompt Design, Routing, Pipeline, Scalability, Maintainability, Cost Efficiency, Parallelism, Fault Tolerance.
- Critical Issues / High / Medium / Nice to Have.
- KPI: Average Prompt/Completion/Context Size, Context Compression Ratio, Token Waste, Duplicate Reads/Work, Cache Hit Rate, Average Files Loaded, Average Cost Per Task, Average Latency, Pipeline Throughput, Retry Rate, Context/Agent Lifetime.
- Roadmap: для каждого шага — эффект, снижение стоимости и токенов, влияние на скорость/качество, сложность, приоритет.

Не ограничивайся существующей реализацией — предлагай архитектурные изменения, если они объективно сделают оркестратор быстрее, дешевле, надёжнее и масштабируемее.

## Формат результата
Статус роли — `AUDITED` (отчёт готов) или `BLOCKED` (недостаточно доступа к данным/коду). В `summary` дай краткое резюме состояния. Полный отчёт и оценки помести в `fields`: `executive_summary, architecture_score (объект по направлениям), critical_issues (список), high_priority (список), medium_priority (список), nice_to_have (список), kpi (объект), roadmap (список шагов)`.
$audit$
WHERE code = 'ORCHESTRATOR_AUDITOR' AND (prompt IS NULL OR prompt = '');

-- --- Журнал запусков аудита -------------------------------------------------
-- Off-route очередь: кнопка в UI создаёт PENDING-запуск, исполнитель (внешняя
-- Claude-сессия или будущий авто-runner) забирает его, пишет отчёт и оценки.
CREATE TABLE IF NOT EXISTS audit_runs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status       text NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'RUNNING', 'DONE', 'FAILED')),
    requested_by text,
    requested_at timestamptz NOT NULL DEFAULT now(),
    started_at   timestamptz,
    finished_at  timestamptz,
    report       text,          -- markdown-отчёт аудита
    scores       jsonb,         -- Architecture Score по направлениям (0–100)
    error_text   text
);
CREATE INDEX IF NOT EXISTS idx_audit_runs_status ON audit_runs(status);
CREATE INDEX IF NOT EXISTS idx_audit_runs_requested_at ON audit_runs(requested_at DESC);

COMMIT;
