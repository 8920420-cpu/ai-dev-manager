// Нативный системный диалог выбора папки на Windows-хосте.
//
// host-runner работает нативно на той же машине, где открыт браузер с UI, и где
// есть powershell.exe — поэтому именно он может вернуть АБСОЛЮТНЫЙ путь папки,
// который браузер из соображений безопасности не отдаёт.
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

// STA-поток + TopMost-форма, чтобы диалог не уходил за окна. Путь печатаем в
// UTF-8, чтобы корректно отдавать кириллицу (K:\Роботы\…).
const PS_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Выберите папку для сканера'
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
$owner.Dispose()
`;

function pickFolderWindows() {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', PS_SCRIPT],
      { windowsHide: true },
    );
    let out = '';
    let err = '';
    ps.stdout.setEncoding('utf8');
    ps.stderr.setEncoding('utf8');
    ps.stdout.on('data', (c) => (out += c));
    ps.stderr.on('data', (c) => (err += c));
    ps.on('error', reject);
    ps.on('close', (code) => {
      if (code !== 0) return reject(new Error(`powershell exited ${code}: ${err.trim()}`));
      resolve(out.trim()); // пусто, если пользователь нажал «Отмена»
    });
  });
}

/**
 * Открыть нативный диалог выбора папки.
 * @returns {Promise<{ ok: true, path: string|null, cancelled: boolean }>}
 * @throws  Error с code='unsupported_platform' на не-Windows.
 */
export async function pickFolder() {
  if (platform() !== 'win32') {
    const e = new Error('Нативный выбор папки доступен только на Windows-хосте');
    e.code = 'unsupported_platform';
    throw e;
  }
  const p = await pickFolderWindows();
  return { ok: true, path: p || null, cancelled: p === '' };
}
