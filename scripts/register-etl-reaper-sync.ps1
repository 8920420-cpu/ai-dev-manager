# ВНИМАНИЕ (кодировка): файл ОБЯЗАН храниться как UTF-8 С BOM — Windows PowerShell 5.1 без
# BOM читает кириллицу в ACP (1251) и падает на парсинге строковых литералов.
#
# REAPER-SAFE-RECONCILE-001 — регистрация ночного прогона ETL-Reaper для DOCKER-контура.
#
# Зачем: контрагент попадает в master_data.counterparties только от reaper (он читает
# Archivum.upds и делает upsert справочника). Без регулярных прогонов новое юрлицо в
# справочник не попадает, а его документы скрываются fail-closed. Кластерный контур
# закрывает CronJob PS/deploy/k8s-prod/43-etl-reaper-sync-cronjob.yaml, docker — эта задача.
#
# Удаления в прогоне выключены (см. сам скрипт): чистка dynamic_data и frontend_db остаётся
# ручной операцией.
#
# ТРЕБУЕТ ПРАВ АДМИНИСТРАТОРА (Register-ScheduledTask иначе даёт 0x80070005).
#
#   powershell -File scripts/register-etl-reaper-sync.ps1            # зарегистрировать/обновить
#   powershell -File scripts/register-etl-reaper-sync.ps1 -Unregister # удалить задачу
[CmdletBinding()]
param(
  [switch]$Unregister,
  [string]$Time = '02:30',
  [string]$ScriptPath = '/e/git/PS/deploy/scripts/etl-reaper-sync.sh'
)
$ErrorActionPreference = 'Stop'

$taskName = 'ai-dev-manager etl-reaper sync'

if ($Unregister) {
  try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop } catch {}
  Write-Host "[reaper-sync] задача '$taskName' удалена" -ForegroundColor Yellow
  return
}

$bash = 'C:\Program Files\Git\bin\bash.exe'
if (-not (Test-Path $bash)) { throw "не найден bash: $bash" }

# --login нужен, чтобы окружение (PATH до docker) совпадало с ручным запуском из Git Bash —
# так же сделано у задач бэкапов ps-docker/ps-prod.
$action  = New-ScheduledTaskAction -Execute $bash -Argument "--login `"$ScriptPath`""
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
# Прогон читает 53k документов и синхронизирует каталог — на холодной БД это несколько минут;
# час с запасом, дальше — принудительная остановка, чтобы задача не висела до следующего дня.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -MultipleInstances IgnoreNew -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -RunLevel Highest -User $env:USERNAME -Force | Out-Null

Write-Host "[reaper-sync] задача '$taskName' зарегистрирована: ежедневно в $Time" -ForegroundColor Green
Write-Host "[reaper-sync] лог прогонов: E:\git\_logs\etl-reaper-sync.log" -ForegroundColor Cyan
