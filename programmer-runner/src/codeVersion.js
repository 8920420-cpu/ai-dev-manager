// VERSION-KPI-TRACKING-001 — версия кода раннера для атрибуции KPI.
//
// Возвращает короткий git-SHA репозитория, из которого запущен раннер, плюс
// суффикс «-dirty» при незакоммиченном рабочем дереве. Это «метка измерения»:
// оркестратор пишет её в agent_runs.code_version / в payload сдачи программиста,
// чтобы дельты показателей привязывались к конкретной ревизии исполнителя
// (промт программиста живёт в коде, поэтому code_version версионирует и его).
//
// Считается один раз (раннер живёт долго, HEAD за прогон не меняется) и кэшируется.
// Любой сбой git (нет .git, нет бинаря) → null: метка просто не проставится, на
// работу раннера это не влияет.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let cached;

export function resolveCodeVersion({ cwd = REPO_DIR } = {}) {
  if (cached !== undefined) return cached;
  cached = computeCodeVersion(cwd);
  return cached;
}

function computeCodeVersion(cwd) {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim();
    if (!sha) return null;
    let dirty = false;
    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
      });
      dirty = status.trim() !== '';
    } catch { /* статус необязателен */ }
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return null;
  }
}

// Для тестов: сбросить кэш.
export function _resetCodeVersionCache() {
  cached = undefined;
}
