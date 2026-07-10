# register-freshness-watchdog.ps1
# RUNNER-FRESHNESS-001 — регистрирует Scheduled Task, который каждые 10 минут
# запускает scripts/ensure-fresh-runners.ps1: демон, чей код новее процесса,
# перезапускается автоматически (см. комментарий в ensure-fresh-runners.ps1).
# Принципал — интерактивный текущий пользователь, как у 'ai-dev-manager runners'
# (демонам нужна его сессия: docker/git/подписка Claude).

$ErrorActionPreference = 'Stop'

$TaskName = 'ai-dev-manager runner freshness'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Watchdog = Join-Path $PSScriptRoot 'ensure-fresh-runners.ps1'
if (-not (Test-Path $Watchdog)) { throw "Не найден $Watchdog" }

$PsExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

$Action = New-ScheduledTaskAction `
  -Execute $PsExe `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Watchdog`"" `
  -WorkingDirectory $RepoRoot

# Раз в 10 минут, бессрочно (RepetitionDuration через большой TimeSpan — надёжно в PS 5.1).
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 10) `
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
  -Description 'Вотчдог свежести хост-демонов ai-dev-manager: код новее процесса → точечный рестарт демона (RUNNER-FRESHNESS-001).' | Out-Null

Write-Host "Готово. Задача '$TaskName' зарегистрирована (каждые 10 минут)."
Write-Host "Запустить прямо сейчас:  Start-ScheduledTask -TaskName '$TaskName'"
