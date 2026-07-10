-- =====================================================================
-- AI Orchestrator — initial schema (ИДЕМПОТЕНТНАЯ миграция)
-- Target: PostgreSQL 16  (database: orchestrator_db)
-- =====================================================================
-- Принципы:
--   * Все PK — UUID (gen_random_uuid(), ядро PG13+).
--   * Статусы — через ENUM-типы.
--   * История/аудит — task_events (append-only), prompts (версии),
--     context_snapshots (immutable), agent_runs.
--   * Конкурентность — выборка задач через FOR UPDATE SKIP LOCKED,
--     один активный service_lock на сервис (partial unique index).
--   * Миграция идемпотентна: повторный запуск безопасен (IF NOT EXISTS,
--     DO-блоки для ENUM, DROP/CREATE для триггеров).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. Расширения
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- 1. ENUM-типы (справочники статусов)
-- ---------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE task_status AS ENUM (
        'BACKLOG','READY','ARCHITECTURE','DECOMPOSITION','CODING','TESTING',
        'FAILURE_ANALYSIS','REVIEW','COMMIT','DEPLOY','DONE','BLOCKED',
        'FAILED','CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE task_priority AS ENUM ('LOW','MEDIUM','HIGH','CRITICAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE agent_run_status AS ENUM
        ('PENDING','RUNNING','SUCCESS','FAILED','TIMEOUT','CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE event_type AS ENUM (
        'TASK_CREATED','TASK_UPDATED','STATUS_CHANGED','ROLE_ASSIGNED',
        'AGENT_ASSIGNED','AGENT_STARTED','AGENT_FINISHED','PIPELINE_STARTED',
        'PIPELINE_FAILED','PIPELINE_SUCCEEDED','REVIEW_REQUESTED','REVIEW_APPROVED',
        'REVIEW_REJECTED','REVIEW_NEEDS_FIX','SERVICE_LOCKED','SERVICE_UNLOCKED',
        'DEPLOY_STARTED','DEPLOY_COMPLETED','DEPLOY_FAILED','TASK_BLOCKED',
        'TASK_DONE','TASK_CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE pipeline_status AS ENUM
        ('PENDING','RUNNING','SUCCESS','FAILED','CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE stage_status AS ENUM
        ('PENDING','RUNNING','SUCCESS','FAILED','SKIPPED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE review_status AS ENUM ('APPROVED','REJECTED','NEEDS_FIX');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE deployment_status AS ENUM
        ('PENDING','RUNNING','SUCCESS','FAILED','ROLLED_BACK');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE deployment_env AS ENUM ('DEV','STAGING','PROD');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE artifact_type AS ENUM (
        'diff','patch','report','pipeline_log','review_report',
        'test_report','build_log','screenshot','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE document_type AS ENUM
        ('PROJECT_MAP','API_MAP','DATABASE_MAP','DECISIONS','ARCHITECTURE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE service_dep_type AS ENUM
        ('GRPC','REST','EVENT','DB','SYNC','ASYNC');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- 2. Базовые справочники
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS projects (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL UNIQUE,
    name        text NOT NULL,
    description text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE projects IS 'Список проектов оркестратора.';

CREATE TABLE IF NOT EXISTS services (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    service_code    text NOT NULL,
    service_name    text NOT NULL,
    description     text,
    repository_path text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, service_code)
);
COMMENT ON TABLE services IS 'Микросервисы внутри проектов.';

CREATE TABLE IF NOT EXISTS roles (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL UNIQUE,
    name        text NOT NULL,
    description text,
    sort_order  int  NOT NULL DEFAULT 0
);
COMMENT ON TABLE roles IS 'Роли оркестратора (этапы пайплайна).';

CREATE TABLE IF NOT EXISTS agents (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code       text NOT NULL UNIQUE,
    name       text NOT NULL,
    provider   text,
    model      text,
    role_id    uuid REFERENCES roles(id) ON DELETE SET NULL,
    is_active  boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE agents IS 'Конкретные ИИ-агенты, привязанные к роли.';

CREATE TABLE IF NOT EXISTS prompts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id     uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    version     int  NOT NULL,
    prompt_text text NOT NULL,
    is_active   boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (role_id, version)
);
COMMENT ON TABLE prompts IS 'Версионируемые промты ролей (старые версии не удаляются).';
CREATE UNIQUE INDEX IF NOT EXISTS uq_prompts_active_per_role
    ON prompts(role_id) WHERE is_active;

-- ---------------------------------------------------------------------
-- 3. Задачи и их жизненный цикл
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tasks (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    service_id        uuid REFERENCES services(id) ON DELETE SET NULL,
    parent_task_id    uuid REFERENCES tasks(id) ON DELETE SET NULL,
    title             text NOT NULL,
    description       text,
    priority          task_priority NOT NULL DEFAULT 'MEDIUM',
    status            task_status   NOT NULL DEFAULT 'BACKLOG',
    current_role_id   uuid REFERENCES roles(id) ON DELETE SET NULL,
    assigned_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
    created_by        text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE tasks IS 'Главная таблица задач — единый источник истины.';

CREATE TABLE IF NOT EXISTS task_dependencies (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id            uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (task_id, depends_on_task_id),
    CHECK (task_id <> depends_on_task_id)
);
COMMENT ON TABLE task_dependencies IS 'Граф зависимостей между задачами.';

CREATE TABLE IF NOT EXISTS task_events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    event_type   event_type NOT NULL,
    from_status  task_status,
    to_status    task_status,
    role_id      uuid REFERENCES roles(id) ON DELETE SET NULL,
    agent_id     uuid REFERENCES agents(id) ON DELETE SET NULL,
    payload_json jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE task_events IS 'Append-only история жизненного цикла задачи.';

-- ---------------------------------------------------------------------
-- 4. Запуски агентов и контроль расходов
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_runs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    role_id      uuid REFERENCES roles(id) ON DELETE SET NULL,
    status       agent_run_status NOT NULL DEFAULT 'PENDING',
    started_at   timestamptz,
    finished_at  timestamptz,
    input_json   jsonb,
    output_json  jsonb,
    error_text   text,
    token_input  bigint NOT NULL DEFAULT 0,
    token_output bigint NOT NULL DEFAULT 0,
    cost         numeric(14,6) NOT NULL DEFAULT 0
);
COMMENT ON TABLE agent_runs IS 'Каждый запуск агента — контроль расходов и эффективности.';

-- ---------------------------------------------------------------------
-- 5. Микросервисы: блокировки и зависимости
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS service_locks (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id      uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    task_id         uuid REFERENCES tasks(id) ON DELETE SET NULL,
    locked_by_agent uuid REFERENCES agents(id) ON DELETE SET NULL,
    lock_reason     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz,
    released_at     timestamptz
);
COMMENT ON TABLE service_locks IS 'Блокировки микросервисов — не более одной активной на сервис.';
COMMENT ON COLUMN service_locks.released_at IS
  'Время снятия лока. NULL = лок активен. Просроченные (expires_at) оркестратор снимает, проставляя released_at.';
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_locks_active
    ON service_locks(service_id) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS service_dependencies (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    target_service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    dependency_type   service_dep_type NOT NULL DEFAULT 'GRPC',
    UNIQUE (source_service_id, target_service_id, dependency_type),
    CHECK (source_service_id <> target_service_id)
);
COMMENT ON TABLE service_dependencies IS 'Граф зависимостей микросервисов.';

-- ---------------------------------------------------------------------
-- 6. Пайплайны
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pipeline_runs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    status       pipeline_status NOT NULL DEFAULT 'PENDING',
    failed_stage text,
    started_at   timestamptz,
    finished_at  timestamptz,
    summary_json jsonb,
    log_path     text
);
COMMENT ON TABLE pipeline_runs IS 'Запуски Pipeline Service для задачи.';

CREATE TABLE IF NOT EXISTS pipeline_stages (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_run_id  uuid NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    stage_name       text NOT NULL,
    status           stage_status NOT NULL DEFAULT 'PENDING',
    duration_seconds numeric(10,3),
    exit_code        int,
    started_at       timestamptz,
    finished_at      timestamptz
);
COMMENT ON TABLE pipeline_stages IS 'Этапы выполнения пайплайна (build/deploy/smoke/...).';

-- ---------------------------------------------------------------------
-- 7. Ревью и деплои
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reviews (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id           uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    reviewer_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
    status            review_status NOT NULL,
    review_text       text,
    created_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE reviews IS 'Результаты ревью задач.';

CREATE TABLE IF NOT EXISTS deployments (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    service_id  uuid REFERENCES services(id) ON DELETE SET NULL,
    environment deployment_env NOT NULL DEFAULT 'DEV',
    status      deployment_status NOT NULL DEFAULT 'PENDING',
    started_at  timestamptz,
    finished_at timestamptz,
    log_path    text
);
COMMENT ON TABLE deployments IS 'История деплоев.';

-- ---------------------------------------------------------------------
-- 8. Артефакты и документация
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS artifacts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id       uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    artifact_type artifact_type NOT NULL,
    file_path     text NOT NULL,
    metadata_json jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE artifacts IS 'Артефакты задач (diff/patch/report/log/...).';

CREATE TABLE IF NOT EXISTS knowledge_documents (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    document_type document_type NOT NULL,
    file_path     text NOT NULL,
    checksum      text,
    version       int NOT NULL DEFAULT 1,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, document_type)
);
COMMENT ON TABLE knowledge_documents IS 'Карты проекта (PROJECT_MAP/API_MAP/DATABASE_MAP/...).';

-- ---------------------------------------------------------------------
-- 9. Снимки контекста (immutable, append-only)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS context_snapshots (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id              uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_run_id         uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
    project_id           uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    service_id           uuid REFERENCES services(id) ON DELETE SET NULL,
    prompt_version       int,
    role_name            text,
    agent_name           text,
    project_map_version  int,
    database_map_version int,
    api_map_version      int,
    architecture_version int,
    snapshot_json        jsonb NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE context_snapshots IS
  'Полный неизменяемый снимок контекста на момент запуска агента (аудит/воспроизводимость).';

-- =====================================================================
-- 10. Индексы
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_tasks_status           ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_service_id       ON tasks(service_id);
CREATE INDEX IF NOT EXISTS idx_tasks_current_role_id  ON tasks(current_role_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id       ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id   ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_ready_queue
    ON tasks(priority DESC, created_at) WHERE status = 'READY';

CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_id    ON agent_runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_task_id     ON agent_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status      ON agent_runs(status);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_task_id  ON pipeline_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_stages_run_id ON pipeline_stages(pipeline_run_id);

CREATE INDEX IF NOT EXISTS idx_service_locks_service_id ON service_locks(service_id);
CREATE INDEX IF NOT EXISTS idx_service_locks_task_id    ON service_locks(task_id);

CREATE INDEX IF NOT EXISTS idx_task_events_task_id    ON task_events(task_id);
CREATE INDEX IF NOT EXISTS idx_task_events_created_at ON task_events(created_at);

CREATE INDEX IF NOT EXISTS idx_task_deps_task_id      ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on   ON task_dependencies(depends_on_task_id);

CREATE INDEX IF NOT EXISTS idx_reviews_task_id        ON reviews(task_id);
CREATE INDEX IF NOT EXISTS idx_deployments_task_id    ON deployments(task_id);
CREATE INDEX IF NOT EXISTS idx_deployments_service_id ON deployments(service_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_task_id      ON artifacts(task_id);
CREATE INDEX IF NOT EXISTS idx_ctx_snapshots_task_id  ON context_snapshots(task_id);
CREATE INDEX IF NOT EXISTS idx_ctx_snapshots_run_id   ON context_snapshots(agent_run_id);
CREATE INDEX IF NOT EXISTS idx_svc_deps_source        ON service_dependencies(source_service_id);
CREATE INDEX IF NOT EXISTS idx_svc_deps_target        ON service_dependencies(target_service_id);

-- =====================================================================
-- 11. Триггеры: updated_at + неизменяемость append-only таблиц
-- =====================================================================

CREATE OR REPLACE FUNCTION trg_set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tasks_set_updated_at ON tasks;
CREATE TRIGGER tasks_set_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

CREATE OR REPLACE FUNCTION trg_block_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Table % is append-only: % is not allowed',
        TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_events_immutable ON task_events;
CREATE TRIGGER task_events_immutable
    BEFORE UPDATE OR DELETE ON task_events
    FOR EACH ROW EXECUTE FUNCTION trg_block_mutation();

DROP TRIGGER IF EXISTS context_snapshots_immutable ON context_snapshots;
CREATE TRIGGER context_snapshots_immutable
    BEFORE UPDATE OR DELETE ON context_snapshots
    FOR EACH ROW EXECUTE FUNCTION trg_block_mutation();

COMMIT;
