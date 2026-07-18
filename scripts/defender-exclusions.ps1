# Defender-исключения для ускорения reasoning-прогонов (codex/claude) на Windows.
#
# ПОЧЕМУ: диск K: читается быстро (~1.4 мс/файл при чтении одним процессом), но
# КАЖДАЯ read-команда модели — это отдельный spawn процесса (~50–75 мс), который
# Windows Defender real-time перехватывает и сканирует. Серия мелких чтений у codex
# выбивает его внутренний per-command таймаут → модель пишет «команды чтения на
# диске медленные, упёрлись в таймаут». Исключения снимают скан с проектов и
# процессов раннеров — spawn'ы становятся дешевле.
#
# ЗАПУСК: ТОЛЬКО в PowerShell «От имени администратора»:
#   powershell -ExecutionPolicy Bypass -File scripts\defender-exclusions.ps1
# Откат: тот же скрипт с -Remove.
param([switch]$Remove)

$ErrorActionPreference = 'Stop'

# Проверка прав администратора (Set/Add-MpPreference требуют elevation).
$admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Error 'Нужны права администратора. Запустите PowerShell «От имени администратора» и повторите.'
  exit 1
}

# Пути-исключения: корень всех Go-проектов (с 2026-07-06 разработка живёт на
# F:\git — покрывает ai-dev-manager, PS и остальные) и CODEX_HOME (~/.codex с
# крупными sqlite-логами codex).
$paths = @(
  'E:\git',
  (Join-Path $env:USERPROFILE '.codex')
)
# Процессы-исключения (по имени бинарника): раннеры и сам codex.
$procs = @('node.exe', 'codex.exe')

if ($Remove) {
  foreach ($p in $paths) { try { Remove-MpPreference -ExclusionPath    $p -ErrorAction Stop; Write-Host "removed path: $p" } catch { Write-Host "skip path:  $p ($($_.Exception.Message))" } }
  foreach ($p in $procs) { try { Remove-MpPreference -ExclusionProcess $p -ErrorAction Stop; Write-Host "removed proc: $p" } catch { Write-Host "skip proc:  $p ($($_.Exception.Message))" } }
} else {
  foreach ($p in $paths) { Add-MpPreference -ExclusionPath    $p; Write-Host "added path: $p" }
  foreach ($p in $procs) { Add-MpPreference -ExclusionProcess $p; Write-Host "added proc: $p" }
}

Write-Host ''
Write-Host 'Текущие исключения Defender:'
$mp = Get-MpPreference
Write-Host ("  Paths:     " + (($mp.ExclusionPath)    -join '; '))
Write-Host ("  Processes: " + (($mp.ExclusionProcess) -join '; '))
