# patch-codebase-memory-tool.ps1
# CODEBASE-MEMORY-TOOLPATCH-001 — идемпотентная накатка наших правок на ГЛОБАЛЬНЫЙ
# пакет codebase-memory (%APPDATA%\npm\node_modules\codebase-memory).
#
# Зачем скрипт, а не «поправить руками»: правки живут ВНЕ репозитория и стираются
# при `npm i -g codebase-memory` / апдейте тула. Раньше это уже стреляло —
# память корня ai-dev-manager простояла с пустыми модулями («0 файлов» у всех 26)
# c 10.07 по 20.07, потому что analyze прогнали до накатки патча separator.
#
# Патчи:
#   1) scanner.js / getFileTree — glob на Windows отдаёт пути с '\', а вызывающий код
#      фильтрует модули через startsWith(folder + '/') и матчит маршруты/модели
#      forward-slash регулярками. Без нормализации у ВСЕХ модулей «0 файлов».
#   2) update.js / changelog — тул дописывает запись в changelog при КАЖДОМ запуске,
#      даже когда структурных изменений нет. В связке с 30-минутным вотчдогом это
#      даёт сотни записей «No structural changes detected» (на 20.07 — 680 пустых
#      против 14 содержательных), которые вытесняют полезное из памяти агентов.
#
# Скрипт идемпотентен: уже пропатченный файл не трогает. Ничего не бросает наружу
# (exit 0), чтобы не ломать вызывающую операцию — как refresh-codebase-memory.ps1.
#
# Вызов: вручную `.\scripts\patch-codebase-memory-tool.ps1` либо автоматически из
# refresh-codebase-memory.ps1 перед прогоном update.

param(
  # Только проверить состояние патчей, ничего не менять (код выхода всё равно 0).
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogFile  = Join-Path $RepoRoot 'logs\codebase-memory-refresh.log'

function Write-Log([string]$Message) {
  $line = "{0} [toolpatch] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  try {
    $dir = Split-Path -Parent $LogFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    Add-Content -Path $LogFile -Value $line -Encoding utf8
  } catch {}
}

# Читаем/пишем строго UTF-8 без BOM: node-исходники тула должны остаться валидными.
function Read-Text([string]$Path) {
  return [System.IO.File]::ReadAllText($Path, [System.Text.UTF8Encoding]::new($false))
}
function Write-Text([string]$Path, [string]$Content) {
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

try {
  $pkgRoot = Join-Path $env:APPDATA 'npm\node_modules\codebase-memory'
  if (-not (Test-Path $pkgRoot)) {
    Write-Log 'пакет codebase-memory не найден в %APPDATA%\npm — пропуск'
    exit 0
  }

  $applied = 0
  $already = 0

  # --- Патч 1: нормализация separator в getFileTree (scanner.js) ---------------
  $scanner = Join-Path $pkgRoot 'src\utils\scanner.js'
  if (Test-Path $scanner) {
    $text = Read-Text $scanner
    if ($text -match 'split\(path\.sep\)\.join\(''/''\)') {
      $already += 1
    } else {
      $needle = '  return files.sort();'
      if ($text.Contains($needle)) {
        $replacement = @'
  // PATCHED(ai-dev-manager, CODEBASE-MEMORY-TOOLPATCH-001): glob returns backslash-
  // separated paths on Windows, but callers filter with `file.startsWith(folder + '/')`
  // and forward-slash route/model regexes — normalize to POSIX separators so module
  // file lists and route/model detection actually work.
  return files.map(f => f.split(path.sep).join('/')).sort();
'@
        if (-not $CheckOnly) {
          Write-Text $scanner ($text.Replace($needle, $replacement.TrimEnd()))
        }
        $applied += 1
        Write-Log 'scanner.js: применена нормализация separator (getFileTree)'
      } else {
        Write-Log 'scanner.js: якорь `return files.sort();` не найден — тул изменился, патч НЕ применён'
      }
    }
  } else {
    Write-Log 'scanner.js не найден — пропуск патча 1'
  }

  # --- Патч 2: не писать пустую запись в changelog (update.js) -----------------
  $update = Join-Path $pkgRoot 'src\commands\update.js'
  if (Test-Path $update) {
    $text = Read-Text $update
    # Детектим по ЯКОРЮ, а не по маркеру: якорь — безусловный вызов appendFile с
    # двухпробельным отступом; после патча он уезжает внутрь if и получает четыре
    # пробела, поэтому пропажа якоря = патч на месте.
    #
    # Якорь обязан быть ПОСТРОЧНЫМ regex'ом ((?m)^ + ровно два пробела), а не
    # подстрокой: String.Contains('  appendFile...') остаётся истинным и после патча,
    # потому что четырёхпробельная строка содержит двухпробельную как подстроку —
    # с ним скрипт считал себя ненакаченным на каждом прогоне.
    $anchor = "(?m)^  appendFile\(path\.join\(rulesDir, 'changelog\.md'\), changelogEntry\);"
    if ($text -match $anchor) {
      $replacement = @'
  // PATCHED(ai-dev-manager, CODEBASE-MEMORY-TOOLPATCH-001): changelog — пишем запись
  // только при реальных структурных изменениях. Безусловный append в связке с
  // периодическим вотчдогом забивал память сотнями «No structural changes detected».
  if (changes.length) {
    appendFile(path.join(rulesDir, 'changelog.md'), changelogEntry);
  }
'@
      if (-not $CheckOnly) {
        # $$ — экранирование для [regex]::Replace, чтобы '$' в тексте не съелся.
        $safe = $replacement.TrimEnd().Replace('$', '$$$$')
        Write-Text $update ([regex]::Replace($text, $anchor, $safe))
      }
      $applied += 1
      Write-Log 'update.js: пустые записи changelog больше не пишутся'
    } elseif ($text.Contains('CODEBASE-MEMORY-TOOLPATCH-001')) {
      $already += 1
    } else {
      Write-Log 'update.js: якорь appendFile(changelog.md) не найден — тул изменился, патч НЕ применён'
    }
  } else {
    Write-Log 'update.js не найден — пропуск патча 2'
  }

  if ($CheckOnly) {
    Write-Log "проверка: уже пропатчено $already, требуют накатки $applied"
  } elseif ($applied -gt 0) {
    Write-Log "накатано патчей: $applied (уже было: $already)"
  }
} catch {
  try { Write-Log ("сбой: {0}" -f $_.Exception.Message) } catch {}
}

exit 0
