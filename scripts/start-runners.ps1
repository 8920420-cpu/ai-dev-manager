# start-runners.ps1
# Запускает хост-демонов host-runner и programmer-runner в фоне на этой машине.
#
# Почему хост, а не docker-compose: оба процесса по своей природе работают в
# интерактивной сессии пользователя:
#   - host-runner   гоняет docker/git на хосте, открывает PowerShell-диалог
#                   выбора папки и `claude setup-token` (OAuth в браузере);
#   - programmer-runner запускает headless Claude Code на репозиториях хоста и
#                   опирается на залогиненную подписку Claude текущего пользователя.
#   - codex-runner  гоняет headless `codex exec` на рассуждающих ролях,
#                   делегированных Codex, на подписке ChatGPT текущего пользователя.
# В Linux-контейнере этого нет, поэтому демоны живут на хосте.
#
# Скрипт идемпотентен: повторный запуск не плодит дубликаты (проверяет уже
# работающие процессы по командной строке). Логи пишутся в logs/.
#
# Параметры:
#   -Restart   сначала остановить уже запущенные демоны, затем поднять заново.

param(
  [switch]$Restart
)

$ErrorActionPreference = 'Stop'

# Корень репозитория — родитель каталога scripts.
$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogDir   = Join-Path $RepoRoot 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# Node на PATH обязателен.
$Node = (Get-Command node -ErrorAction SilentlyContinue)
if ($null -eq $Node) { throw 'node не найден в PATH. Установите Node.js >= 18 или добавьте его в PATH.' }

# Опционально подхватываем ORCHESTRATOR_API_TOKEN из .env (если /api закрыт токеном).
$EnvFile = Join-Path $RepoRoot '.env'
if (Test-Path $EnvFile) {
  foreach ($line in Get-Content $EnvFile) {
    if ($line -match '^\s*ORCHESTRATOR_API_TOKEN\s*=\s*(.+?)\s*$') {
      $val = $Matches[1].Trim('"').Trim("'")
      if ($val) { $env:ORCHESTRATOR_API_TOKEN = $val }
    }
  }
}

# База оркестратора — опубликованный из Docker порт 4186 (если не задано иначе).
if (-not $env:ORCHESTRATOR_URL) { $env:ORCHESTRATOR_URL = 'http://localhost:4186' }

# INCIDENT-FIX 2026-06-28: жёсткий таймаут задачи у рассуждающих раннеров ДОЛЖЕН
# быть меньше орфан-таймаута оркестратора (RUNNER_ROLE_TIMEOUT_MS, теперь 3 мин),
# иначе реапер освободит захват раньше нас и мы сдадим его «вхолостую». Ставим 150с
# (SUCCESS-прогон укладывается в секунды). Можно переопределить заранее в окружении.
if (-not $env:CODEX_TASK_TIMEOUT_MS)            { $env:CODEX_TASK_TIMEOUT_MS = '150000' }
if (-not $env:CLAUDE_REASONING_TASK_TIMEOUT_MS) { $env:CLAUDE_REASONING_TASK_TIMEOUT_MS = '150000' }

# Уже запущенные node-процессы демонов (по подстроке скрипта в командной строке).
function Get-RunnerProcs([string]$ScriptLeaf) {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$ScriptLeaf*") }
}

function Stop-Runner([string]$ScriptLeaf, [string]$Title) {
  $procs = Get-RunnerProcs $ScriptLeaf
  foreach ($p in $procs) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Host "  остановлен $Title (PID $($p.ProcessId))" }
    catch { Write-Warning "  не удалось остановить $Title (PID $($p.ProcessId)): $($_.Exception.Message)" }
  }
}

# Запуск одного демона: фоном, окно скрыто, вывод -> logs/<name>.log.
function Start-Runner([string]$Name, [string]$WorkDir, [string]$ScriptRel) {
  $leaf = Split-Path -Leaf $ScriptRel
  if (-not $Restart) {
    $existing = Get-RunnerProcs $leaf
    if ($existing) {
      Write-Host "= $Name уже запущен (PID $((($existing | Select-Object -First 1).ProcessId))) — пропускаю"
      return
    }
  }
  $log = Join-Path $LogDir "$Name.log"
  $proc = Start-Process -FilePath $Node.Source `
    -ArgumentList @($ScriptRel) `
    -WorkingDirectory $WorkDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $log `
    -RedirectStandardError "$log.err" `
    -PassThru
  Write-Host "+ $Name запущен (PID $($proc.Id)) — лог: $log"
}

if ($Restart) {
  Write-Host 'Останавливаю запущенные демоны...'
  Stop-Runner 'host-runner.js'            'host-runner'
  Stop-Runner 'programmer-runner.js'      'programmer-runner'
  Stop-Runner 'codex-runner.js'           'codex-runner'
  Stop-Runner 'claude-reasoning-runner.js' 'claude-reasoning-runner'
  Start-Sleep -Milliseconds 400
}

Write-Host "Оркестратор: $($env:ORCHESTRATOR_URL)"
Start-Runner 'host-runner'             (Join-Path $RepoRoot 'host-runner')       'bin/host-runner.js'
Start-Runner 'programmer-runner'       (Join-Path $RepoRoot 'programmer-runner') 'bin/programmer-runner.js'
Start-Runner 'codex-runner'            (Join-Path $RepoRoot 'codex-runner')      'bin/codex-runner.js'
# Claude как движок рассуждающих ролей (engine=claude_code) живёт в пакете
# programmer-runner (общий Agent SDK и загрузка токена), отдельной bin-точкой.
Start-Runner 'claude-reasoning-runner' (Join-Path $RepoRoot 'programmer-runner') 'bin/claude-reasoning-runner.js'
Write-Host 'Готово. Проверить: Get-Content logs/host-runner.log -Tail 20'
