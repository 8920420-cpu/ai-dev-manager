# ВНИМАНИЕ (кодировка): этот файл ОБЯЗАН храниться как UTF-8 С BOM.
# Windows PowerShell 5.1 без BOM читает кириллицу в ACP (1251) и падает на
# парсинге строковых литералов. НЕ убирать BOM (иначе `deploy`/`restart` не
# запустятся у того, кто работает под PS 5.1, а не под pwsh 7).
# VERSION-KPI-TRACKING-001 — пересборка и перезапуск orchestrator-service с
# проставлением версии кода в образ (APP_CODE_VERSION = git-SHA) для авто-метки
# деплоя. Запуск из любого места: скрипт сам переходит в корень репозитория.
#
#   pwsh scripts/deploy.ps1                 # собрать + перезапустить оркестратор
#   pwsh scripts/deploy.ps1 -InstallHooks   # ещё и включить git-хуки авто-метки
#   pwsh scripts/deploy.ps1 -InstallHooks -SkipBuild   # только хуки, без сборки
#
# Миграции БД накатываются автоматически на старте контейнера (AUTO_INIT=true).
[CmdletBinding()]
param(
  [switch]$InstallHooks,
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repo

# Версия кода = короткий git-SHA (+"-dirty" при незакоммиченном дереве).
$sha = (& git rev-parse --short HEAD).Trim()
$dirty = (& git status --porcelain)
if ($dirty) { $sha = "$sha-dirty" }
$env:APP_CODE_VERSION = $sha
Write-Host "[deploy] версия кода (APP_CODE_VERSION): $sha" -ForegroundColor Cyan

if ($InstallHooks) {
  & git config core.hooksPath scripts/git-hooks
  Write-Host "[deploy] git-хуки авто-метки включены (core.hooksPath=scripts/git-hooks)" -ForegroundColor Green
}

if (-not $SkipBuild) {
  Write-Host "[deploy] сборка образа orchestrator-service..." -ForegroundColor Cyan
  & docker compose build orchestrator-service
  if ($LASTEXITCODE -ne 0) { throw "docker compose build завершился с кодом $LASTEXITCODE" }

  Write-Host "[deploy] перезапуск контейнера..." -ForegroundColor Cyan
  & docker compose up -d orchestrator-service
  if ($LASTEXITCODE -ne 0) { throw "docker compose up завершился с кодом $LASTEXITCODE" }

  # Ждём health (миграции + старт). Контейнер сам ставит метку деплоя на старте.
  Write-Host "[deploy] ожидание готовности..." -ForegroundColor Cyan
  $ok = $false
  foreach ($i in 1..30) {
    Start-Sleep -Seconds 2
    try {
      $r = Invoke-RestMethod -Uri 'http://localhost:4186/health' -TimeoutSec 3
      if ($r.status -eq 'ok') { $ok = $true; break }
    } catch { }
  }
  if ($ok) {
    Write-Host "[deploy] готово: http://localhost:4186 (версия $sha)" -ForegroundColor Green
  } else {
    Write-Warning "[deploy] сервис не ответил healthcheck за 60с — проверьте 'docker compose logs orchestrator-service'"
  }
}
