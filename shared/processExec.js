// PROGRAMMER-SELF-CHECK-001 / PIPELINE — кроссплатформенное завершение ДЕРЕВА
// процессов запущенной команды.
//
// `spawn(cmd, {shell:true})` порождает cmd.exe/sh, а реальная команда (node/go) —
// уже его ребёнок. Обычный child.kill() снимает только оболочку: внук доживает
// прогон до конца, держит унаследованные stdio, событие 'close' не приходит —
// таймаут «срабатывает», но фактически ждём полного завершения.
//
// Единый источник для programmer-runner/selfCheck.js и pipeline-runner/
// CommandExecutor.js. Раньше logic был продублирован в двух местах, причём копия
// в CommandExecutor использовала АСИНХРОННЫЙ spawn('taskkill') — он не срабатывал
// (процесс переживал снятие и продолжал писать в файлы ещё секунды, оставаясь
// зомби). Каноничен СИНХРОННЫЙ taskkill (см. CLAUDE.md PROGRAMMER-SELF-CHECK-001).
import { spawn, execFileSync } from 'node:child_process';
import process from 'node:process';

/**
 * Убить процесс `child` вместе со всем деревом его потомков.
 * @param {import('node:child_process').ChildProcess} child
 */
export function killProcessTree(child) {
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
