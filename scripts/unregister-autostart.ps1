# unregister-autostart.ps1
# Снимает host-runner + programmer-runner с автозапуска (удаляет задачу планировщика).
# Уже запущенные демоны при этом не останавливаются — для этого stop-runners.ps1.
$ErrorActionPreference = 'Stop'

$TaskName = 'ai-dev-manager runners'
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $existing) { Write-Host "Задача '$TaskName' не зарегистрирована — нечего удалять."; return }

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Задача '$TaskName' удалена из автозапуска."
