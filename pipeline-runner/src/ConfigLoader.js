import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * ConfigLoader — единственная ответственность: прочитать и провалидировать
 * .pipeline.json, превратив его в нормализованный объект конфигурации.
 *
 * Загрузчик НЕ знает ни про языки, ни про структуру проектов — он лишь
 * проверяет общий контракт «stages = { имя: [команды] }».
 */
export class ConfigLoader {
  /**
   * @param {string} configPath путь до .pipeline.json (относительный или абсолютный)
   * @returns {Promise<NormalizedConfig>}
   */
  async load(configPath) {
    const absPath = path.resolve(configPath);

    let raw;
    try {
      raw = await readFile(absPath, 'utf8');
    } catch (err) {
      throw new ConfigError(`Не удалось прочитать конфиг: ${absPath} (${err.message})`);
    }

    let json;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new ConfigError(`Некорректный JSON в конфиге ${absPath}: ${err.message}`);
    }

    return this.validate(json, absPath);
  }

  /**
   * Валидация и нормализация уже распарсенного объекта.
   * Вынесена отдельно, чтобы её было удобно покрывать юнит-тестами без файлов.
   */
  validate(json, absPath = path.resolve('.pipeline.json')) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new ConfigError('Конфиг должен быть JSON-объектом');
    }
    if (!json.stages || typeof json.stages !== 'object' || Array.isArray(json.stages)) {
      throw new ConfigError('Конфиг должен содержать объект "stages"');
    }

    // Порядок ключей в JSON-объекте сохраняется в JS — этим и задаётся
    // порядок выполнения этапов. Pipeline не знает заранее имена этапов.
    const stages = [];
    for (const [name, value] of Object.entries(json.stages)) {
      stages.push(this.#normalizeStage(name, value));
    }

    if (stages.length === 0) {
      throw new ConfigError('Конфиг не содержит ни одного этапа');
    }

    const configDir = path.dirname(absPath);
    // workingDirectory считается относительно расположения конфига —
    // это позволяет запускать services/catalog/.pipeline.json «как есть».
    const workingDirectory = path.resolve(configDir, json.workingDirectory ?? '.');

    let timeoutMinutes = null;
    if (json.timeoutMinutes != null) {
      if (typeof json.timeoutMinutes !== 'number' || !(json.timeoutMinutes > 0)) {
        throw new ConfigError('"timeoutMinutes" должно быть положительным числом');
      }
      timeoutMinutes = json.timeoutMinutes;
    }

    return {
      name: typeof json.name === 'string' && json.name.trim() ? json.name : 'pipeline',
      workingDirectory,
      timeoutMinutes,
      stages,
      configPath: absPath,
    };
  }

  /**
   * Нормализовать один этап. Поддерживаются две формы:
   *   1) массив команд (старый формат) — этап всегда включён;
   *   2) объект { commands: string[], enabled?: boolean, ... } — расширенный
   *      формат с управлением активностью. Незнакомые поля (например, scanner)
   *      runner безопасно игнорирует: их семантика принадлежит другому
   *      потребителю контракта.
   *
   * Обратная совместимость: отсутствие `enabled` эквивалентно `true`.
   *
   * @returns {{name: string, commands: string[], enabled: boolean}}
   */
  #normalizeStage(name, value) {
    let commands;
    let enabled = true;

    if (Array.isArray(value)) {
      commands = value;
    } else if (value && typeof value === 'object') {
      if (!Array.isArray(value.commands)) {
        throw new ConfigError(`Этап "${name}": поле "commands" должно быть массивом команд`);
      }
      commands = value.commands;
      if (value.enabled != null) {
        if (typeof value.enabled !== 'boolean') {
          throw new ConfigError(`Этап "${name}": поле "enabled" должно быть boolean`);
        }
        enabled = value.enabled;
      }
    } else {
      throw new ConfigError(
        `Этап "${name}" должен быть массивом команд или объектом { commands, enabled }`,
      );
    }

    commands.forEach((cmd, i) => {
      if (typeof cmd !== 'string') {
        throw new ConfigError(`Этап "${name}", команда #${i + 1} должна быть строкой`);
      }
    });

    return { name, commands: [...commands], enabled };
  }
}

/** Ошибка конфигурации — отличается от ошибок выполнения команд. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * @typedef {Object} NormalizedConfig
 * @property {string} name
 * @property {string} workingDirectory абсолютный путь
 * @property {number|null} timeoutMinutes
 * @property {Array<{name: string, commands: string[], enabled: boolean}>} stages
 * @property {string} configPath абсолютный путь
 */
