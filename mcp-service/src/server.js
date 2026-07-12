// MCP-SERVICE-001 — сборка MCP-сервера и транспорты (stdio + опциональный HTTP).
//
// buildServer() создаёт McpServer и регистрирует инструменты — без привязки к
// транспорту, что удобно для тестов. startStdio()/startHttp() поднимают транспорт.
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, checkConfig } from './config.js';
import { createToolsClient } from './toolsClient.js';
import { createOrchestratorClient } from './orchestratorClient.js';
import { registerTools } from './tools.js';
import { isBearerOrApiTokenAuthorized } from '../../shared/httpAuth.js';

export const SERVICE_NAME = 'ai-dev-manager';
export const SERVICE_VERSION = '1.0.0';

/** Создать McpServer с зарегистрированными инструментами и клиентами. */
export function buildServer(config = loadConfig()) {
  const server = new McpServer(
    { name: SERVICE_NAME, version: SERVICE_VERSION },
    { capabilities: { tools: {} } },
  );
  const toolsClient = createToolsClient({
    baseUrl: config.toolsServiceUrl,
    token: config.orchestratorToken,
    timeoutMs: config.requestTimeoutMs,
  });
  const orchestratorClient = createOrchestratorClient({
    baseUrl: config.orchestratorUrl,
    token: config.orchestratorToken,
    timeoutMs: config.requestTimeoutMs,
  });
  const tools = registerTools(server, { config, toolsClient, orchestratorClient });
  return { server, config, tools, toolsClient, orchestratorClient };
}

/**
 * Запустить stdio-транспорт. В stdio-режиме НЕЛЬЗЯ писать в stdout — логи только
 * в stderr (process.stderr через console.error).
 */
export async function startStdio(config = loadConfig()) {
  const { server, tools } = buildServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP-TOKEN-SYNC-001 — диагностика конфигурации ДО первого вызова: если
  // мутации включены без токена, предупреждаем в stderr (stdout занят протоколом).
  // Логируем только булев признак наличия токена, но НЕ его значение.
  const check = checkConfig(config);
  for (const p of check.problems) {
    console.error(`[mcp-service] КОНФИГУРАЦИЯ (${p.level}): ${p.message}`);
  }
  console.error(
    `[mcp-service] stdio готов: ${tools.length} инструментов, ROOT=${config.projectRoot}, ` +
      `orchestrator=${config.orchestratorUrl}, tools=${config.toolsServiceUrl}, ` +
      `token=${check.tokenConfigured ? 'задан' : 'отсутствует'}, ` +
      `mutations=${check.mutationsEnabled ? 'on' : 'off'}`,
  );
  return { server, transport, tools };
}

/** Ошибка HTTP-уровня с привязанным статусом (для 400/401/413 без 500). */
function httpError(statusCode, code) {
  const e = new Error(code);
  e.statusCode = statusCode;
  return e;
}

/**
 * Прочитать JSON-тело с лимитом. Превышение лимита → 413 (поток обрывается,
 * чтобы не копить память), битый JSON → 400. Пустое тело → undefined.
 */
async function readJsonBody(req, limitBytes = 1048576) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) {
      // Прекращаем читать тело: pause() (а не destroy()) останавливает накопление
      // памяти/CPU, но оставляет сокет живым — иначе клиент не получит 413, а
      // увидит обрыв соединения. Выход из цикла прекращает push новых чанков.
      req.pause();
      throw httpError(413, 'payload_too_large');
    }
    chunks.push(c);
  }
  if (!chunks.length) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, 'invalid_json');
  }
}

/**
 * Запустить HTTP-режим (Streamable HTTP MCP в stateless-режиме + health).
 *   GET  /health, /healthz → проверка живости (для Docker healthcheck);
 *   POST /mcp              → MCP Streamable HTTP (на запрос — свежий server+transport).
 * stdio остаётся основным транспортом; HTTP — опционален.
 */
export function startHttp(config = loadConfig(), { logger = console.error } = {}) {
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/health' || path === '/healthz' || path === '/readiness')) {
      // MCP-TOKEN-SYNC-001 — health отдаёт диагностику согласованности токена/мутаций
      // (булев tokenConfigured, БЕЗ значения токена), чтобы проблему было видно до
      // первого вызова. Сам liveness остаётся 200 (для Docker healthcheck).
      const check = checkConfig(config);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(
        JSON.stringify({
          status: 'ok',
          service: 'mcp-service',
          version: SERVICE_VERSION,
          orchestrator: {
            url: check.orchestratorUrl,
            tokenConfigured: check.tokenConfigured,
            mutationsEnabled: check.mutationsEnabled,
            configOk: check.ok,
          },
          ...(check.ok ? {} : { warnings: check.problems.map((p) => p.message) }),
        }),
      );
    }

    if (path === '/mcp') {
      // SECURITY: вход на /mcp под токеном (если задан). /mcp выдаёт инструменты
      // записи/удаления файлов и мутаций оркестратора — без auth публиковать нельзя.
      if (!isBearerOrApiTokenAuthorized(req, {
        token: config.orchestratorToken,
        allowInsecureLocal: config.allowInsecureLocal,
      })) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null }));
      }
      let body;
      try {
        if (req.method === 'POST') body = await readJsonBody(req, config.bodyLimitBytes);
        const { server } = buildServer(config);
        // stateless: без генерации session id — на каждый запрос свежий transport.
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          transport.close().catch(() => {});
          server.close().catch(() => {});
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        if (!res.headersSent) {
          // Битый/слишком большой JSON — клиентская ошибка (400/413), не 500.
          const status = e?.statusCode || 500;
          const rpcCode = status === 500 ? -32603 : -32600;
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: rpcCode, message: e?.message || String(e) }, id: null }));
        }
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  httpServer.listen(config.port, () => logger(`[mcp-service] HTTP готов на :${config.port} (POST /mcp, GET /health)`));
  return httpServer;
}
