// E2E / contract: PIPELINE-STAGE-CONFIG-001 (INTEGRATION-P2.1)
//
// Доказывает СКВОЗНОЙ поток включения/отключения этапов и папки Scanner через
// границы сервисов: orchestrator API + storage (Postgres) → pipeline-runner →
// scanner-service, плюс согласованность контракта на уровне кода всех трёх
// сервисов. Тесты независимы от порядка и стабильны при повторном запуске:
// API-часть создаёт собственный временный проект с уникальным root_path и
// удаляет его в finally; runner/scanner-часть работает во временном каталоге ОС.
//
// API-часть требует живой orchestrator на ORCHESTRATOR_API_BASE (по умолчанию
// http://localhost:4186). Если сервер недоступен — эти подтесты ЯВНО
// помечаются skip (с диагностикой), а не молча проходят; runner/scanner-часть
// не зависит от сети и выполняется всегда.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- Контракт orchestrator-service (P0.1) ---
import {
  STAGE_ERROR,
  SCANNER_ROLE_CODE,
  isAbsolutePath as orchIsAbsolute,
  validateStages,
} from '../../orchestrator-service/backend/src/stages.js';
// --- Контракт scanner-service (P1.1) ---
import {
  SCANNER_READY_CODE,
  isAbsolutePathSyntax,
  resolveDocumentPath,
  checkWatchDirectory,
  ScannerConfigError,
} from '../../scanner-service/src/paths.js';
// --- pipeline-runner (P1.1) ---
import { ConfigLoader } from '../../pipeline-runner/src/ConfigLoader.js';
import { PipelineRunner } from '../../pipeline-runner/src/PipelineRunner.js';

const API_BASE = process.env.ORCHESTRATOR_API_BASE || 'http://localhost:4186';

// Кросс-платформенные команды: success/fail без зависимости от cmd.exe vs /bin/sh.
const OK = 'node -e "process.exit(0)"';
const FAIL = 'node -e "process.exit(1)"';
// Команда с наблюдаемым побочным эффектом — создаёт файл-маркер в cwd.
const marker = (file) =>
  `node -e "require('fs').writeFileSync('${file}','x')"`;

// ---------------------------------------------------------------------------
// ЧАСТЬ A. Согласованность контракта на уровне кода всех трёх сервисов.
// Один и тот же признак Scanner (код роли), одни и те же машинные коды и одно
// и то же понятие «абсолютный путь» — иначе сервисы разойдутся в проде.
// ---------------------------------------------------------------------------

test('A1: коды ошибок watchDirectory совпадают между orchestrator и scanner', () => {
  assert.equal(STAGE_ERROR.WATCH_DIR_REQUIRED, SCANNER_READY_CODE.WATCH_DIR_REQUIRED);
  assert.equal(STAGE_ERROR.WATCH_DIR_ABSOLUTE, SCANNER_READY_CODE.WATCH_DIR_ABSOLUTE);
  assert.equal(STAGE_ERROR.WATCH_DIR_REQUIRED, 'scanner_watch_directory_required');
  assert.equal(STAGE_ERROR.WATCH_DIR_ABSOLUTE, 'scanner_watch_directory_must_be_absolute');
});

test('A2: признак Scanner — канонический код роли SCANNER', () => {
  assert.equal(SCANNER_ROLE_CODE, 'SCANNER');
});

test('A3: «абсолютный путь» трактуется одинаково в orchestrator и scanner', () => {
  for (const p of ['K:\\projects\\x', 'C:/app', '\\\\host\\share', '/home/user', 'src/app', './a', '', 'C:file']) {
    assert.equal(
      orchIsAbsolute(p),
      isAbsolutePathSyntax(p),
      `Расхождение абсолютности для ${JSON.stringify(p)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// ЧАСТЬ B. orchestrator API + storage (E2E через живой сервер и Postgres).
// ---------------------------------------------------------------------------

async function api(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* пустое/не-JSON тело */
  }
  return { status: res.status, body: json };
}

async function serverUp() {
  try {
    const res = await fetch(`${API_BASE}/health`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

test('B: orchestrator stages API — полный жизненный цикл enabled + папка Scanner', async (t) => {
  if (!(await serverUp())) {
    t.skip(`orchestrator недоступен на ${API_BASE} — подтест пропущен (не провал)`);
    return;
  }

  // БД-привязку берём от уже существующего проекта: создание нового проекта
  // должно использовать ту же connection, иначе при >1 подключении сервер
  // потребует явный databaseId.
  const list = await api('GET', '/api/projects');
  assert.equal(list.status, 200, 'GET /api/projects');
  const databaseId = list.body.projects?.find((p) => p.databaseId)?.databaseId ?? null;

  const uniqueRoot = `__e2e_pscfg__/${process.pid}-${Date.now()}`;
  let projectId = null;

  try {
    // 1. Создать временный проект.
    const created = await api('POST', '/api/projects', {
      path: uniqueRoot,
      name: `E2E PSCFG ${process.pid}`,
      ...(databaseId ? { databaseId } : {}),
    });
    assert.equal(created.status, 200, `создание проекта: ${JSON.stringify(created.body)}`);
    projectId = created.body.id;
    assert.ok(projectId, 'у созданного проекта есть id');

    const watchDir = process.cwd(); // заведомо существующий абсолютный путь
    // PIPELINE-DYNAMIC-ROUTE-001: у каждого ВКЛЮЧЁННОГО этапа (и Scanner, и
    // обычного с ролями) обязателен task_status — по нему резолвер маршрута ведёт
    // задачу. Отключённый этап статус не требует.
    const validStages = {
      stages: [
        { name: 'Разработка', enabled: true, roleCodes: ['PROGRAMMER'], taskStatus: 'CODING' },
        { name: 'Тесты', enabled: false, roleCodes: ['PIPELINE_SERVICE'] },
        { name: 'Наблюдатель', enabled: true, roleCodes: ['SCANNER'], scanner: { watchDirectory: watchDir, taskStatus: 'READY' } },
      ],
    };

    // 2. Сохранить валидный набор (включённый + отключённый + Scanner с папкой).
    const put = await api('PUT', `/api/projects/${projectId}/stages`, validStages);
    assert.equal(put.status, 200, `PUT stages: ${JSON.stringify(put.body)}`);

    // 3. Перечитать и проверить контракт без потери данных.
    const got = await api('GET', `/api/projects/${projectId}/stages`);
    assert.equal(got.status, 200);
    const stages = got.body.stages;
    assert.equal(stages.length, 3);
    // Порядок сохранён.
    assert.deepEqual(stages.map((s) => s.name), ['Разработка', 'Тесты', 'Наблюдатель']);
    // enabled — явный boolean у каждого.
    for (const s of stages) assert.equal(typeof s.enabled, 'boolean');
    // Отключённый этап остался на своей позиции с enabled:false.
    assert.equal(stages[1].enabled, false);
    assert.equal(stages[1].position, 1);
    // Scanner определён по коду роли и вернул папку.
    const scanner = stages.find((s) => s.roleCodes.includes('SCANNER'));
    assert.ok(scanner.enabled);
    assert.equal(scanner.scanner.watchDirectory, watchDir);

    const scannerId = scanner.id;
    const progId = stages[0].id;

    // 4. Негатив: включённый Scanner без папки → 422 required (привязка к stageId).
    const noDir = await api('PUT', `/api/projects/${projectId}/stages`, {
      stages: [
        { id: progId, name: 'Разработка', enabled: true, roleCodes: ['PROGRAMMER'] },
        { id: scannerId, name: 'Наблюдатель', enabled: true, roleCodes: ['SCANNER'] },
      ],
    });
    assert.equal(noDir.status, 422);
    assert.equal(noDir.body.code, 'stage_validation_failed');
    assert.ok(
      noDir.body.errors.some(
        (e) => e.stageId === scannerId && e.code === 'scanner_watch_directory_required',
      ),
      'ошибка required привязана к stageId Scanner',
    );

    // 5. Негатив: относительный путь → must_be_absolute.
    const relDir = await api('PUT', `/api/projects/${projectId}/stages`, {
      stages: [
        { id: scannerId, name: 'Наблюдатель', enabled: true, roleCodes: ['SCANNER'], scanner: { watchDirectory: 'src/app' } },
      ],
    });
    assert.equal(relDir.status, 422);
    assert.ok(relDir.body.errors.some((e) => e.code === 'scanner_watch_directory_must_be_absolute'));

    // 6. Негатив: два включённых Scanner на ОДНОМ статусе → scanner_stage_conflict.
    const conflict = await api('PUT', `/api/projects/${projectId}/stages`, {
      stages: [
        { name: 'S1', enabled: true, roleCodes: ['SCANNER'], scanner: { watchDirectory: watchDir, taskStatus: 'READY' } },
        { name: 'S2', enabled: true, roleCodes: ['SCANNER'], scanner: { watchDirectory: watchDir, taskStatus: 'READY' } },
      ],
    });
    assert.equal(conflict.status, 422);
    assert.ok(conflict.body.errors.some((e) => e.code === 'scanner_stage_conflict'));

    // 7. Совместимость (LEGACY-STAGE-DEFAULTS): этап БЕЗ поля enabled сохраняется
    //    и после чтения ведёт себя как включённый (absent = true). task_status
    //    обязателен у любого включённого этапа с ролью — задаём.
    const noEnabled = await api('PUT', `/api/projects/${projectId}/stages`, {
      stages: [{ name: 'X', roleCodes: ['PROGRAMMER'], taskStatus: 'CODING' }],
    });
    assert.equal(noEnabled.status, 200, `noEnabled: ${JSON.stringify(noEnabled.body)}`);
    const afterNoEnabled = await api('GET', `/api/projects/${projectId}/stages`);
    const legacyStage = afterNoEnabled.body.stages.find((s) => s.name === 'X');
    assert.equal(legacyStage.enabled, true, 'этап без enabled читается как включённый');

    // 7b. Восстановить прежний набор (Scanner на месте) для последующих шагов.
    await api('PUT', `/api/projects/${projectId}/stages`, {
      stages: [
        { id: progId, name: 'Разработка', enabled: true, roleCodes: ['PROGRAMMER'], taskStatus: 'CODING' },
        { id: scannerId, name: 'Наблюдатель', enabled: true, roleCodes: ['SCANNER'], scanner: { watchDirectory: watchDir, taskStatus: 'READY' } },
      ],
    });

    // 8. Отключить Scanner, сохранив папку → перечитать: папка не очищена.
    const disable = await api('PUT', `/api/projects/${projectId}/stages`, {
      stages: [
        { id: progId, name: 'Разработка', enabled: true, roleCodes: ['PROGRAMMER'], taskStatus: 'CODING' },
        { id: scannerId, name: 'Наблюдатель', enabled: false, roleCodes: ['SCANNER'], scanner: { watchDirectory: watchDir, taskStatus: 'READY' } },
      ],
    });
    assert.equal(disable.status, 200, `disable: ${JSON.stringify(disable.body)}`);
    const afterDisable = await api('GET', `/api/projects/${projectId}/stages`);
    const disabledScanner = afterDisable.body.stages.find((s) => s.roleCodes.includes('SCANNER'));
    assert.equal(disabledScanner.enabled, false);
    assert.equal(disabledScanner.scanner.watchDirectory, watchDir, 'папка сохранена при отключении');

    // 9. Повторно включить → папка восстановлена и снова валидна.
    const reenable = await api('PUT', `/api/projects/${projectId}/stages`, {
      stages: [
        { id: progId, name: 'Разработка', enabled: true, roleCodes: ['PROGRAMMER'], taskStatus: 'CODING' },
        { id: scannerId, name: 'Наблюдатель', enabled: true, roleCodes: ['SCANNER'], scanner: { watchDirectory: watchDir, taskStatus: 'READY' } },
      ],
    });
    assert.equal(reenable.status, 200);
    const afterReenable = await api('GET', `/api/projects/${projectId}/stages`);
    const reenabled = afterReenable.body.stages.find((s) => s.roleCodes.includes('SCANNER'));
    assert.equal(reenabled.enabled, true);
    assert.equal(reenabled.scanner.watchDirectory, watchDir);

    // 10. 404 на неизвестном проекте.
    const missing = await api('GET', '/api/projects/00000000-0000-4000-8000-000000000000/stages');
    assert.equal(missing.status, 404);
  } finally {
    // Гарантированный cleanup: тест не оставляет данных в общей БД.
    if (projectId) {
      const del = await api('DELETE', `/api/projects/${projectId}`);
      assert.ok(del.status === 200, `cleanup проекта (${del.status})`);
    }
  }
});

// ---------------------------------------------------------------------------
// ЧАСТЬ C. pipeline-runner — реальный прогон: отключённый этап = SKIPPED без
// побочных эффектов, fail-fast включённых, all-disabled = success.
// ---------------------------------------------------------------------------

async function runPipeline(stagesObj, workdir) {
  const config = new ConfigLoader().validate(
    { name: 'e2e', workingDirectory: '.', stages: stagesObj },
    join(workdir, '.pipeline.json'),
  );
  return new PipelineRunner({ config }).execute();
}

test('C1: отключённый промежуточный этап → SKIPPED/disabled_by_configuration, команды не запускаются', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pscfg-runner-'));
  try {
    const res = await runPipeline(
      {
        first: { enabled: true, commands: [marker('first.flag')] },
        middle: { enabled: false, commands: [marker('middle.flag')] },
        last: { enabled: true, commands: [marker('last.flag')] },
      },
      dir,
    );
    assert.equal(res.success, true);
    const byName = Object.fromEntries(res.summary.stages.map((s) => [s.name, s]));
    // Включённые выполнились — их маркеры есть, управление дошло до last.
    assert.ok(existsSync(join(dir, 'first.flag')));
    assert.ok(existsSync(join(dir, 'last.flag')));
    // Отключённый этап: SKIPPED, нулевая длительность, без exitCode, причина disabled.
    assert.equal(byName.middle.status, 'SKIPPED');
    assert.equal(byName.middle.durationSeconds, 0);
    assert.equal(byName.middle.reason, 'disabled_by_configuration');
    assert.equal(byName.middle.exitCode, undefined);
    // Команда отключённого этапа НИ РАЗУ не запускалась — побочного эффекта нет.
    assert.equal(existsSync(join(dir, 'middle.flag')), false, 'команда disabled-этапа не выполнялась');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('C2: pipeline со всеми отключёнными этапами — success, все SKIPPED', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pscfg-runner-'));
  try {
    const res = await runPipeline(
      {
        a: { enabled: false, commands: [marker('a.flag')] },
        b: { enabled: false, commands: [marker('b.flag')] },
      },
      dir,
    );
    assert.equal(res.success, true);
    assert.ok(res.summary.stages.every((s) => s.status === 'SKIPPED'));
    assert.equal(existsSync(join(dir, 'a.flag')), false);
    assert.equal(existsSync(join(dir, 'b.flag')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('C3: fail-fast — упавший включённый этап останавливает pipeline; следующий этап не запускается', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pscfg-runner-'));
  try {
    const res = await runPipeline(
      {
        ok: { enabled: true, commands: [OK] },
        boom: { enabled: true, commands: [FAIL] },
        after: { enabled: true, commands: [marker('after.flag')] },
      },
      dir,
    );
    assert.equal(res.success, false);
    assert.equal(res.failedStage, 'boom');
    // Этап после упавшего не достигнут (его нет в summary) и не выполнялся.
    const names = res.summary.stages.map((s) => s.name);
    assert.deepEqual(names, ['ok', 'boom']);
    assert.equal(existsSync(join(dir, 'after.flag')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('C4: runner отклоняет конфиг без обязательного enabled (единый контракт)', () => {
  assert.throws(
    () => new ConfigLoader().validate({ stages: { x: { commands: [OK] } } }),
    /enabled/,
  );
});

// ---------------------------------------------------------------------------
// ЧАСТЬ D. scanner-service — readiness папки и защита от path traversal.
// ---------------------------------------------------------------------------

test('D1: checkWatchDirectory — существующий каталог доступен (ok)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pscfg-scan-'));
  try {
    const { documentPath } = resolveDocumentPath(dir); // default claude-tasks.json
    const r = await checkWatchDirectory(dir, documentPath);
    assert.deepEqual(r, { ok: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('D2: checkWatchDirectory — несуществующий каталог → unavailable со стабильным кодом', async () => {
  const missing = join(tmpdir(), `pscfg-missing-${process.pid}-${Date.now()}`);
  const r = await checkWatchDirectory(missing, join(missing, 'claude-tasks.json'));
  assert.equal(r.ok, false);
  assert.equal(r.code, SCANNER_READY_CODE.WATCH_DIR_UNAVAILABLE);
});

test('D3: путь к файлу (не каталогу) → unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pscfg-scan-'));
  try {
    const file = join(dir, 'a-file.txt');
    await writeFile(file, 'x');
    const r = await checkWatchDirectory(file, join(file, 'claude-tasks.json'));
    assert.equal(r.ok, false);
    assert.equal(r.code, SCANNER_READY_CODE.WATCH_DIR_UNAVAILABLE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('D4: path traversal за пределы watchDirectory отклоняется', () => {
  assert.throws(
    () => resolveDocumentPath('/srv/watch', '../escape.json'),
    (e) => e instanceof ScannerConfigError && e.code === SCANNER_READY_CODE.DOCUMENT_PATH_ESCAPE,
  );
  assert.throws(
    () => resolveDocumentPath('/srv/watch', '/etc/passwd'),
    (e) => e instanceof ScannerConfigError && e.code === SCANNER_READY_CODE.DOCUMENT_PATH_ESCAPE,
  );
});

test('D5: включённый Scanner без папки / с относительным путём → стабильные коды', () => {
  assert.throws(
    () => resolveDocumentPath('', 'claude-tasks.json'),
    (e) => e.code === SCANNER_READY_CODE.WATCH_DIR_REQUIRED,
  );
  assert.throws(
    () => resolveDocumentPath('relative/dir', 'claude-tasks.json'),
    (e) => e.code === SCANNER_READY_CODE.WATCH_DIR_ABSOLUTE,
  );
});
