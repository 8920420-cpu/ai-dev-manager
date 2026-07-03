// Движок авто-ролей: превращает auto-роль из ROLE_FLOW в реальный вызов ИИ.
// Промт роли берётся из БД (roles.prompt) как system, собирается контекст
// задачи, вызывается коннектор (DeepSeek/OpenAI-совместимый) в JSON-режиме,
// ответ нормализуется в вердикт и по нему решается переход.
//
// Здесь только «мышление» роли и чистые функции решения. Запись в БД и сами
// переходы делает db.js (advanceOne), чтобы держать сетевой вызов вне
// транзакции. Чистые функции (parseVerdict/normalizeVerdict/decideTransition)
// покрыты юнит-тестами без сети и без Postgres.
import { ROLE_FLOW } from './rolePipeline.js';
import { invoke as llmInvoke, invokeChat } from './llmConnector.js';
import { resolveInt, resolveDuration } from './envConfig.js';

// CONFIG-AUDIT-001: единый разбор числовых env (диапазон, безопасный фолбэк).
// Прежний паттерн Math.max(1000, Number(env || 12000)) при мусоре давал NaN
// (Math.max(1000, NaN) === NaN). resolveInt возвращает дефолт + предупреждение;
// нижний порог сохраняем через Math.max поверх валидного значения.
// Максимум итераций tool-loop (сколько раз роль может вызвать инструменты подряд).
const TOOL_MAX_ITERS = resolveInt('ROLE_TOOL_MAX_ITERS', 8, { min: 1, max: 100 }).value;
const TOOL_RESULT_MAX_CHARS = Math.max(1000, resolveInt('ROLE_TOOL_RESULT_MAX_CHARS', 12000, { min: 1 }).value);
const TOOL_READ_FILE_MAX_BYTES = Math.max(1000, resolveInt('ROLE_TOOL_READ_FILE_MAX_BYTES', 16000, { min: 1 }).value);
const TOOL_SEARCH_MAX_RESULTS = Math.max(1, resolveInt('ROLE_TOOL_SEARCH_MAX_RESULTS', 25, { min: 1 }).value);

// RUNNER-LLM-TIMEOUT-001: таймаут ОДНОГО вызова коннектора в рассуждающей роли.
// По умолчанию llmConnector ждёт ответ AI до 10 минут. При всплеске нагрузки
// (массовый перезапуск задач) DeepSeek отвечает медленно, и один зависший вызов
// держит слот воркера почти весь RUNNER_ROLE_TIMEOUT_MS (15 мин) — все слоты роли
// оказываются заняты повисшими вызовами, и очередь не разгребается. Ограничиваем
// каждый вызов небольшим таймаутом (по умолчанию 3 мин, env-настройка): зависший
// вызов падает быстро, роль помечается FAILED и переигрывается, слот освобождается.
const LLM_CALL_TIMEOUT_MS = resolveDuration('ROLE_LLM_CALL_TIMEOUT_MS', 3 * 60 * 1000, { min: 1000, max: 30 * 60 * 1000 }).value;

/**
 * Прогон рассуждающей роли с инструментами (function calling). Ведёт диалог:
 * модель ↔ инструменты (tools-service) до финального текстового ответа. Возвращает
 * { text, iterations, toolCalls } — text парсится в вердикт вызывающим.
 */
// Fallback-парсер текстовых вызовов инструментов. Некоторые модели (в т.ч.
// DeepSeek) эмитят вызов не в поле tool_calls, а текстом в content в формате
// invoke/parameter (с возможным «мусором»-разделителем вроде ｜｜DSML｜｜). Достаём
// имя инструмента и параметры. Возвращает [{ name, args }].
export function parseTextToolCalls(content) {
  const text = String(content ?? '');
  const out = [];
  const invokeRe = /invoke\s+name="([^"]+)"([\s\S]*?)(?:<\/[^>]*invoke>|$)/gi;
  let m;
  while ((m = invokeRe.exec(text)) !== null) {
    const name = m[1];
    const inner = m[2] ?? '';
    const args = {};
    const paramRe = /parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)(?:<\/[^>]*parameter>|<\｜|$)/gi;
    let p;
    while ((p = paramRe.exec(inner)) !== null) {
      args[p[1]] = p[2].replace(/<\/?[^>]*>/g, '').trim();
    }
    out.push({ name, args });
  }
  return out;
}

export function capToolArgs(name, args = {}) {
  const out = { ...(args && typeof args === 'object' ? args : {}) };
  if (name === 'read_file') {
    const requested = Number(out.maxBytes);
    out.maxBytes = Number.isFinite(requested)
      ? Math.min(Math.max(1, requested), TOOL_READ_FILE_MAX_BYTES)
      : TOOL_READ_FILE_MAX_BYTES;
  }
  if (name === 'search_text') {
    const requested = Number(out.maxResults);
    out.maxResults = Number.isFinite(requested)
      ? Math.min(Math.max(1, requested), TOOL_SEARCH_MAX_RESULTS)
      : TOOL_SEARCH_MAX_RESULTS;
  }
  return out;
}

export function compactToolResult(value, { maxChars = TOOL_RESULT_MAX_CHARS } = {}) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text.length <= maxChars) return text;
  return JSON.stringify({
    truncated: true,
    originalChars: text.length,
    content: text.slice(0, maxChars),
    note: 'Tool result was truncated before adding it back to the LLM context.',
  });
}

async function runToolLoop(conn, { system, user, toolSchemas, executeTool }) {
  const deadline = Date.now() + LLM_CALL_TIMEOUT_MS;
  const remainingMs = () => Math.max(1, deadline - Date.now());
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  let iterations = 0;
  let toolCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let text = '';
  for (let i = 0; i < TOOL_MAX_ITERS; i += 1) {
    iterations += 1;
    const { message, tokensIn: ti = 0, tokensOut: to = 0 } = await invokeChat(conn, { messages, tools: toolSchemas }, { timeoutMs: remainingMs() });
    tokensIn += ti; tokensOut += to;
    const native = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const content = String(message?.content ?? '');

    if (native.length) {
      // Нативный OpenAI-протокол tool_calls.
      messages.push({ role: 'assistant', content, tool_calls: native });
      for (const call of native) {
        toolCalls += 1;
        let args = {};
        try {
          args = call?.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }
        let resultText;
        try {
          resultText = compactToolResult(
            await executeTool(call?.function?.name, capToolArgs(call?.function?.name, args)),
          );
        } catch (e) {
          resultText = JSON.stringify({ error: e.message, code: e.code || 'tool_error' });
        }
        messages.push({ role: 'tool', tool_call_id: call?.id, content: resultText });
      }
      continue;
    }

    // Fallback: вызовы инструментов текстом в content (DeepSeek и пр.).
    const textCalls = parseTextToolCalls(content);
    if (textCalls.length) {
      messages.push({ role: 'assistant', content });
      const results = [];
      for (const call of textCalls) {
        toolCalls += 1;
        let resultText;
        try {
          resultText = compactToolResult(await executeTool(call.name, capToolArgs(call.name, call.args)));
        } catch (e) {
          resultText = JSON.stringify({ error: e.message, code: e.code || 'tool_error' });
        }
        results.push(`Результат ${call.name}(${JSON.stringify(call.args)}):\n${resultText}`);
      }
      messages.push({
        role: 'user',
        content: `${results.join('\n\n')}\n\nИспользуй эти реальные данные. Если данных достаточно — верни финальный JSON-вердикт; иначе запроси ещё инструменты.`,
      });
      continue;
    }

    // Нет вызовов — это финальный ответ.
    text = content.trim();
    break;
  }
  // Модель упёрлась в инструменты и не дала вердикт — жёстко просим финал без
  // инструментов: на основе уже собранных данных вернуть ТОЛЬКО JSON-вердикт.
  // Без этого «болтливые» модели (DeepSeek) бесконечно зовут read_file и роль
  // падает в verdict_unparsed.
  if (!text) {
    messages.push({
      role: 'user',
      content:
        'Достаточно сбора информации. БОЛЬШЕ НЕ вызывай инструменты. На основе уже полученных '
        + 'данных верни ТОЛЬКО финальный JSON-вердикт в требуемом формате — без разметки tool_calls, '
        + 'без markdown и без пояснений вокруг JSON.',
    });
    const { message, tokensIn: ti = 0, tokensOut: to = 0 } = await invokeChat(conn, { messages, tools: [] }, { timeoutMs: remainingMs() });
    tokensIn += ti; tokensOut += to;
    text = String(message?.content ?? '').trim();
  }
  return { text, iterations, toolCalls, tokensIn, tokensOut };
}
// composeRoleSystemPrompt импортируется по call-time (внутри runReasoningRole):
// статический импорт замкнул бы цикл roleEngine → roles → db → roleEngine, из-за
// которого db.js на этапе загрузки обращается к ещё не инициализированному
// LLM_ROLE_CODES (TDZ). Динамический import рвёт цикл на этапе загрузки модуля.

// Сколько раз задача может вернуться в CODING через провал ревью/анализа,
// прежде чем мы остановимся и пометим BLOCKED (защита от бесконечной траты).
export const MAX_REWORK = resolveInt('RUNNER_MAX_REWORK', 3, { min: 0, max: 100 }).value;

// Роли, которые ИИ-движок исполняет «рассуждением»: их продвигает runner через
// вызов модели по сохранённому в БД промту. Остальные роли цепочки исполняются
// вне ИИ (PROGRAMMER/SCANNER — файловый мост, PIPELINE_SERVICE/GIT_INTEGRATOR —
// host-мост) и здесь не перечислены. Каждый код обязан присутствовать в ROLE_FLOW.
export const LLM_ROLE_CODES = [
  // Приёмщик задач — первая рассуждающая роль: классифицирует входящий запрос.
  'TASK_INTAKE_OFFICER',
  'ARCHITECT',
  'DECOMPOSER',
  'TASK_REVIEWER',
  'FAILURE_ANALYST',
  'DOCUMENTATION_AUDITOR',
  'DOCUMENTATION_KEEPER',
];

// Роли реального действия — их выполняет host-мост (docker/git), не ИИ.
export const HOST_ROLE_CODES = ['PIPELINE_SERVICE', 'GIT_INTEGRATOR'];

const SUCCESS_STATUSES = new Set([
  'APPROVED', 'READY', 'DONE', 'DIAGNOSED', 'PASS', 'OK', 'SUCCESS',
  'COMPLETED', 'READY_FOR_REVIEW', 'AUDITED', 'UPDATED', 'PROCEED',
]);
const FAILURE_STATUSES = new Set([
  'NEEDS_FIX', 'REJECTED', 'BLOCKED', 'FAILED', 'FAIL', 'INCONCLUSIVE',
  'INFRASTRUCTURE_BLOCKED', 'ERROR',
]);

// Капы длины для сжатого контекста прошлых прогонов. Замер по живой БД: топовые
// summary Архитектора — до ~1.9-2K символов, а при многократных прогонах
// (Dynamic Workflow: REWORK/RESTART/доработка) это множится на число прогонов и
// раздувает промпт каждого вызова модели (p90 priorRoleOutputs ~10.6K, макс ~106K
// символов). Полный текст остаётся в prompt_exchanges — в контекст тащим только
// суть, поэтому режем: summary до ~700 симв. (диапазон 600-800), каждый элемент
// findings — до ~300 симв. При превышении добавляем маркер усечения '…', чтобы
// роль видела неполноту.
const SUMMARY_MAX = 700;
const FINDINGS_ITEM_MAX = 300;

// Обрезать строку до max символов ВКЛЮЧАЯ маркер: короткие значения проходят без
// изменений (без лишнего '…'), длинные усекаются так, что итоговая длина ровно max.
function truncateWithMarker(str, max) {
  const s = String(str);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

// Сжать прошлые успешные прогоны ролей в компактный список для контекста
// следующей роли: code + статус-вердикт + summary + ключевые findings. Полный
// текст ответа в контекст не тащим (он есть в prompt_exchanges) — только суть.
export function summarizePriorRuns(rows = []) {
  return rows
    .filter((r) => r && r.role_code)
    .map((r) => {
      const o = r.output_json && typeof r.output_json === 'object' ? r.output_json : {};
      return {
        role: r.role_code,
        status: String(o.status ?? r.status ?? '').trim(),
        summary: truncateWithMarker(typeof o.summary === 'string' ? o.summary : '', SUMMARY_MAX),
        findings: Array.isArray(o.findings)
          ? o.findings.slice(0, 8).map((f) => truncateWithMarker(f, FINDINGS_ITEM_MAX))
          : [],
      };
    });
}

// Единый JSON-контракт вердикта, дописывается к промту роли. Коннектор уже в
// JSON-режиме, но просим явный обязательный JSON, иначе DeepSeek может отдать
// прозу. Поля совпадают с YAML-форматами промтов, плюс ok-нормализация.
//
// PIPELINE-DYNAMIC-ROUTE-001: поле next_role УБРАНО — роль не указывает соседа,
// маршрут задаёт оркестратор по этапам проекта. ROLE-FIELD-CONTRACT-001: если у
// роли объявлены исходящие поля (outputFields), просим заполнить блок "fields".
export function buildVerdictInstruction(outputFields = []) {
  const fields = Array.isArray(outputFields) ? outputFields : [];
  const typeHint = (f) => {
    const vt = String(f?.valueType ?? f?.value_type ?? 'text').trim().toLowerCase();
    if (vt === 'list') return 'список строк';
    if (vt === 'number') return 'число';
    if (vt === 'boolean') return 'boolean';
    if (vt === 'json') return 'JSON-строка';
    return 'текст';
  };
  const lines = [
    'Верни ОТВЕТ СТРОГО как JSON-объект (valid json), без markdown и текста вокруг.',
    // VERDICT-YAML-FENCE-001: reasoning-движки (в т.ч. claude_code) иногда оборачивают
    // вердикт в код-фенс ```yaml/```json или добавляют прозу — это ронял разбор в
    // verdict_unparsed. Явно запрещаем фенсы/YAML/пояснения: только сырой JSON-объект.
    'ВЫВОД — ТОЛЬКО сам JSON-объект: без код-фенсов (``` ), без YAML, без комментариев и текста до/после.',
    'Структура: {',
    '  "status": "<статус из раздела «Формат результата» твоей роли>",',
    '  "summary": "<краткий вывод на русском>",',
    '  "findings": ["<ключевые замечания, если есть>"]',
  ];
  if (fields.length) {
    const spec = fields.map((f) => `"${f.key}": <${typeHint(f)}${f.name ? ` — ${f.name}` : ''}>`).join(', ');
    lines.push(`  ,"fields": { ${spec} }`);
  }
  lines.push('}');
  lines.push('status обязателен и должен точно соответствовать допустимым статусам роли.');
  lines.push('НЕ указывай следующую роль — маршрут определяет оркестратор по этапам проекта.');
  if (fields.length) {
    lines.push('Поля в "fields" — контракт твоего этапа: заполни КАЖДОЕ обязательное поле непустым значением.');
  }
  return lines.join('\n');
}

function fieldJsonSchema(f) {
  const valueType = String(f?.valueType ?? f?.value_type ?? 'text').trim().toLowerCase();
  const description = f.description || f.name || f.key;
  if (valueType === 'list') return { type: 'array', items: { type: 'string' }, description };
  if (valueType === 'number') return { type: 'number', description };
  if (valueType === 'boolean') return { type: 'boolean', description };
  // Arbitrary json fields are encoded as strings: Codex/OpenAI strict schemas
  // require object shapes to be explicit, while role metadata only says "json".
  if (valueType === 'json') return { type: 'string', description: `${description} (JSON serialized as a string)` };
  return { type: 'string', description };
}

// CODEX-REASONING-001: JSON-схема вердикта для `codex exec --output-schema`.
// Codex (как и OpenAI structured outputs) принимает строгую схему: на каждом
// уровне с additionalProperties:false ВСЕ перечисленные свойства обязаны быть в
// required. Поэтому форсируем status/summary/findings (+ fields, если у роли есть
// исходящие поля) — модель ОБЯЗАНА вернуть валидный вердикт, и verdict_unparsed
// становится невозможным на уровне CLI (в отличие от DeepSeek-пути, где ответ
// парсится толерантно parseVerdict). Значения полей трактуем как строки —
// исходящие поля рассуждающих ролей текстовые; extractOutputs принимает их как
// есть. Зеркалит buildVerdictInstruction по составу полей.
export function buildVerdictJsonSchema(outputFields = []) {
  const fields = (Array.isArray(outputFields) ? outputFields : []).filter((f) => f && f.key);
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'summary', 'findings'],
    properties: {
      status: { type: 'string', description: 'Статус-вердикт из раздела «Формат результата» роли' },
      summary: { type: 'string', description: 'Краткий вывод на русском' },
      findings: { type: 'array', items: { type: 'string' }, description: 'Ключевые замечания, если есть' },
    },
  };
  if (fields.length) {
    const props = {};
    for (const f of fields) props[f.key] = fieldJsonSchema(f);
    schema.properties.fields = {
      type: 'object',
      additionalProperties: false,
      required: fields.map((f) => f.key),
      properties: props,
      description: 'Контракт исходящих полей этапа: заполни каждое непустым значением',
    };
    schema.required.push('fields');
  }
  return schema;
}

// RESEARCH-BUDGET-001 — отрендерить карту проекта/сервиса как читаемый markdown
// (а не закопать её в JSON-контекст). Подаётся ПЕРВЫМ блоком payload: роль видит
// готовую структуру до того, как соберётся что-то искать. Пусто → пустая строка.
export function renderProjectMaps(maps) {
  if (!maps || typeof maps !== 'object') return '';
  const parts = [];
  if (maps.project) parts.push(`### Карта проекта\n${maps.project}`);
  if (maps.service) {
    parts.push(`### Карта микросервиса${maps.serviceName ? ` ${maps.serviceName}` : ''}\n${maps.service}`);
  }
  if (!parts.length) return '';
  return [
    '## Карта проекта (готовый контекст — НЕ переоткрывай структуру поиском)',
    ...parts,
  ].join('\n\n');
}

// Пользовательский payload: карта проекта инлайн (если есть) + компактный контекст
// задачи + требование вердикта. outputFields — объявленные исходящие поля роли.
// TOKEN-EFFICIENCY: контекст сериализуем КОМПАКТНО (без отступов). Pretty-print
// (null, 2) добавлял переносы строк и пробелы-отступы в каждый вызов модели — это
// 10–20% лишних токенов на вложенном контексте (priorRoleOutputs/changedFiles/
// recentEvents) без какой-либо пользы: модель одинаково читает компактный JSON.
// projectMaps вынимаем из контекста и рендерим markdown-ом — внутри JSON карта
// читалась бы хуже и раздувала экранирование.
// PROMPT-CACHE-001: includeMap=false — карту НЕ кладём в user-payload (её выносят в
// кэшируемый system-префикс для claude_code, чтобы не переоплачивать на каждый вызов).
export function buildUserPayload(roleCode, context, outputFields = [], { includeMap = true } = {}) {
  const { projectMaps, ...rest } = context && typeof context === 'object' ? context : {};
  const mapBlock = includeMap ? renderProjectMaps(projectMaps) : '';
  const sections = [];
  if (mapBlock) sections.push(mapBlock, '');
  sections.push(
    `Задача роли ${roleCode}. Контекст задачи (JSON):`,
    JSON.stringify(rest),
    '',
    buildVerdictInstruction(outputFields),
  );
  return sections.join('\n');
}

// VERDICT-YAML-FENCE-001 — минимальный разбор YAML-вердикта из ```yaml/```yml-фенса.
// Движок claude_code (Claude Agent SDK) НЕ умеет навязать JSON-схему на уровне CLI
// (в отличие от codex `--output-schema`), поэтому периодически отдаёт содержательно
// верный вердикт как YAML в код-фенсе → прежний JSON-only парсер давал null →
// verdict_unparsed → терминальный FAILED. Полный YAML не нужен — только форма
// вердикта: скаляры (status/summary), списки (findings) и одноуровневые маппинги
// (fields) с вложенными списком/скаляром. Возвращает plain-объект того же вида, что
// JSON-вердикт, ТОЛЬКО если распознан ключ `status` (иначе null — прозу в ```yaml не
// принимаем за вердикт, SILENT-FAIL-GUARD-001 не ослабляется). Не поддерживает
// якоря/многострочные литералы/произвольную вложенность — их в вердиктах ролей нет.
export function parseYamlVerdict(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '  ');
  const rows = [];
  for (const line of src.split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue; // пустые строки и комментарии
    rows.push({ indent: line.length - line.replace(/^ +/, '').length, content: line.trim() });
  }
  if (!rows.length) return null;

  const parseScalar = (input) => {
    const v = String(input).trim();
    if (v === '' || v === '~' || v === 'null') return v === '' ? '' : null;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    const asJson = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
    if (v.startsWith('[') && v.endsWith(']')) {
      const j = asJson(v);
      if (Array.isArray(j)) return j;
      const inner = v.slice(1, -1).trim();
      return inner === '' ? [] : inner.split(',').map((x) => parseScalar(x));
    }
    if (v.startsWith('{') && v.endsWith('}')) {
      const j = asJson(v);
      if (j && typeof j === 'object') return j;
    }
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  };

  let idx = 0;
  const parseBlock = (indent) => {
    // Список: строки «- элемент» на одном отступе.
    if (rows[idx].content === '-' || rows[idx].content.startsWith('- ')) {
      const arr = [];
      while (idx < rows.length && rows[idx].indent === indent
        && (rows[idx].content === '-' || rows[idx].content.startsWith('- '))) {
        const rest = rows[idx].content === '-' ? '' : rows[idx].content.slice(2).trim();
        idx += 1;
        if (rest === '' && idx < rows.length && rows[idx].indent > indent) {
          arr.push(parseBlock(rows[idx].indent));
        } else {
          arr.push(parseScalar(rest));
        }
      }
      return arr;
    }
    // Маппинг: строки «key: value» на одном отступе.
    const obj = {};
    while (idx < rows.length && rows[idx].indent === indent) {
      const cm = rows[idx].content.match(/^([^:]+):\s*(.*)$/);
      if (!cm) { idx += 1; continue; }
      const key = cm[1].trim().replace(/^["']|["']$/g, '');
      const val = cm[2];
      idx += 1;
      if (val.trim() === '' && idx < rows.length && rows[idx].indent > indent) {
        obj[key] = parseBlock(rows[idx].indent);
      } else {
        obj[key] = parseScalar(val);
      }
    }
    return obj;
  };

  const result = parseBlock(rows[0].indent);
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  if (!Object.prototype.hasOwnProperty.call(result, 'status')) return null;
  return result;
}

// Толерантный парсинг: ответ может быть чистым JSON, JSON в ```-блоке или
// JSON с прозой/рассуждением вокруг. Возвращает объект-вердикт или null.
//
// VERDICT-PARSE-ROBUST-001: наивный срез «первая `{` … последняя `}`» ронял
// почти-валидные вердикты — если модель писала прозу с фигурными скобками до/после
// JSON или несколько объектов (черновик + финал), срез захватывал мусор и падал в
// verdict_unparsed → FAILED. Теперь: (1) пробуем весь текст, (2) снимаем висячие
// запятые (частый огрех LLM), (3) собираем ВСЕ сбалансированные {...}-блоки (учёт
// строк/экранирования) плюс содержимое ```-блоков и выбираем среди валидных
// объектов ПОСЛЕДНИЙ со ключом `status` (это финальный вердикт роли), иначе любой
// валидный объект. Мусор/массив/пустота/DSML без JSON по-прежнему дают null —
// защита SILENT-FAIL-GUARD-001 не ослаблена.
export function parseVerdict(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return null;
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  // Висячие запятые перед } или ] (`{"a":1,}`, `[1,2,]`) — не меняет семантику
  // валидного JSON, но частая причина отказа JSON.parse у LLM-ответов.
  const stripTrailingCommas = (s) => s.replace(/,(\s*[}\]])/g, '$1');
  const parseLoose = (s) => tryParse(s) || tryParse(stripTrailingCommas(s));

  // 1. Весь текст целиком.
  let v = parseLoose(raw);
  if (v) return v;

  // 2. Кандидаты: содержимое всех ```-блоков + все сбалансированные {...}-блоки.
  // VERDICT-YAML-FENCE-001: запоминаем язык фенса — для ```yaml/```yml, если JSON не
  // распарсился, пробуем YAML-разбор (тот же объект-вердикт). Балансные {...}-блоки —
  // всегда только JSON.
  const candidates = []; // { text, allowYaml }
  const fenceRe = /```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(raw)) !== null) {
    const lang = String(m[1] ?? '').toLowerCase();
    const body = m[2].trim();
    if (body) candidates.push({ text: body, allowYaml: lang === 'yaml' || lang === 'yml' });
  }

  // Финальный вердикт всегда в конце ответа: на огромных «болтливых» ответах
  // балансный скан ведём только по хвосту, чтобы не деградировать до O(n²).
  const scan = raw.length > 100000 ? raw.slice(-100000) : raw;
  for (let i = 0; i < scan.length; i += 1) {
    if (scan[i] !== '{') continue;
    let depth = 0; let inStr = false; let esc = false;
    for (let j = i; j < scan.length; j += 1) {
      const ch = scan[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { candidates.push({ text: scan.slice(i, j + 1), allowYaml: false }); i = j; break; }
      }
    }
  }

  // 3. Выбрать вердикт: последний валидный объект со `status`; иначе любой валидный.
  let withStatus = null;
  let anyObj = null;
  for (const cand of candidates) {
    let parsed = parseLoose(cand.text);
    // ```yaml/```yml-фенс: JSON не распарсился — пробуем YAML-вердикт.
    if (!parsed && cand.allowYaml) parsed = parseYamlVerdict(cand.text);
    if (!parsed) continue;
    anyObj = parsed;
    if (Object.prototype.hasOwnProperty.call(parsed, 'status')) withStatus = parsed;
  }
  return withStatus || anyObj;
}

// Нормализация вердикта роли в { ok, status, summary, nextRoleHint, findings }.
// ok=null означает «не удалось определить» — вызывающий решает консервативно.
export function normalizeVerdict(roleCode, parsed) {
  if (!parsed) return { ok: null, status: '', summary: '', nextRoleHint: '', findings: [] };
  const status = String(parsed.status ?? '').trim().toUpperCase();
  const summary = String(parsed.summary ?? '').trim();
  const nextRoleHint = String(parsed.next_role ?? parsed.nextRole ?? '').trim().toUpperCase();
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map((f) => (typeof f === 'string' ? f : JSON.stringify(f)))
    : [];
  let ok = null;
  if (SUCCESS_STATUSES.has(status)) ok = true;
  else if (FAILURE_STATUSES.has(status)) ok = false;
  // ROLE-FIELD-CONTRACT-001: значения исходящих полей роли (карточка задачи).
  const fields = parsed.fields && typeof parsed.fields === 'object' && !Array.isArray(parsed.fields)
    ? parsed.fields
    : {};
  return { ok, status, summary, nextRoleHint, findings, fields };
}

/**
 * PIPELINE-DYNAMIC-ROUTE-001 — АБСТРАКТНЫЙ исход роли (без знания соседей).
 * Возвращает { outcome, ... } для projectRoute.resolveTransition:
 *   FORWARD — задача идёт дальше по маршруту проекта;
 *   REWORK  — назад к ближайшей предшествующей роли-исполнителю;
 *   BRANCH  — к роли заданного типа/кода (документация/архитектура/анализ);
 *   BLOCK   — остановка (blockStatus).
 * branchFallback — что делать, если ветки нет в маршруте проекта:
 *   'rework' (провал гейта без аналитика → на доработку) | 'forward' (необяз.).
 * reworkCount — сколько раз задача возвращалась в доработку (защита от цикла).
 */
export function decideOutcome(roleCode, verdict, { reworkCount = 0, maxRework = MAX_REWORK } = {}) {
  const forward = { outcome: 'FORWARD', agentRunStatus: 'SUCCESS', reason: 'ok' };
  // DOC-BRANCH-LIVENESS-001: мягкое движение вперёд с сохранением причины —
  // прогон НЕ считается упавшим (SUCCESS), но reason фиксирует, что документация
  // не была выполнена (её ветка просто идёт к join, не блокируя коммит/родителя).
  const docForward = (reason) => ({ outcome: 'FORWARD', agentRunStatus: 'SUCCESS', reason });
  const block = (reason, blockStatus = 'BLOCKED') => ({
    outcome: 'BLOCK', blockStatus, agentRunStatus: 'FAILED', reason,
  });
  const rework = (reason = 'rework') => ({ outcome: 'REWORK', agentRunStatus: 'SUCCESS', reason });
  const branch = (branchKind, branchRole, reason, branchFallback = 'forward') => ({
    outcome: 'BRANCH', branchKind, branchRole, branchFallback, agentRunStatus: 'SUCCESS', reason,
  });

  switch (roleCode) {
    case 'TASK_REVIEWER':
    case 'REVIEWER':
      // Гейт качества: дальше только при явном APPROVED. Провал — на анализ
      // причины (а если аналитика нет в маршруте — на доработку исполнителю).
      if (verdict.ok === true) return forward;
      if (reworkCount >= maxRework) return block('max_rework_exceeded');
      return branch('analyst', 'FAILURE_ANALYST', 'review_failed', 'rework');
    case 'FAILURE_ANALYST':
      if (verdict.ok === false && ['INCONCLUSIVE', 'INFRASTRUCTURE_BLOCKED'].includes(verdict.status)) {
        return block(verdict.status.toLowerCase());
      }
      if (reworkCount >= maxRework) return block('max_rework_exceeded');
      return rework('diagnosed');
    case 'ARCHITECT':
    case 'DECOMPOSER':
      if (verdict.ok === false) return block(verdict.status.toLowerCase() || 'blocked');
      return forward;
    case 'DOCUMENTATION_AUDITOR':
      // DOC-BRANCH-LIVENESS-001: документация НЕ блокирует основной поток. Ветка
      // документации идёт параллельно коммиту (fork/join) и вправе выполняться
      // дольше, но её BLOCKED-вердикт (напр. расхождение код↔документация) НЕ
      // должен оставлять задачу-ветвь в BLOCKED — иначе join ждёт вечно и держит
      // родителя. Поэтому «блок» документации = мягкое движение вперёд по ветке
      // (к Keeper → join), с сохранением причины для наблюдаемости.
      if (verdict.status === 'BLOCKED') return docForward('docs_blocked_forwarded');
      if (verdict.status === 'UPDATE_REQUIRED') return branch('dockeeper', 'DOCUMENTATION_KEEPER', 'docs_update_required', 'forward');
      if (verdict.status === 'ARCHITECT_REVIEW_REQUIRED') return branch('design', 'ARCHITECT', 'docs_architect_review', 'forward');
      return forward;
    case 'DOCUMENTATION_KEEPER':
      // DOC-BRANCH-LIVENESS-001: см. выше — Keeper тоже не блокирует основной поток.
      if (verdict.status === 'BLOCKED') return docForward('docs_blocked_forwarded');
      return forward;
    default:
      return verdict.ok === false ? block('role_failed') : forward;
  }
}

// Чистое решение о переходе по вердикту. Не трогает БД.
// reworkCount — сколько раз задача уже возвращалась в CODING (защита от цикла).
// Возвращает { toStatus, nextRole, done, blocked, agentRunStatus, reason }.
export function decideTransition(roleCode, verdict, { reworkCount = 0, maxRework = MAX_REWORK } = {}) {
  const flow = ROLE_FLOW[roleCode];
  if (!flow) return { blocked: true, agentRunStatus: 'FAILED', reason: 'unknown_role' };

  const proceed = () => ({
    toStatus: flow.to,
    nextRole: flow.next,
    done: flow.next === null,
    blocked: false,
    agentRunStatus: 'SUCCESS',
    reason: 'ok',
  });
  const block = (reason) => ({
    toStatus: 'BLOCKED',
    nextRole: null,
    done: false,
    blocked: true,
    agentRunStatus: 'FAILED',
    reason,
  });
  const toAnalyst = () => ({
    toStatus: 'FAILURE_ANALYSIS',
    nextRole: 'FAILURE_ANALYST',
    done: false,
    blocked: false,
    agentRunStatus: 'SUCCESS',
    reason: 'review_failed',
  });

  switch (roleCode) {
    case 'TASK_REVIEWER':
      // Гейт качества: проходим только при явном APPROVED. Любой не-успех
      // (включая неразобранный вердикт) — на анализ причины.
      if (verdict.ok === true) return proceed();
      if (reworkCount >= maxRework) return block('max_rework_exceeded');
      return toAnalyst();
    case 'FAILURE_ANALYST':
      // Диагност всегда возвращает работу Programmer, кроме явного тупика.
      if (verdict.ok === false && ['INCONCLUSIVE', 'INFRASTRUCTURE_BLOCKED'].includes(verdict.status)) {
        return block(verdict.status.toLowerCase());
      }
      if (reworkCount >= maxRework) return block('max_rework_exceeded');
      return proceed();
    case 'ARCHITECT':
    case 'DECOMPOSER':
      // Проектные роли: BLOCKED => остановка на пользователя, иначе вперёд.
      if (verdict.ok === false) return block(verdict.status.toLowerCase() || 'blocked');
      return proceed();
    case 'DOCUMENTATION_AUDITOR':
      // Аудитор не гейт корректности, но МАРШРУТИЗИРУЕТ по вердикту (поле
      // next_role модели движок не читает — решение принимаем здесь по статусу):
      //   UPDATE_REQUIRED           → Documentation Keeper (обновить документы);
      //   ARCHITECT_REVIEW_REQUIRED → Architect (незапланированное арх. изменение);
      //   NO_CHANGES / прочее       → Git Integrator (документы актуальны);
      //   BLOCKED                   → НЕ остановка: документация не блокирует
      //                               основной поток (DOC-BRANCH-LIVENESS-001) →
      //                               идём вперёд как при NO_CHANGES.
      if (verdict.status === 'BLOCKED') return { ...proceed(), reason: 'docs_blocked_forwarded' };
      if (verdict.status === 'UPDATE_REQUIRED') {
        return {
          toStatus: 'COMMIT', nextRole: 'DOCUMENTATION_KEEPER', done: false,
          blocked: false, agentRunStatus: 'SUCCESS', reason: 'docs_update_required',
        };
      }
      if (verdict.status === 'ARCHITECT_REVIEW_REQUIRED') {
        return {
          toStatus: 'ARCHITECTURE', nextRole: 'ARCHITECT', done: false,
          blocked: false, agentRunStatus: 'SUCCESS', reason: 'docs_architect_review',
        };
      }
      return proceed(); // NO_CHANGES и любой разборчивый ответ → Git Integrator
    case 'DOCUMENTATION_KEEPER':
      // Keeper обновил документы → Git Integrator; противоречивое задание НЕ
      // блокирует основной поток (DOC-BRANCH-LIVENESS-001) → идём вперёд.
      if (verdict.status === 'BLOCKED') return { ...proceed(), reason: 'docs_blocked_forwarded' };
      return proceed();
    default:
      return verdict.ok === false ? block('role_failed') : proceed();
  }
}

// --- Сетевой слой (вне транзакции) -----------------------------------------

// ROLE-ENGINE-ROUTING-001: коннектор, ЯВНО назначенный роли в карточке роли
// (role_connectors → «Движок»). Если назначен включённый API-коннектор с токеном
// — внутренний цикл использует именно его (а не подбор по consumer_service).
// Коннекторы-драйверы (codex/claude_code) сюда не попадают: у них пустой токен,
// и такие роли исполняет хостовый драйвер, а не runReasoningRole.
export async function pickAssignedConnectorRow(client, roleCode) {
  const r = await client.query(
    `SELECT cn.id, cn.name, cn.provider, cn.endpoint, cn.access_token, cn.model,
            cn.consumer_service, cn.priority
       FROM role_connectors rc
       JOIN connectors cn ON cn.id = rc.connector_id
      WHERE rc.role_code = $1 AND cn.is_enabled = true AND cn.access_token <> ''
      LIMIT 1`,
    [roleCode],
  );
  return r.rows[0] ?? null;
}

// Выбрать включённый коннектор с токеном. Предпочтение: точное совпадение
// consumer_service, затем пустой consumer_service, затем по priority.
export async function pickConnectorRow(client, consumerService = '') {
  const r = await client.query(
    `SELECT id, name, provider, endpoint, access_token, model, consumer_service, priority
       FROM connectors
      WHERE is_enabled = true AND access_token <> ''
      ORDER BY (consumer_service = $1) DESC, (consumer_service = '') DESC, priority ASC, lower(name) ASC
      LIMIT 1`,
    [consumerService],
  );
  return r.rows[0] ?? null;
}

function rowToConn(row) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    endpoint: row.endpoint,
    accessToken: row.access_token,
    model: row.model,
    consumerService: row.consumer_service,
  };
}

/**
 * Выполнить «мышление» роли: вызвать ИИ и вернуть нормализованный вердикт.
 * Журналирует обмен в prompt_exchanges (is_manual=false). НЕ делает переходов.
 * Бросает при отсутствии коннектора/промта или сетевой ошибке — вызывающий
 * трактует это как провал шага роли.
 *
 * @returns {{ verdict, response, promptText, connectorId, exchangeId, durationMs }}
 */
export async function runReasoningRole(client, { roleCode, context, outputFields = [], toolSchemas = [], executeTool = null }) {
  // System-промт = сохранённый в БД prompt роли + содержимое подключённых
  // skills в зафиксированном порядке.
  const { composeRoleSystemPrompt } = await import('./roles.js');
  const system = await composeRoleSystemPrompt(client, roleCode);
  const user = buildUserPayload(roleCode, context, outputFields);
  // Сначала — коннектор, явно назначенный роли (карточка роли → «Движок»);
  // иначе подбор по consumer_service/priority (прежнее поведение, фолбэк).
  const row = (await pickAssignedConnectorRow(client, roleCode))
    ?? (await pickConnectorRow(client, `runner:${roleCode}`));
  if (!row) {
    const e = new Error('no_enabled_connector');
    e.code = 'NO_CONNECTOR';
    throw e;
  }
  const conn = rowToConn(row);
  // Инструменты роли используем, только если есть схемы И исполнитель.
  const useTools = Array.isArray(toolSchemas) && toolSchemas.length > 0 && typeof executeTool === 'function';

  const promptText = `${system}\n\n${user}`;
  const ins = await client.query(
    `INSERT INTO prompt_exchanges (connector_id, consumer_service, prompt, status, is_manual)
     VALUES ($1, $2, $3, 'отправлен', false) RETURNING id`,
    [conn.id, `runner:${roleCode}`, promptText],
  );
  const exchangeId = ins.rows[0].id;

  try {
    let text;
    let httpStatus = null;
    let durationMs = null;
    let tokensIn = 0;
    let tokensOut = 0;
    let turns = null;
    if (useTools) {
      const started = Date.now();
      const loop = await runToolLoop(conn, { system, user, toolSchemas, executeTool });
      text = loop.text;
      durationMs = Date.now() - started;
      tokensIn = loop.tokensIn ?? 0;
      tokensOut = loop.tokensOut ?? 0;
      turns = loop.iterations ?? null;
    } else {
      const r = await llmInvoke(conn, { system, user }, { timeoutMs: LLM_CALL_TIMEOUT_MS });
      text = r.text;
      httpStatus = r.httpStatus;
      durationMs = r.durationMs;
      tokensIn = r.tokensIn ?? 0;
      tokensOut = r.tokensOut ?? 0;
      turns = 1;
    }
    await client.query(
      `UPDATE prompt_exchanges SET response = $2, status = 'завершен', http_status = $3, duration_ms = $4
        WHERE id = $1`,
      [exchangeId, text, httpStatus ?? null, durationMs ?? null],
    );
    // parsed === null означает, что в ответе модели не нашлось распознаваемого
    // JSON-вердикта (напр. DeepSeek прислал tool-call разметку вместо финала).
    // Вызывающий трактует это как «роль не выполнена», а не как успех.
    const parsed = parseVerdict(text);
    const verdict = normalizeVerdict(roleCode, parsed);
    return { verdict, parsed, response: text, promptText, connectorId: conn.id, exchangeId, durationMs, tokensIn, tokensOut, turns };
  } catch (e) {
    await client.query(
      `UPDATE prompt_exchanges SET status = 'ошибка', error = $2, http_status = $3, duration_ms = $4
        WHERE id = $1`,
      [exchangeId, e.message, e.httpStatus ?? null, e.durationMs ?? null],
    );
    throw e;
  }
}
