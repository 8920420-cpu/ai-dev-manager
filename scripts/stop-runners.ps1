# stop-runners.ps1
# Останавливает фоновых демонов host-runner, programmer-runner и codex-runner.
$ErrorActionPreference = 'Stop'

function Stop-Runner([string]$ScriptLeaf, [string]$Title) {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$ScriptLeaf*") }
  if (-not $procs) { Write-Host "= $Title не запущен"; return }
  foreach ($p in $procs) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Host "- остановлен $Title (PID $($p.ProcessId))" }
    catch { Write-Warning "не удалось остановить $Title (PID $($p.ProcessId)): $($_.Exception.Message)" }
  }
}

Stop-Runner 'host-runner.js'             'host-runner'
Stop-Runner 'programmer-runner.js'       'programmer-runner'
Stop-Runner 'codex-runner.js'            'codex-runner'
Stop-Runner 'claude-reasoning-runner.js' 'claude-reasoning-runner'
