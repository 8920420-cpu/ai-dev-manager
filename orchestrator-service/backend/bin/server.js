#!/usr/bin/env node
// Точка входа orchestrator-service backend.
// При старте автоматически проверяет/создаёт БД и накатывает миграции
// (AUTO_INIT=false — отключить). Затем поднимает HTTP-сервер с UI + API.
import { createApp } from '../src/server.js';
import { loadSettings } from '../src/config.js';
import { bootstrap, reconcileOnStartup } from '../src/db.js';
import { createTaskRunner } from '../src/taskRunner.js';

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
