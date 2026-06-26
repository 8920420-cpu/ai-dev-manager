#!/usr/bin/env node
// MCP-SERVICE-001 — точка входа MCP-сервера AI Dev Manager.
//
// По умолчанию — stdio MCP (для Claude Code / Codex / VS Code). Флаг --http или
// env MCP_HTTP=1 дополнительно/вместо поднимает HTTP-режим (Streamable + health).
// В stdio-режиме логи идут только в stderr (stdout зарезервирован под протокол).
import process from 'node:process';
import { loadConfig, truthy } from '../src/config.js';
import { startStdio, startHttp } from '../src/server.js';

const config = loadConfig();
const wantHttp = process.argv.includes('--http') || process.argv.includes('--http-only') || truthy(process.env.MCP_HTTP);
const httpOnly = process.argv.includes('--http-only');

async function main() {
  if (wantHttp) startHttp(config);
  // stdio — основной транспорт; поднимаем его всегда, кроме явного --http-only.
  if (!httpOnly) await startStdio(config);
}

main().catch((e) => {
  console.error('[mcp-service] фатальная ошибка запуска:', e?.stack || e?.message || e);
  process.exit(1);
});

// Аккуратное завершение.
function shutdown() {
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Не роняем процесс из-за необработанной ошибки одного запроса.
process.on('unhandledRejection', (e) => console.error('[mcp-service] unhandledRejection:', e));
