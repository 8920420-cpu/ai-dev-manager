# ensure-fresh-runners.ps1
# RUNNER-FRESHNESS-001 — вотчдог свежести хостовых демонов.
#
# Проблема (повторялась минимум дважды, инциденты 05.07 и 08.07): код раннера
# правится/вливается, но процесс-демон продолжает крутить СТАРЫЙ код — «фикс есть,
# а поведение прежнее» (например, GI без авто-stash уронил 8 задач в BLOCKED).
# Правило «после правок хостовых раннеров — рестарт» на людях не работает,
# поэтому оно закреплено механически:
#   - этот скрипт сравнивает время старта каждого демона с самой свежей mtime его
#     исходников; демон старше кода → точечный рестарт (start-runners.ps1 -Only);
#   - демон не запущен вовсе → поднимается;
#   - вызывается Scheduled Task 'ai-dev-manager runner freshness' каждые 10 минут
#     (scripts/register-freshness-watchdog.ps1) и git-хуками post-commit/post-merge.
#
# Лог: logs/runner-freshness.log (пишется только при действиях/ошибках, тихий
# прогон без устаревших демонов ничего не пишет — лог не растёт вхолостую).

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Starter  = Join-Path $PSScriptRoot 'start-runners.ps1'
$LogFile  = Join-Path $RepoRoot 'logs\runner-freshness.log'

# Демон → { Leaf: подстрока командной строки; Watch: каталоги исходников,
# правка которых требует рестарта }. host-runner дополнительно тянет код
# pipeline-runner (import из ../../pipeline-runner/src) — он тоже в Watch.
# Watch включает 'shared' у всех: раннеры импортируют shared/*.js (heartbeat,
# repoWorktreeLock, httpAuth) — правка общего модуля тоже требует их рестарта.
$Runners = @(
  @{ Name = 'host-runner';             Leaf = 'host-runner.js';             Watch = @('host-runner\bin', 'host-runner\src', 'pipeline-runner\src', 'shared') }
  @{ Name = 'programmer-runner';       Leaf = 'programmer-runner.js';       Watch = @('programmer-runner\bin', 'programmer-runner\src', 'shared') }
  @{ Name = 'codex-runner';            Leaf = 'codex-runner.js';            Watch = @('codex-runner\bin', 'codex-runner\src', 'shared') }
  @{ Name = 'claude-reasoning-runner'; Leaf = 'claude-reasoning-runner.js'; Watch = @('programmer-runner\bin', 'programmer-runner\src', 'shared') }
)

# RUNNER-HEARTBEAT-001: порог «застывшего» heartbeat в минутах. ДОЛЖЕН превышать самый
# долгий ЛЕГИТИМНЫЙ таймаут одной задачи (Architect — 20 мин), иначе раннер, занятый
# долгой задачей, получит ложный рестарт. Дефолт 30 мин; поднять — env
# RUNNER_HEARTBEAT_STALE_MIN. Проверка применяется, только если heartbeat-файл есть
# (старый раннер без heartbeat его не пишет — тогда полагаемся на «не запущен»/«старше
# кода», без ложных срабатываний).
$HeartbeatStaleMinutes = if ($env:RUNNER_HEARTBEAT_STALE_MIN) { [int]$env:RUNNER_HEARTBEAT_STALE_MIN } else { 30 }

function Write-Log([string]$Message) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  try {
    $dir = Split-Path -Parent $LogFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    Add-Content -Path $LogFile -Value $line -Encoding utf8
  } catch {}
}

# Самая свежая mtime исходников демона (только код: .js/.mjs/.cjs/.json, без node_modules).
function Get-NewestSourceTime([string[]]$WatchDirs) {
  $newest = [datetime]::MinValue
  foreach ($rel in $WatchDirs) {
    $dir = Join-Path $RepoRoot $rel
    if (-not (Test-Path $dir)) { continue }
    $files = Get-ChildItem -Path $dir -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Extension -in '.js', '.mjs', '.cjs', '.json' -and $_.FullName -notmatch '\\node_modules\\' }
    foreach ($f in $files) {
      if ($f.LastWriteTime -gt $newest) { $newest = $f.LastWriteTime }
    }
  }
  return $newest
}

$restarted = @()
foreach ($r in $Runners) {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$($r.Leaf)*") }
  $newest = Get-NewestSourceTime $r.Watch

  if (-not $procs) {
    Write-Log "$($r.Name): не запущен — поднимаю"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $Starter -Only $r.Name | Out-Null
    $restarted += $r.Name
    continue
  }

  $started = ($procs | ForEach-Object { $_.CreationDate } | Sort-Object | Select-Object -First 1)
  if ($newest -ne [datetime]::MinValue -and $started -lt $newest) {
    Write-Log ("{0}: устарел (процесс {1:yyyy-MM-dd HH:mm:ss} < код {2:yyyy-MM-dd HH:mm:ss}) — перезапускаю" -f $r.Name, $started, $newest)
    & powershell -NoProfile -ExecutionPolicy Bypass -File $Starter -Restart -Only $r.Name | Out-Null
    $restarted += $r.Name
    continue
  }

  # RUNNER-HEARTBEAT-001: процесс жив и код свежий, но heartbeat застыл дольше порога →
  # «живой, но завис» (рабочий цикл не двигается — напр. claim навсегда повис). Точечный
  # рестарт. Проверяем только при наличии файла: старый раннер без heartbeat его не пишет.
  $hbFile = Join-Path $RepoRoot ("logs\{0}.heartbeat" -f $r.Name)
  if (Test-Path $hbFile) {
    $hbAgeMin = ((Get-Date) - (Get-Item $hbFile).LastWriteTime).TotalMinutes
    if ($hbAgeMin -gt $HeartbeatStaleMinutes) {
      Write-Log ("{0}: завис (heartbeat застыл {1:N0} мин > порога {2} мин, процесс жив) — перезапускаю" -f $r.Name, $hbAgeMin, $HeartbeatStaleMinutes)
      & powershell -NoProfile -ExecutionPolicy Bypass -File $Starter -Restart -Only $r.Name | Out-Null
      $restarted += $r.Name
    }
  }
}

if ($restarted.Count -gt 0) {
  Write-Log ("итог: перезапущены/подняты: {0}" -f ($restarted -join ', '))
} else {
  Write-Host 'Все демоны свежие.'
}
