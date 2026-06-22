// Фоновый runner Stage 3: периодически продвигает автоматические роли по БД.
// Сам по себе без состояния — вся логика перехода в advanceAutomatedTasks
// (db.js) и ROLE_FLOW (rolePipeline.js). Зависимости инъектируются, чтобы цикл
// тестировался без живого Postgres.
import { loadSettings } from './config.js';
import { advanceAutomatedTasks } from './db.js';

export function createTaskRunner({
  intervalMs = Number(process.env.RUNNER_INTERVAL_MS || 3000),
  log = console,
  loadSettings: load = loadSettings,
  advance = advanceAutomatedTasks,
} = {}) {
  let timer = null;
  let inFlight = false;
  let stopped = false;

  // Один проход. Реэнтерабельность исключаем флагом: тик не наступает на
  // предыдущий, даже если БД отвечает дольше интервала.
  async function tick() {
    if (inFlight) return [];
    inFlight = true;
    try {
      const applied = await advance(await load());
      if (applied.length) log.info?.('Runner advanced tasks', { count: applied.length, applied });
      return applied;
    } catch (error) {
      log.error?.('Runner tick failed', { error: error.message });
      return [];
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (timer || stopped) return;
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}
