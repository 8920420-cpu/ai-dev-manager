#!/usr/bin/env node
// LOGGING-STANDARD-001 — CI-проверка реестра кодов событий/ошибок (§15).
// Гоняется в CI/линте: следит, чтобы коды соответствовали неймингу и не плодились
// разные коды для одной ситуации. Выход != 0 при нарушении.
//   node scripts/check-logging-registry.mjs
import { EVENT_CODES, ERROR_CODES, ERROR_TYPES } from '../shared/logging/registry.js';

const problems = [];
const CODE_RE = /^[A-Z][A-Z0-9_]+$/;

for (const [code, meta] of Object.entries(EVENT_CODES)) {
  if (!CODE_RE.test(code)) problems.push(`event_code невалиден: ${code}`);
  if (!meta.category) problems.push(`event_code без category: ${code}`);
  if (!['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(meta.level)) problems.push(`event_code с неверным level: ${code}`);
}
for (const [code, meta] of Object.entries(ERROR_CODES)) {
  if (!CODE_RE.test(code)) problems.push(`error_code невалиден: ${code}`);
  if (!ERROR_TYPES.includes(meta.type)) problems.push(`error_code с неверным type: ${code} (${meta.type})`);
  if (typeof meta.retryable !== 'boolean') problems.push(`error_code без retryable:boolean: ${code}`);
}

if (problems.length) {
  console.error(`✗ Реестр логирования: ${problems.length} нарушени(й):`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`✓ Реестр логирования: ${Object.keys(EVENT_CODES).length} событий, ${Object.keys(ERROR_CODES).length} ошибок — OK`);
