import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Построить канонические объектные этапы из компактной записи фикстуры.
 * Канонический формат конфига — { commands:[...], enabled:boolean } на этап
 * (LEGACY-PIPELINE-CONFIG-001): массивный формат и пропуск enabled больше не
 * принимаются ConfigLoader. Хелпер избавляет фикстуры от повторов:
 *   - массив команд → { commands:[...], enabled:true } (включённый этап);
 *   - объект → используется как есть (для enabled:false и прочих случаев).
 * На диск/в ConfigLoader всегда уходит объектный формат с явным enabled.
 */
export function stageMap(map) {
  const out = {};
  for (const [name, value] of Object.entries(map)) {
    out[name] = Array.isArray(value) ? { commands: value, enabled: true } : value;
  }
  return out;
}

/** Создать временный каталог, автоматически удаляемый в конце теста. */
export function tmpDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pr-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Логгер-заглушка: ничего не пишет, чтобы тесты не шумели и не трогали диск. */
export class NullLogger {
  raw() {}
  line() {}
  log() {}
  info() {}
  warn() {}
  error() {}
  async close() {}
}

/**
 * Поддельный CommandExecutor: возвращает заранее заданные результаты
 * по строке команды. Позволяет тестировать оркестрацию без реальных процессов.
 */
export class FakeExecutor {
  constructor(table = {}) {
    this.table = table;
    this.calls = [];
  }
  async run(command, opts = {}) {
    this.calls.push({ command, opts });
    const preset = this.table[command] ?? {};
    return {
      command,
      exitCode: preset.exitCode ?? 0,
      signal: null,
      stdout: preset.stdout ?? '',
      stderr: preset.stderr ?? '',
      timedOut: preset.timedOut ?? false,
      error: preset.error ?? null,
      durationSeconds: preset.durationSeconds ?? 0.01,
    };
  }
}
