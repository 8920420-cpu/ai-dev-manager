// VERSION-KPI-TRACKING-001 — версия кода раннера для атрибуции KPI.
//
// Дубликат programmer-runner/src/codeVersion.js (как и ReasoningRunner.js) —
// любую правку синхронизируй в обоих. Возвращает короткий git-SHA репозитория
// раннера (+«-dirty» при незакоммиченном дереве). Считается один раз и кэшируется;
// любой сбой git → null (метка просто не проставится).
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
