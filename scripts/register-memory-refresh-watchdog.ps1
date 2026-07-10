# register-memory-refresh-watchdog.ps1
# CODEBASE-MEMORY-AUTOREFRESH-001 — регистрирует Scheduled Task, который периодически
# запускает scripts/refresh-codebase-memory.ps1 с ключами -IfStale -AllProjects -SyncPg:
#   - -AllProjects: перебирает root_path ВСЕХ не-archived проектов оркестратора из БД
#     (не только дерево ai-dev-manager) — ПС, LandingHub, Smeta и т.д. тоже держатся
#     свежими;
#   - -IfStale: обновляет корень, только если его исходники новее памяти (при свежей
#     памяти таск ничего не пишет — changelog не пухнет вхолостую);
#   - -SyncPg: если хоть один корень обновился, зеркалит память в PostgreSQL
#     (memory:sync:pg:all), чтобы MCP-Codebase-Memory видел свежую версию.
# Это периодическая ПОДСТРАХОВКА к git-хукам post-commit/post-merge (на случай правок
# без коммита, пропущенного хука или проектов вне дерева ai-dev-manager).
# Принципал — интерактивный текущий пользователь (как у 'ai-dev-manager runner
# freshness': демонам/CLI нужна его сессия — node/git/подписка).

$ErrorActionPreference = 'Stop'

$TaskName = 'ai-dev-manager codebase-memory refresh'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Script   = Join-Path $PSScriptRoot 'refresh-codebase-memory.ps1'
if (-not (Test-Path $Script)) { throw "Не найден $Script" }

$PsExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

$Action = New-ScheduledTaskAction `
  -Execute $PsExe `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`" -IfStale -AllProjects -SyncPg" `
  -WorkingDirectory $RepoRoot

# Раз в 30 минут, бессрочно (RepetitionDuration через большой TimeSpan — надёжно в PS 5.1).
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes 30) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$Principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Обновляю существующую задачу '$TaskName'..."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Principal $Principal `
  -Settings $Settings `
  -Description 'Подстраховка свежести codebase-memory ВСЕХ проектов оркестратора: исходники новее памяти → codebase-memory update + зеркало в PostgreSQL (CODEBASE-MEMORY-AUTOREFRESH-001).' | Out-Null

Write-Host "Готово. Задача '$TaskName' зарегистрирована (каждые 30 минут, -IfStale -AllProjects -SyncPg)."
Write-Host "Запустить прямо сейчас:  Start-ScheduledTask -TaskName '$TaskName'"
