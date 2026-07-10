# refresh-codebase-memory.ps1
# CODEBASE-MEMORY-AUTOREFRESH-001 — авто-обновление codebase-memory ВЛОЖЕННЫХ корней.
#
# Проблема: `codebase-memory setup` ставит глобальные хуки Claude Code
# (~/.claude/settings.json), но их auto-update прогоняет `codebase-memory update .`
# только в cwd сессии = КОРЕНЬ репозитория. Поэтому корневая память свежая, а
# вложенные memory-корни со своим CLAUDE.md + .claude/rules (например
# `orchestrator-service/backend`, `programmer-runner`) не обновляются никогда и
# протухают. Агенты это отметили: бэкенд-память была пустой/устаревшей.
#
# Этот скрипт инкрементально обновляет вложенные корни тем же движком, что и корень:
#   codebase-memory update <корень>   (подхватывает новые папки/маршруты/модели/
#   команды и дописывает changelog; содержимое НЕ переписывает — это делает analyze).
#
# Триггеры (как у RUNNER-FRESHNESS-001):
#   - git-хуки post-commit/post-merge — точечно, когда коммит/влитие тронули корень
#     (hooksPath = scripts/git-hooks);
#   - Scheduled Task 'ai-dev-manager codebase-memory refresh' — периодически с
#     -IfStale -AllProjects -SyncPg: держит свежей память ВСЕХ проектов оркестратора
#     (root_path из БД) + зеркалит в PG (регистрация register-memory-refresh-watchdog.ps1);
#   - вручную: `.\scripts\refresh-codebase-memory.ps1` — все вложенные корни дерева;
#     `-AllProjects` — все проекты оркестратора; `-SyncPg` — плюс зеркало в PostgreSQL.
#
# Корень репозитория по умолчанию НЕ трогаем (его ведут глобальные хуки Claude Code);
# добавить его можно ключом -IncludeRoot.
#
# Лог: logs/codebase-memory-refresh.log. Скрипт НИКОГДА не бросает наружу
# (exit 0 при любой ошибке) — чтобы не ломать git-операцию, из которой он вызван.

param(
  # Конкретные корни (относительные от корня репо ИЛИ абсолютные). Пусто = все вложенные.
  [string[]]$Only,
  # Включить и корень репозитория в обновление.
  [switch]$IncludeRoot,
  # Обновлять корень только если его исходники новее памяти (для периодического
  # вотчдога: без изменений кода не дёргаем update и не спамим changelog вхолостую).
  [switch]$IfStale,
  # Обновлять память ВСЕХ проектов оркестратора (root_path не-archived проектов из БД),
  # а не только вложенных корней дерева ai-dev-manager. Пути берём через
  # scripts/list-project-roots.mjs. Недоступные пути тихо пропускаются (нет CLAUDE.md).
  [switch]$AllProjects,
  # После обновления, если хоть один корень обновился, зеркалим память в PostgreSQL
  # (npm run memory:sync:pg:all) — чтобы MCP-Codebase-Memory видел свежую версию.
  [switch]$SyncPg
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogFile  = Join-Path $RepoRoot 'logs\codebase-memory-refresh.log'

function Write-Log([string]$Message) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  try {
    $dir = Split-Path -Parent $LogFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    Add-Content -Path $LogFile -Value $line -Encoding utf8
  } catch {}
}

# Резолвим CLI codebase-memory. Предпочитаем .cmd-шим из npm global (APPDATA\npm):
# Get-Command может вернуть .ps1-шим, у которого свои причуды с кодом выхода под
# перенаправлением. Фолбэк — что найдёт Get-Command в PATH.
function Resolve-Cli {
  $cand = Join-Path $env:APPDATA 'npm\codebase-memory.cmd'
  if (Test-Path $cand) { return $cand }
  $cmd = Get-Command codebase-memory -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  return $null
}

# Самая свежая mtime ИСХОДНИКОВ корня (без memory-артефактов и vendor-каталогов) —
# маркер «код менялся». Сравнивается с mtime changelog.md (маркер последнего update).
function Get-NewestSourceTime([string]$AbsRoot) {
  $excludeLeaf = @('CLAUDE.md', 'CONVENTIONS.md', '.cursorrules', '.clinerules',
    '.windsurfrules', '.roomodes', 'copilot-instructions.md')
  $newest = [datetime]::MinValue
  $files = Get-ChildItem -Path $AbsRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
      $_.FullName -notmatch '\\(\.claude|\.git|node_modules)\\' -and
      $excludeLeaf -notcontains $_.Name
    }
  foreach ($f in $files) { if ($f.LastWriteTime -gt $newest) { $newest = $f.LastWriteTime } }
  return $newest
}

# root_path всех НЕ-archived проектов оркестратора (абсолютные пути) — через
# Node-хелпер (пишет в temp-файл, т.к. импорт config/db шумит в stdout).
function Get-DbProjectRoots {
  $helper = Join-Path $RepoRoot 'scripts\list-project-roots.mjs'
  if (-not (Test-Path $helper)) { Write-Log 'list-project-roots.mjs не найден — пропуск -AllProjects'; return @() }
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & node $helper $tmp 2>$null 1>$null
    $ErrorActionPreference = $prev
    if (Test-Path $tmp) {
      return Get-Content -Path $tmp -Encoding utf8 | Where-Object { $_ -and $_.Trim() -ne '' }
    }
  } catch {
    Write-Log ("не удалось получить список проектов из БД — {0}" -f $_.Exception.Message)
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
  return @()
}

# Список вложенных memory-корней (по tracked CLAUDE.md), без корня репо.
function Get-NestedRoots {
  $roots = @()
  try {
    $tracked = & git -C $RepoRoot ls-files 'CLAUDE.md' '**/CLAUDE.md' 2>$null
  } catch { $tracked = @() }
  foreach ($rel in $tracked) {
    if ([string]::IsNullOrWhiteSpace($rel)) { continue }
    $rel = $rel -replace '/', '\'
    $dir = Split-Path -Parent $rel                 # '' для корневого CLAUDE.md
    if ([string]::IsNullOrEmpty($dir)) {
      if (-not $IncludeRoot) { continue }
      $dir = '.'
    }
    if ($roots -notcontains $dir) { $roots += $dir }
  }
  return $roots
}

try {
  # codebase-memory (v1.1.0) на top-level читает process.env.HOME (setup.js) — в Git
  # Bash он задан, а в PowerShell/cmd HOME не определён, и импорт падает ещё до старта
  # команды (ERR_INVALID_ARG_TYPE, node:path). Подставляем USERPROFILE, чтобы CLI
  # вообще запустился (само значение для `update` не используется).
  if (-not $env:HOME) { $env:HOME = $env:USERPROFILE }

  $cli = Resolve-Cli
  if (-not $cli) {
    Write-Log 'codebase-memory CLI не найден (ни в PATH, ни в APPDATA\npm) — пропуск'
    exit 0
  }

  if ($Only -and $Only.Count -gt 0) {
    $targets = $Only | ForEach-Object { ($_ -replace '/', '\').TrimEnd('\') }
  } elseif ($AllProjects) {
    $targets = Get-DbProjectRoots
  } else {
    $targets = Get-NestedRoots
  }

  if (-not $targets -or $targets.Count -eq 0) {
    Write-Host 'Нет корней для обновления.'
    exit 0
  }

  $updated = 0
  foreach ($rel in ($targets | Select-Object -Unique)) {
    if ($rel -eq '.' -or $rel -eq '') {
      $abs = $RepoRoot
    } elseif ([System.IO.Path]::IsPathRooted($rel)) {
      $abs = $rel                       # абсолютный путь (из БД / -AllProjects)
    } else {
      $abs = Join-Path $RepoRoot $rel   # относительный от корня репо
    }
    if (-not (Test-Path (Join-Path $abs 'CLAUDE.md'))) {
      Write-Log "$rel : нет CLAUDE.md — пропуск (нужен codebase-memory analyze)"
      continue
    }
    # -IfStale: пропускаем корень, если память не старше исходников (нечего обновлять).
    if ($IfStale) {
      $clog = Join-Path $abs '.claude\rules\changelog.md'
      if (Test-Path $clog) {
        $memTime = (Get-Item $clog).LastWriteTime
        $srcTime = Get-NewestSourceTime $abs
        if ($srcTime -ne [datetime]::MinValue -and $srcTime -le $memTime) {
          continue   # память свежее исходников — тихо пропускаем (без записи в лог)
        }
      }
    }
    # Вызов нативного CLI. В Windows PowerShell 5.1 перенаправление stderr нативного
    # процесса под EAP=Stop превращается в терминирующую ошибку (а codebase-memory
    # пишет в stderr безобидный шум — его git-вызовы используют `2>/dev/null`, что для
    # cmd невалидно). Поэтому на время вызова ставим EAP=Continue и глушим оба потока;
    # успех определяем по коду выхода ($LASTEXITCODE), тул всегда завершается 0.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & $cli update "$abs" 2>$null 1>$null
      $code = $LASTEXITCODE
    } catch {
      $code = -1
      Write-Log ("{0} : ошибка обновления — {1}" -f $rel, $_.Exception.Message)
    } finally {
      $ErrorActionPreference = $prevEap
    }
    if ($code -eq 0) {
      Write-Log "$rel : обновлён"
      $updated += 1
    } elseif ($code -ne -1) {
      Write-Log "$rel : codebase-memory update завершился с кодом $code"
    }
  }

  # -SyncPg: если хоть один корень обновился — зеркалим память всех проектов в PG
  # (idempotent upsert по checksum). Без изменений — PG не трогаем (лишних записей нет).
  if ($SyncPg -and $updated -gt 0) {
    $sync = Join-Path $RepoRoot 'scripts\sync-codebase-memory-to-postgres.js'
    if (Test-Path $sync) {
      if (-not $env:HOME) { $env:HOME = $env:USERPROFILE }
      $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      & node $sync --all-projects 2>$null 1>$null
      $syncCode = $LASTEXITCODE
      $ErrorActionPreference = $prev
      # sync-скрипт: 0 — всё синкнуто; 2 — часть проектов без файлов памяти (не ошибка).
      if ($syncCode -eq 0 -or $syncCode -eq 2) {
        Write-Log "PG-зеркало обновлено (memory:sync:pg:all, обновлённых корней: $updated)"
      } else {
        Write-Log "PG-зеркало: sync завершился с кодом $syncCode"
      }
    }
  }
} catch {
  try { Write-Log ("сбой: {0}" -f $_.Exception.Message) } catch {}
}

exit 0
