// PROGRAMMER-SELF-CHECK-001 — петля самопроверки программиста.
//
// Зачем: до этого стадия CODING была one-shot — агент отработал, сказал про себя
// success=true, и дельта уезжала дальше по конвейеру. Тесты гонялись только на
// СЛЕДУЮЩЕЙ стадии (TESTING/PIPELINE_SERVICE), то есть красный код успевал стать
// коммитом в ветке программиста, а обратная связь возвращалась к нему через целый
// круг конвейера — если возвращалась вообще. Живая сессия так не работает: там цикл
// «поменял → прогнал → увидел красное → починил» замыкается за секунды.
//
// Здесь этот цикл замыкается внутри одного захвата задачи: после успешного прогона
// агента прогоняем команды проверки прямо в worktree и, если они красные, отдаём
// агенту вывод ошибки на ремонт (до PROGRAMMER_SELF_CHECK_ATTEMPTS попыток).
//
// ВАЖНО — baseline. Если тесты в проекте были красными ЕЩЁ ДО работы агента, то
// требовать от него зелёного нельзя: он не чинил бы свою задачу, а бесконечно
// требушил чужие поломки, все задачи проекта уходили бы в BLOCKED через
// escalateProgrammerReleaseLoop. Поэтому проверку сначала гоняем ДО агента: красный
// baseline переводит самопроверку в необязательный режим (только лог и отметка в
// result), зелёный — делает её блокирующей.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Сколько символов вывода упавшей команды показываем агенту и пишем в result. */
const OUTPUT_TAIL = 4000;

/** Таймаут одной команды проверки. Должен быть заметно меньше таймаута задачи. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 5 * 60 * 1000;

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Тест-стек каталога — та же логика, что у pipeline-runner/ConventionConfigBuilder
 * (`testStackAt`): 'go' — есть go.mod; 'node' — package.json с непустым скриптом
 * test; null — проверять нечем. Намеренно продублировано, а не импортировано:
 * programmer-runner не зависит от pipeline-runner, и связывать их ради одной
 * функции дороже, чем повторить десять строк.
 */
export function detectStack(absDir) {
  if (isFile(path.join(absDir, 'go.mod'))) return 'go';
  const pkgPath = path.join(absDir, 'package.json');
  if (isFile(pkgPath)) {
    let pkg = null;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
      pkg = null;
    }
    const testScript = pkg?.scripts?.test;
    if (typeof testScript === 'string' && testScript.trim()) return 'node';
  }
  return null;
}

/**
 * Каталог, в котором проверяем: сначала подкаталог сервиса (монорепозиторий вроде
 * PS, где service=Chat_Service лежит своим пакетом), иначе корень worktree.
 */
export function resolveVerifyDir(worktreeCwd, task) {
  const service = String(task?.service || '').trim();
  if (service) {
    const candidate = path.join(worktreeCwd, service);
    if (existsSync(candidate) && detectStack(candidate)) return candidate;
  }
  return worktreeCwd;
}

/**
 * Команды проверки для каталога. PROGRAMMER_VERIFY_CMD (через `&&` — несколько)
 * перекрывает автодетект: у монорепозиториев с нестандартной раскладкой угадать
 * нельзя, а заставлять раннер угадывать — хуже, чем дать явно задать.
 */
export function detectVerifyCommands(absDir, { envOverride } = {}) {
  const override = String(envOverride ?? process.env.PROGRAMMER_VERIFY_CMD ?? '').trim();
  if (override) {
    return override.split('&&').map((c) => c.trim()).filter(Boolean);
  }
  const stack = detectStack(absDir);
  if (stack === 'go') return ['go test ./...'];
  if (stack === 'node') return ['npm test'];
  return [];
}

/**
 * Убить ДЕРЕВО процессов команды, а не только оболочку.
 *
 * `spawn(cmd, {shell:true})` запускает cmd.exe/sh, а тесты — уже его дети. Обычный
 * child.kill() снимает только оболочку: внук (node/go) доживает до конца сам и всё
 * это время держит открытыми унаследованные stdio, поэтому событие 'close' не
 * приходит — таймаут «срабатывал», но ждали мы всё равно полного прогона.
 */
function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    // taskkill /T — вся ветка процессов, /F — принудительно. СИНХРОННО и намеренно:
    // асинхронный spawn здесь не срабатывал (процесс успевал пережить снятие и
    // продолжал писать в файлы ещё секунды), а kill — операция редкая и быстрая.
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000,
      });
      return;
    } catch { /* уже мёртв или taskkill недоступен — ниже страховочный kill */ }
  } else {
    // detached:true даёт отдельную группу процессов — снимаем её целиком.
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* группы нет — ниже */ }
  }
  try { child.kill('SIGKILL'); } catch { /* процесс уже мёртв */ }
}

/** Хвост вывода — ошибки почти всегда в конце, а начало съедает контекст агента. */
export function tailOutput(text, limit = OUTPUT_TAIL) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  return `…(обрезано ${s.length - limit} символов)\n${s.slice(-limit)}`;
}

/**
 * Запустить одну команду. Никогда не бросает: результат — всегда объект исхода
 * ({ok:false, timedOut/aborted}), потому что самопроверка не должна ронять задачу
 * сама по себе.
 */
export function runVerifyCommand(cmd, { cwd, env, signal, timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, {
        cwd,
        env: { ...process.env, ...(env || {}), CI: '1' },
        shell: true,
        windowsHide: true,
        // На POSIX даёт собственную группу процессов, чтобы killTree снял её целиком.
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve({ cmd, ok: false, error: `spawn_failed: ${error.message}`, output: '' });
      return;
    }

    let out = '';
    const append = (chunk) => {
      out += String(chunk);
      // Держим буфер ограниченным: тестовые прогоны бывают многомегабайтными.
      if (out.length > OUTPUT_TAIL * 4) out = out.slice(-OUTPUT_TAIL * 2);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    let timedOut = false;
    let aborted = false;
    let settled = false;
    // Страховка: если после kill дерево всё же удержало stdio и 'close' не пришёл,
    // не зависаем в ожидании — отдаём исход сами.
    let giveUpTimer = null;
    const kill = () => {
      killTree(child);
      if (!giveUpTimer) giveUpTimer = setTimeout(() => finish(null), 2000);
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => { aborted = true; kill(); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (exitCode, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({
        cmd,
        ok: !timedOut && !aborted && exitCode === 0 && !error,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        timedOut: timedOut || undefined,
        aborted: aborted || undefined,
        error: error ? String(error.message || error) : undefined,
        output: tailOutput(out),
      });
    };
    child.on('error', (error) => finish(null, error));
    child.on('close', (code) => finish(code));
  });
}

/**
 * Прогнать все команды по порядку, остановившись на первой упавшей (смысла гонять
 * остальные нет — агенту всё равно чинить эту).
 * @returns {Promise<{ok:boolean, ran:Array, failure?:Object, skipped?:boolean}>}
 */
export async function runVerify({ commands, cwd, env, signal, timeoutMs, log } = {}) {
  const list = Array.isArray(commands) ? commands.filter(Boolean) : [];
  if (!list.length) return { ok: true, skipped: true, ran: [] };

  const ran = [];
  for (const cmd of list) {
    log?.info?.('programmer self-check: запуск проверки', { cmd, cwd });
    const res = await runVerifyCommand(cmd, { cwd, env, signal, timeoutMs });
    ran.push({ cmd: res.cmd, ok: res.ok, exitCode: res.exitCode, timedOut: res.timedOut });
    if (!res.ok) return { ok: false, ran, failure: res };
    if (signal?.aborted) return { ok: false, ran, failure: { cmd, ok: false, aborted: true, output: '' } };
  }
  return { ok: true, ran };
}
