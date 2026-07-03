import path from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';

/**
 * ConventionConfigBuilder — ЕДИНСТВЕННОЕ место, где живут дефолты pipeline по
 * конвенции монорепо (PIPELINE-CONVENTION-ENGINE-001).
 *
 * Если у сервиса НЕТ локального `.pipeline.json`, движок сам собирает стадии,
 * зная только путь сервиса и корень проекта:
 *   1. test    — по стеку сервиса: go.mod → `go test ./...`; package.json со
 *      скриптом "test" → `npm test`; иначе стадия SKIPPED с пометкой
 *      (`no_tests_detected`).
 *   2. build   — ближайший вверх docker-compose.yml (= подсистема CRM/PS-Torg/…)
 *      → `docker compose -f <compose> build`.
 *   3. deploy  — тот же compose → `docker compose -f <compose> up -d`.
 *   4. smoke   — если в compose объявлен healthcheck → ожидание healthy
 *      (`docker compose -f <compose> up -d --wait`); иначе SKIPPED
 *      (`no_healthcheck_in_compose`).
 *
 * Логика централизована здесь: правка дефолтов применяется сразу ко всем
 * сервисам, копии `.pipeline.json` по репозиториям не разъезжаются. Локальный
 * `.pipeline.json` остаётся НЕОБЯЗАТЕЛЬНЫМ переопределением (см. ServicePipelineTask).
 *
 * Compose-файл НЕ парсится (нет YAML-зависимости): подсистема = ближайший
 * compose целиком; healthcheck детектируется облегчённым текстовым поиском.
 * Фильтрация конкретных сервисов подсистемы по build.context в базовой версии
 * НЕ реализуется — строится вся подсистема из ближайшего compose.
 */

/** Метка «конфиг синтезирован по конвенции» вместо пути к файлу на диске. */
export const CONVENTION_CONFIG_MARKER = '(convention)';

/**
 * Имена compose-файлов, распознаваемые как граница подсистемы. Порядок = приоритет
 * внутри одного каталога. `docker compose` сам понимает эти имена; здесь лишь
 * находим ближайший вверх по дереву.
 */
export const COMPOSE_FILENAMES = Object.freeze([
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
]);

/**
 * Диагностируемая ошибка построения конвенции ДО запуска команд.
 * Отличается кодом от ошибок контракта (PipelineTaskError) и конфига (ConfigError).
 */
export class ConventionError extends Error {
  /** @param {string} message @param {string} code машиночитаемый код причины */
  constructor(message, code) {
    super(message);
    this.name = 'ConventionError';
    this.code = code;
  }
}

/** Локальная проверка вложенности пути (дублировать ServicePipelineTask не хотим — избегаем цикла импортов). */
function isInsideRoot(base, child) {
  const rel = path.relative(base, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/** Существует ли обычный файл по абсолютному пути (без падения на отсутствии). */
function isFile(absPath) {
  try {
    return existsSync(absPath) && statSync(absPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Определить стадию тестов по стеку сервиса.
 * Возвращает канонический этап { name, commands, enabled } (+ reason, если SKIPPED).
 *
 * @param {string} serviceDir абсолютный каталог сервиса
 * @returns {{name:'test', commands:string[], enabled:boolean, reason?:string}}
 */
export function detectTestStage(serviceDir) {
  const abs = path.resolve(serviceDir);

  // Go: наличие go.mod однозначно задаёт команду тестов стека.
  if (isFile(path.join(abs, 'go.mod'))) {
    return { name: 'test', commands: ['go test ./...'], enabled: true };
  }

  // Node: тесты есть только если объявлен непустой скрипт "test".
  const pkgPath = path.join(abs, 'package.json');
  if (isFile(pkgPath)) {
    let pkg = null;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
      pkg = null;
    }
    const testScript =
      pkg && pkg.scripts && typeof pkg.scripts.test === 'string' ? pkg.scripts.test.trim() : '';
    if (testScript) {
      return { name: 'test', commands: ['npm test'], enabled: true };
    }
  }

  // Тесты не обнаружены → стадия пропускается с явной пометкой (не выдаётся за успех).
  return { name: 'test', commands: [], enabled: false, reason: 'no_tests_detected' };
}

/**
 * Найти ближайший compose-файл вверх от каталога сервиса, НЕ выходя за корень
 * проекта (path isolation сохраняется и для найденного compose).
 *
 * @param {string} serviceDir абсолютный каталог сервиса
 * @param {string} projectRoot абсолютный корень проекта (верхняя граница поиска)
 * @returns {string|null} абсолютный путь compose-файла или null
 */
export function findComposeUp(serviceDir, projectRoot) {
  const root = path.resolve(projectRoot);
  let dir = path.resolve(serviceDir);

  // Сервис обязан лежать внутри (или равен) корня — иначе искать нечего.
  if (!isInsideRoot(root, dir)) return null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const name of COMPOSE_FILENAMES) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
    if (dir === root) break; // выше корня проекта не поднимаемся
    const parent = path.dirname(dir);
    if (parent === dir) break; // достигли корня файловой системы
    if (!isInsideRoot(root, parent)) break; // защита: не выходить за projectRoot
    dir = parent;
  }
  return null;
}

/**
 * Объявлен ли в compose хотя бы один healthcheck (облегчённый текстовый поиск,
 * без парсинга YAML). Достаточно для решения «делать smoke-ожидание healthy».
 *
 * @param {string} composePath абсолютный путь compose-файла
 * @returns {boolean}
 */
export function composeHasHealthcheck(composePath) {
  try {
    const text = readFileSync(composePath, 'utf8');
    // Ключ healthcheck: как поле сервиса (с отступом), не в комментарии.
    return /^[ \t]+healthcheck[ \t]*:/m.test(text);
  } catch {
    return false;
  }
}

/** Ссылка на compose в команде: относительный (от каталога сервиса) POSIX-путь в кавычках. */
function composeArg(serviceDir, composePath) {
  const rel = path.relative(serviceDir, composePath).split(path.sep).join('/');
  return `"${rel}"`;
}

/**
 * ConventionConfigBuilder — построитель NormalizedConfig по конвенции.
 * Возвращает объект той же формы, что ConfigLoader.validate (чтобы дальше его
 * штатно исполнял PipelineRunner), но без файла на диске.
 */
export class ConventionConfigBuilder {
  /**
   * @param {Object} args
   * @param {string} args.serviceDir абсолютный рабочий каталог сервиса
   * @param {string} args.projectRoot абсолютный корень проекта (граница изоляции)
   * @param {string} [args.name] имя pipeline для отчёта (обычно serviceName)
   * @param {number|null} [args.timeoutMinutes]
   * @returns {import('./ConfigLoader.js').NormalizedConfig & {source:string, composePath:string}}
   */
  build({ serviceDir, projectRoot, name, timeoutMinutes = null } = {}) {
    const absServiceDir = path.resolve(serviceDir);
    const absRoot = path.resolve(projectRoot);

    if (!isInsideRoot(absRoot, absServiceDir)) {
      throw new ConventionError(
        `Каталог сервиса ${absServiceDir} вне корня проекта ${absRoot}`,
        'pipeline_service_path_escape',
      );
    }

    const stages = [detectTestStage(absServiceDir)];

    // Подсистема = ближайший compose вверх. Без него build/deploy невыполнимы —
    // это диагностируемая ошибка стадии deploy (критерий приёмки).
    const composePath = findComposeUp(absServiceDir, absRoot);
    if (!composePath) {
      throw new ConventionError(
        `Не найден docker-compose.yml вверх от каталога сервиса до корня проекта ` +
          `(${absServiceDir} → ${absRoot}); подсистему для build/deploy определить нельзя`,
        'pipeline_compose_not_found',
      );
    }
    // Изоляция: найденный compose обязан лежать внутри корня проекта.
    if (!isInsideRoot(absRoot, composePath)) {
      throw new ConventionError(
        `Найденный compose ${composePath} вне корня проекта ${absRoot}`,
        'pipeline_service_path_escape',
      );
    }

    const cArg = composeArg(absServiceDir, composePath);
    stages.push({ name: 'build', commands: [`docker compose -f ${cArg} build`], enabled: true });
    stages.push({ name: 'deploy', commands: [`docker compose -f ${cArg} up -d`], enabled: true });

    if (composeHasHealthcheck(composePath)) {
      // Ожидание healthy средствами compose (--wait) — без парсинга YAML и без
      // знания имён контейнеров/эндпоинтов.
      stages.push({
        name: 'smoke',
        commands: [`docker compose -f ${cArg} up -d --wait`],
        enabled: true,
      });
    } else {
      stages.push({ name: 'smoke', commands: [], enabled: false, reason: 'no_healthcheck_in_compose' });
    }

    return {
      name: name && String(name).trim() ? String(name) : 'pipeline',
      workingDirectory: absServiceDir,
      timeoutMinutes: timeoutMinutes ?? null,
      stages,
      configPath: CONVENTION_CONFIG_MARKER,
      source: 'convention',
      composePath,
    };
  }
}

/**
 * Постадийное переопределение конвенции локальным `.pipeline.json`
 * (`extendsConvention: true`): за основу берутся конвенционные стадии, локальные
 * стадии с тем же именем переопределяют их ЦЕЛИКОМ, новые — добавляются в конец.
 * Поля name/workingDirectory/timeoutMinutes берём из локального конфига, если
 * заданы (ConfigLoader всегда резолвит workingDirectory в каталог конфига).
 *
 * @param {import('./ConfigLoader.js').NormalizedConfig} convention
 * @param {import('./ConfigLoader.js').NormalizedConfig} override нормализованный локальный конфиг
 * @returns {import('./ConfigLoader.js').NormalizedConfig & {source:string}}
 */
export function mergeConvention(convention, override) {
  const byName = new Map(convention.stages.map((s) => [s.name, s]));
  const order = convention.stages.map((s) => s.name);
  for (const stage of override.stages) {
    if (!byName.has(stage.name)) order.push(stage.name);
    byName.set(stage.name, stage); // локальный этап переопределяет конвенционный
  }
  const stages = order.map((n) => byName.get(n));

  return {
    // 'pipeline' — дефолт ConfigLoader при отсутствии name; тогда берём имя из конвенции.
    name: override.name && override.name !== 'pipeline' ? override.name : convention.name,
    workingDirectory: override.workingDirectory ?? convention.workingDirectory,
    timeoutMinutes: override.timeoutMinutes ?? convention.timeoutMinutes,
    stages,
    configPath: override.configPath,
    source: 'convention+override',
  };
}
