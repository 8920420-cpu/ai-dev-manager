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

# Подхватываем настройки раннеров из .env и прокидываем их в $env: текущего
# процесса. Start-Process наследует окружение родителя, поэтому запущенные ниже
# демоны (в т.ч. programmer-runner) увидят эти значения автоматически.
#
# Зачем не только ORCHESTRATOR_API_TOKEN: PROGRAMMER_MAX_TURNS=100 в .env раньше
# не доходил до раннера — лимит ходов брался из дефолта в коде
# (programmer-runner/src/claudeAgent.js). Теперь .env — реальный источник истины.
#
# Семантика источников:
#   - ORCHESTRATOR_API_TOKEN: ставим только если ещё не задан в окружении
#     (внешнее окружение имеет приоритет — токен может прийти из секрет-стора);
#   - PROGRAMMER_MAX_TURNS / PROGRAMMER_MODEL: значение из .env ПОБЕЖДАЕТ дефолт
#     кода раннера, поэтому ставим безусловно (если непустое).
$EnvFile = Join-Path $RepoRoot '.env'
# Имена переменных, которые забираем из .env. true → .env переопределяет $env:,
# false → не трогаем уже заданное окружение.
$EnvKeys = [ordered]@{
  'ORCHESTRATOR_API_TOKEN' = $false
  'PROGRAMMER_MAX_TURNS'   = $true
  'PROGRAMMER_MODEL'       = $true
  # COLDSTART-MCP-ISOLATION-001: для доверенных read-only reasoning-прогонов снимает
  # песочницу codex (per-command restricted-token spawn — главный источник медленных
  # read-команд и их таймаутов на Windows). .env побеждает дефолт кода раннера.
  'CODEX_BYPASS_SANDBOX'   = $true
}
if (Test-Path $EnvFile) {
  foreach ($line in Get-Content $EnvFile) {
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$') {
      $key = $Matches[1]
      if (-not $EnvKeys.Contains($key)) { continue }
      $val = $Matches[2].Trim('"').Trim("'")
      if (-not $val) { continue }
      $override = $EnvKeys[$key]
      if ($override -or -not (Get-Item -Path "Env:$key" -ErrorAction SilentlyContinue)) {
        Set-Item -Path "Env:$key" -Value $val
      }
    }
  }
}

# Диагностика эффективного лимита ходов программиста и его источника.
if ($env:PROGRAMMER_MAX_TURNS) {
  Write-Host "CONFIG: PROGRAMMER_MAX_TURNS=$($env:PROGRAMMER_MAX_TURNS) (источник: .env/окружение)"
} else {
  Write-Host 'CONFIG: PROGRAMMER_MAX_TURNS не задан — раннер возьмёт дефолт кода (100)'
}

# База оркестратора — опубликованный из Docker порт 4186 (если не задано иначе).
if (-not $env:ORCHESTRATOR_URL) { $env:ORCHESTRATOR_URL = 'http://localhost:4186' }

# INCIDENT-FIX 2026-06-28: жёсткий таймаут задачи у рассуждающих раннеров ДОЛЖЕН
# быть меньше орфан-таймаута оркестратора (RUNNER_ROLE_TIMEOUT_MS), иначе реапер
# освободит захват раньше нас и мы сдадим его «вхолостую».
# OBSERVABILITY-REASONING-001 2026-06-29: 150с хватало только DeepSeek-reasoning.
# Architect/Decomposer на Claude Code (агентный tool-loop, ~21с холодный старт +
# чтение проекта) не влезали → agent_aborted на 150с по кругу. Подняли до 540с (9 мин),
# что < орфан-таймаута оркестратора 600с (10 мин). Можно переопределить в окружении.
# CONFIG-AUDIT-001: фиксируем источник значения. Guard `if (-not $env:X)` означает,
# что УЖЕ заданное в окружении значение (в т.ч. устаревшее, унаследованное из прежней
# сессии/Scheduled Task) молча победит дефолт скрипта. Поэтому ниже печатаем
# эффективное значение и его источник — чтобы было видно, откуда взялся taskTimeout
# (напр. неожиданные 150000ms = унаследованный env, а не дефолт 540000).
$codexTimeoutSrc  = if ($env:CODEX_TASK_TIMEOUT_MS) { 'env(inherited)' } else { 'default' }
$claudeTimeoutSrc = if ($env:CLAUDE_REASONING_TASK_TIMEOUT_MS) { 'env(inherited)' } else { 'default' }
if (-not $env:CODEX_TASK_TIMEOUT_MS)            { $env:CODEX_TASK_TIMEOUT_MS = '540000' }
if (-not $env:CLAUDE_REASONING_TASK_TIMEOUT_MS) { $env:CLAUDE_REASONING_TASK_TIMEOUT_MS = '540000' }
Write-Host "CONFIG: CODEX_TASK_TIMEOUT_MS=$($env:CODEX_TASK_TIMEOUT_MS) ($codexTimeoutSrc), CLAUDE_REASONING_TASK_TIMEOUT_MS=$($env:CLAUDE_REASONING_TASK_TIMEOUT_MS) ($claudeTimeoutSrc)"

# OBSERVABILITY-REASONING-001: рассуждающие роли через Claude Code — параллелизм 1.
# При concurrency=2 подписка упиралась в rate-limit (rateLimited=true в каждом прогоне);
# 1 агент работает без троттлинга и быстрее доводит задачу. Менять при необходимости.
if (-not $env:CLAUDE_REASONING_CONCURRENCY)     { $env:CLAUDE_REASONING_CONCURRENCY = '1' }

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
