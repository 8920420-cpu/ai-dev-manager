# register-autostart.ps1
# Регистрирует автозапуск host-runner + programmer-runner через Планировщик задач
# Windows: задача «при входе в систему» текущего пользователя.
#
# Почему Scheduled Task «при входе», а не Windows-служба:
#   служба работает в session 0 (изоляция) — там не откроется PowerShell-диалог
#   выбора папки и недоступна залогиненная подписка Claude текущего пользователя.
#   Демонам нужна интерактивная сессия, поэтому триггер — AtLogOn под этим юзером.
#
# Запускать из обычного PowerShell под нужным пользователем (UAC может спросить
# повышение для записи задачи в планировщик).

$ErrorActionPreference = 'Stop'

$TaskName = 'ai-dev-manager runners'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Starter  = Join-Path $PSScriptRoot 'start-runners.ps1'
if (-not (Test-Path $Starter)) { throw "Не найден $Starter" }

# powershell.exe (а не pwsh) — гарантированно есть на Windows 10.
$PsExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

$Action = New-ScheduledTaskAction `
  -Execute $PsExe `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Starter`"" `
  -WorkingDirectory $RepoRoot

# Триггер: при входе именно этого пользователя (а не любого).
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

# Интерактивный запуск под текущим пользователем (S4U/Interactive — доступ к
# его профилю, кредам Claude и desktop-сессии). Без -RunLevel Highest, чтобы не
# тянуть UAC при каждом входе; docker/git доступны и без повышения.
$Principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive

# Не убивать по таймауту, не останавливать при питании от батареи, авторестарт.
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
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
  -Description 'Автозапуск хост-демонов ai-dev-manager (host-runner + programmer-runner) при входе пользователя.' | Out-Null

Write-Host "Готово. Задача '$TaskName' зарегистрирована (триггер: вход $env:USERNAME)."
Write-Host "Запустить прямо сейчас:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Снять с автозапуска:     .\scripts\unregister-autostart.ps1"
