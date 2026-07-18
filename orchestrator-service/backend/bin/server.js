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
import { createLogger } from '../../../shared/logging/index.js';

const log = createLogger({ service: 'orchestrator-service' });
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
      log.info(`БД "${s.database}": ${r.created ? 'создана' : 'уже существует'}; миграции: ${r.migrated.length ? r.migrated.join(', ') : 'нет новых'}`, {
        event_code: 'APP_BOOT_STEP', operation: 'db.bootstrap',
        attributes: { database: s.database, created: r.created, migrated: r.migrated },
      });
    } catch (e) {
      log.error('автоинициализация БД не удалась (продолжаю, настройте через UI)', {
        event_code: 'APP_BOOT_FAILED', operation: 'db.bootstrap', error_code: 'DB_UNAVAILABLE', err: e,
      });
    }
  }
  // VERSION-KPI-TRACKING-001: авто-метка деплоя. APP_CODE_VERSION задаётся build-arg
  // образа (git-SHA на момент сборки) → на старте ставим общесистемную метку type=deploy.
  // Идемпотентно по ref: рестарт того же образа метку не дублирует.
  if (process.env.APP_CODE_VERSION) {
    try {
      const dm = await recordDeployMarker(await loadSettings(), { ref: process.env.APP_CODE_VERSION });
      if (dm.created) log.info(`метка деплоя поставлена: ${dm.ref}`, { event_code: 'APP_BOOT_STEP', operation: 'deploy.marker', attributes: { ref: dm.ref } });
    } catch (e) {
      log.warn('метка деплоя не поставлена (продолжаю)', { event_code: 'APP_BOOT_STEP', operation: 'deploy.marker', err: e });
    }
  }

  // ORCH-DOWNTIME-MARKER-001: если сервис только что поднялся после долгого молчания
  // (heartbeat не бился) — ставим метку простоя за интервал бездействия и
  // инициализируем heartbeat. Так периоды «оркестратор был выключен» видны на оси KPI
  // и не путаются с реальными зависаниями задач.
  try {
    const dt = await recordDowntimeMarker(await loadSettings());
    if (dt.downtime) log.info(`отмечен простой ~${dt.hours} ч: ${dt.ref}`, { event_code: 'APP_BOOT_STEP', operation: 'downtime.marker', attributes: { hours: dt.hours, ref: dt.ref } });
  } catch (e) {
    log.warn('метка простоя не поставлена (продолжаю)', { event_code: 'APP_BOOT_STEP', operation: 'downtime.marker', err: e });
  }

  if (STARTUP_RECONCILE) {
    try {
      const released = await reconcileOnStartup(await loadSettings());
      log.info(`стартовая реконсиляция: освобождено осиротевших Programmer-задач: ${released}`, {
        event_code: 'APP_BOOT_STEP', operation: 'startup.reconcile', attributes: { released },
      });
    } catch (e) {
      log.warn('стартовая реконсиляция не удалась (продолжаю)', { event_code: 'APP_BOOT_STEP', operation: 'startup.reconcile', err: e });
    }
  }

  // OBSERVABILITY-CLICKHOUSE-SCHEMA-001: оркестратор сам владеет схемой стора
  // прогонов и накатывает её на старте (best-effort, не блокирует boot). Так стор
  // самодостаточен и не зависит от init-скриптов infra (они гоняются только на
  // пустом volume). Гейты: CLICKHOUSE_OBSERVABILITY_ENABLED, ..._ENSURE_SCHEMA.
  void ensureClickhouseSchema()
    .then((r) => {
      if (r?.ok) log.info('ClickHouse observability: схема готова', { event_code: 'APP_BOOT_STEP', operation: 'clickhouse.ensure_schema' });
      else if (r?.ok === false) log.warn('ClickHouse observability: схема не накатилась (продолжаю)', { event_code: 'APP_BOOT_STEP', operation: 'clickhouse.ensure_schema', attributes: { error: r.error } });
    })
    .catch((e) => log.warn('ClickHouse observability: ensure schema error (продолжаю)', { event_code: 'APP_BOOT_STEP', operation: 'clickhouse.ensure_schema', err: e }));

  createApp().listen(PORT, HOST, () => {
    log.info(`orchestrator-service слушает http://localhost:${PORT}`, { event_code: 'APP_STARTED', attributes: { port: PORT, host: HOST } });
  });

  if (RUNNER_ENABLED) {
    const runner = createTaskRunner();
    runner.start();
    log.info('task runner запущен', { event_code: 'APP_BOOT_STEP', operation: 'runner.start' });
    const stop = () => runner.stop();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
}

main();
