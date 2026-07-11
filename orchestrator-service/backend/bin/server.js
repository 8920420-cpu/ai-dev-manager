#!/usr/bin/env node
// Точка входа orchestrator-service backend.
// При старте автоматически проверяет/создаёт БД и накатывает миграции
// (AUTO_INIT=false — отключить). Затем поднимает HTTP-сервер с UI + API.
import { createApp } from '../src/server.js';
import { loadSettings } from '../src/config.js';
import { bootstrap, reconcileOnStartup } from '../src/db.js';
import { createTaskRunner } from '../src/taskRunner.js';
import { recordDeployMarker, recordDowntimeMarker } from '../src/performance.js';
import { ensureClickhouseSchema } from '../src/clickhouseSchema.js';

const PORT = Number(process.env.PORT || 4186);
const HOST = process.env.HOST || '0.0.0.0';
const AUTO_INIT = process.env.AUTO_INIT !== 'false';
// Фоновый runner продвигает автоматические роли по БД (RUNNER_ENABLED=false — выкл).
const RUNNER_ENABLED = process.env.RUNNER_ENABLED !== 'false';
// Стартовая реконсиляция: немедленно освободить осиротевшие Programmer-назначения,
// чтобы зависшие после прошлого сеанса задачи переподались сразу (STARTUP_RECONCILE=false — выкл).
const STARTUP_RECONCILE = process.env.STARTUP_RECONCILE !== 'false';

async function main() {
  if (AUTO_INIT) {
    try {
      const s = await loadSettings();
      const r = await bootstrap(s);
      console.error(
        `[orchestrator-service] БД "${s.database}": ${r.created ? 'создана' : 'уже существует'}; ` +
          `миграции: ${r.migrated.length ? r.migrated.join(', ') : 'нет новых'}`
      );
    } catch (e) {
      console.error(
        `[orchestrator-service] автоинициализация БД не удалась (продолжаю, настройте через UI): ${e.message}`
      );
    }
  }
  // VERSION-KPI-TRACKING-001: авто-метка деплоя. APP_CODE_VERSION задаётся build-arg
  // образа (git-SHA на момент сборки) → на старте ставим общесистемную метку type=deploy.
  // Идемпотентно по ref: рестарт того же образа метку не дублирует.
  if (process.env.APP_CODE_VERSION) {
    try {
      const dm = await recordDeployMarker(await loadSettings(), { ref: process.env.APP_CODE_VERSION });
      if (dm.created) console.error(`[orchestrator-service] метка деплоя поставлена: ${dm.ref}`);
    } catch (e) {
      console.error(`[orchestrator-service] метка деплоя не поставлена (продолжаю): ${e.message}`);
    }
  }

  // ORCH-DOWNTIME-MARKER-001: если сервис только что поднялся после долгого молчания
  // (heartbeat не бился) — ставим метку простоя за интервал бездействия и
  // инициализируем heartbeat. Так периоды «оркестратор был выключен» видны на оси KPI
  // и не путаются с реальными зависаниями задач.
  try {
    const dt = await recordDowntimeMarker(await loadSettings());
    if (dt.downtime) console.error(`[orchestrator-service] отмечен простой ~${dt.hours} ч: ${dt.ref}`);
  } catch (e) {
    console.error(`[orchestrator-service] метка простоя не поставлена (продолжаю): ${e.message}`);
  }

  if (STARTUP_RECONCILE) {
    try {
      const released = await reconcileOnStartup(await loadSettings());
      console.error(
        `[orchestrator-service] стартовая реконсиляция: освобождено осиротевших Programmer-задач: ${released}`,
      );
    } catch (e) {
      console.error(`[orchestrator-service] стартовая реконсиляция не удалась (продолжаю): ${e.message}`);
    }
  }

  // OBSERVABILITY-CLICKHOUSE-SCHEMA-001: оркестратор сам владеет схемой стора
  // прогонов и накатывает её на старте (best-effort, не блокирует boot). Так стор
  // самодостаточен и не зависит от init-скриптов infra (они гоняются только на
  // пустом volume). Гейты: CLICKHOUSE_OBSERVABILITY_ENABLED, ..._ENSURE_SCHEMA.
  void ensureClickhouseSchema()
    .then((r) => {
      if (r?.ok) console.error('[orchestrator-service] ClickHouse observability: схема готова');
      else if (r?.ok === false) console.error(`[orchestrator-service] ClickHouse observability: схема не накатилась (продолжаю): ${r.error}`);
    })
    .catch((e) => console.error(`[orchestrator-service] ClickHouse observability: ensure schema error (продолжаю): ${e.message}`));

  createApp().listen(PORT, HOST, () => {
    console.error(`[orchestrator-service] http://localhost:${PORT}`);
  });

  if (RUNNER_ENABLED) {
    const runner = createTaskRunner();
    runner.start();
    console.error('[orchestrator-service] task runner запущен');
    const stop = () => runner.stop();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
}

main();
