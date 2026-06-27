// Клиент микросервиса tools-service: исполнение builtin-инструментов (function
// calling рассуждающих ролей) и сборка MCP-конфигурации для Claude Code.
const BASE = String(process.env.TOOLS_SERVICE_URL || 'http://tools-service:4188').replace(/\/+$/, '');
const TOKEN = String(process.env.ORCHESTRATOR_API_TOKEN || '').trim();
const TIMEOUT_MS = Number(process.env.TOOLS_SERVICE_TIMEOUT_MS || 30000);

// PROJECT-PATH-MAP-001: оркестратор хранит root_path как путь ХОСТА (напр.
// Windows «K:\…\PS»), а tools-service видит проекты в своём контейнере (см.
// docker-compose: родитель проектов смонтирован в /projects). Без трансляции
// host→контейнер любой read_file/list_dir роли падает «файл не найден», и роль
// штатно отдаёт вердикт BLOCKED. Карта задаётся TOOLS_PROJECT_PATH_MAP в виде
// «<hostPrefix>=><containerPrefix>», пар можно несколько (через «;» или перевод
// строки). Пустая карта (локальный прогон без контейнера) → путь не меняем.
const normSlashes = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

function parsePathMap(spec) {
  return String(spec || '')
    .split(/[;\n]+/)
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [from, to] = pair.split('=>').map((x) => normSlashes(x));
      return from && to ? { from, to } : null;
    })
    .filter(Boolean);
}

const PATH_MAP = parsePathMap(process.env.TOOLS_PROJECT_PATH_MAP);

/**
 * Преобразовать корень проекта (host root_path) в путь, видимый tools-service
 * внутри контейнера. Сравнение префикса регистронезависимо (диск Windows). Если
 * карта пуста или префикс не совпал — возвращаем исходный путь как есть.
 */
export function mapRootToContainer(root) {
  const src = normSlashes(root);
  if (!src) return root;
  for (const { from, to } of PATH_MAP) {
    const low = src.toLowerCase();
    if (low === from.toLowerCase()) return to;
    const prefix = `${from}/`.toLowerCase();
    if (low.startsWith(prefix)) return `${to}/${src.slice(prefix.length)}`;
  }
  return root;
}

function headers() {
  const h = { 'content-type': 'application/json' };
  if (TOKEN) h.authorization = `Bearer ${TOKEN}`;
  return h;
}

async function postJson(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { ok: false, error: text };
  }
  return { status: res.status, body: parsed };
}

/**
 * Выполнить builtin-инструмент. args дополняются корнем проекта (root). Возвращает
 * результат инструмента; при ошибке — бросает Error с понятным сообщением (роль
 * увидит его как результат вызова и сможет скорректировать действия).
 */
export async function executeTool(name, args, { root } = {}) {
  const { status, body } = await postJson('/execute', { tool: name, args: { ...(args || {}), root: mapRootToContainer(root) } });
  if (status >= 200 && status < 300 && body?.ok) return body.result;
  const e = new Error(body?.error || `tools-service ${status}`);
  e.code = body?.code || 'tool_error';
  throw e;
}

/** Собрать MCP-конфиг ({ mcpServers }) для набора tool'ов. */
export async function buildMcpConfig(tools) {
  const { status, body } = await postJson('/mcp-config', { tools: tools || [] });
  if (status >= 200 && status < 300) return body;
  return { mcpServers: {} };
}
