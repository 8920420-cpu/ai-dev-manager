// Выпуск/сохранение токена подписки Claude Code для programmer-runner.
//
// Бэкенд оркестратора в Linux-контейнере не может ни открыть браузер, ни
// запустить хостовый `claude` — поэтому это делает host-runner (нативно на той же
// машине, где открыт UI и установлен Claude Code), по аналогии с folderPicker.
//
// Два пути:
//   1) запустить `claude setup-token` → команда открывает браузер для OAuth и
//      печатает долгоживущий токен (sk-ant-oat01-…); ловим его из вывода;
//   2) принять вручную вставленный токен (fallback, если setup-token требует TTY
//      и не отдаёт вывод в pipe).
// Токен сохраняется в файл, который programmer-runner подхватывает как
// CLAUDE_CODE_OAUTH_TOKEN (см. programmer-runner/src/loadToken.js — общий путь).
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Формат токена подписки: префикс фиксирован, тело — base64url. Длину не
// фиксируем жёстко (в разных версиях может отличаться).
const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;

export function tokenFilePath() {
  if (process.env.PROGRAMMER_TOKEN_FILE) return process.env.PROGRAMMER_TOKEN_FILE;
  return path.join(os.homedir(), '.ai-dev-manager', 'claude_oauth_token');
}

export function isValidToken(t) {
  return typeof t === 'string' && TOKEN_RE.test(t.trim());
}

export function maskToken(t) {
  const s = String(t || '');
  return s.length > 16 ? `${s.slice(0, 12)}…${s.slice(-4)}` : '••••';
}

export async function saveToken(token) {
  const file = tokenFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${String(token).trim()}\n`, { mode: 0o600 });
  try {
    await fs.chmod(file, 0o600);
  } catch {
    /* на Windows права файла ограничены — не критично */
  }
  return file;
}

// Запустить `claude setup-token`, поймать токен из вывода. Команда открывает
// браузер сама. Может требовать TTY — тогда вывод не придёт и мы отвергаем (UI
// предложит вставить токен вручную).
export function runSetupToken({ timeoutMs = 5 * 60 * 1000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnImpl('claude setup-token', { shell: true, windowsHide: false });
    } catch (e) {
      return reject(e);
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      reject(new Error('claude setup-token: таймаут авторизации (5 мин)'));
    }, timeoutMs);
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', (c) => { out += c; });
    proc.stderr?.on('data', (c) => { err += c; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const m = `${out}\n${err}`.match(TOKEN_RE);
      if (m) return resolve(m[0]);
      reject(new Error(
        `claude setup-token: токен не найден в выводе (код ${code}). `
        + 'Возможно, команда требует терминал — вставьте токен вручную. '
        + err.trim().slice(0, 200),
      ));
    });
  });
}

/**
 * Точка для HTTP-моста. Либо принять вручную вставленный `token`, либо запустить
 * `claude setup-token` и поймать его. Сохраняет в файл, возвращает путь и маску.
 * @param {{token?:string}} [opts]
 * @param {{runSetupToken?:Function, saveToken?:Function}} [deps]  для тестов
 */
export async function setupClaudeToken({ token } = {}, deps = {}) {
  const runner = deps.runSetupToken || runSetupToken;
  const save = deps.saveToken || saveToken;

  let value = String(token || '').trim();
  let source = 'manual';
  if (value) {
    if (!isValidToken(value)) {
      const e = new Error('Это не похоже на токен Claude (ожидается sk-ant-oat01-…)');
      e.code = 'invalid_token';
      throw e;
    }
  } else {
    source = 'setup-token';
    value = await runner();
  }
  const savedTo = await save(value);
  return { ok: true, source, savedTo, tokenMasked: maskToken(value) };
}
