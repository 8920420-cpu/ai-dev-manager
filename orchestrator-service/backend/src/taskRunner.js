// Фоновый runner Stage 3: периодически продвигает автоматические роли по БД.
// Сам по себе без состояния — вся логика перехода в advanceAutomatedTasks
// (db.js) и ROLE_FLOW (rolePipeline.js). Зависимости инъектируются, чтобы цикл
// тестировался без живого Postgres.
import { loadSettings } from './config.js';
import { advanceAutomatedTasks } from './db.js';
import { touchOrchestratorHeartbeat } from './performance.js';
import { resolveDuration } from './envConfig.js';

export function createTaskRunner({
  intervalMs = resolveDuration('RUNNER_INTERVAL_MS', 3000, { min: 100 }).value,
  log = console,
  loadSettings: load = loadSettings,
  advance = advanceAutomatedTasks,
  // ORCH-DOWNTIME-MARKER-001: живой heartbeat. Каждый тик отмечает, что процесс жив
  // (даже если orchestratorEnabled=false и advance ничего не делает) — по разрыву в
  // нём следующий старт распознаёт простой сервиса. Инъектируется для тестов.
  heartbeat = touchOrchestratorHeartbeat,
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
      const settings = await load();
      // Heartbeat отдельно от advance и его ошибок: даже если продвижение упадёт,
      // отметка «процесс жив» должна пройти, иначе живой сервис выглядел бы простоем.
      try { await heartbeat(settings); } catch (e) { log.error?.('Heartbeat failed', { error: e.message }); }
      const applied = await advance(settings);
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
