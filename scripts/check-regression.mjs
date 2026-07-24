#!/usr/bin/env node
// Анти-регрессия решений — host-CLI (ADVISORY, ничего не блокирует).
//
// Сверяет предлагаемый подход с реестром РАНЕЕ ОТВЕРГНУТЫХ решений в ClickHouse,
// чтобы не переизобретать то, что уже пробовали и сознательно отклонили. Это
// только предупреждение — скрипт ВСЕГДА завершается кодом 0.
//
// Использование:
//   node scripts/check-regression.mjs --text "..." [--area <area>] [--threshold <0..1>]
//
// Если ClickHouse выключен/недоступен — печатает «проверка пропущена» и выходит 0.

import { checkApproach } from '../orchestrator-service/backend/src/antiRegression.js';

// Простой разбор аргументов вида --key value.
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const text = typeof args.text === 'string' ? args.text : '';
  const area = typeof args.area === 'string' ? args.area : undefined;
  const threshold = args.threshold !== undefined ? Number(args.threshold) : undefined;

  if (!text) {
    console.log('Использование: node scripts/check-regression.mjs --text "..." [--area <area>] [--threshold <0..1>]');
    console.log('Ошибка: обязателен аргумент --text');
    return; // advisory: всё равно exit 0
  }

  const opts = {};
  if (Number.isFinite(threshold)) opts.threshold = threshold;
  if (area) opts.area = area;

  const result = await checkApproach({ text, area }, opts);

  if (!result.checked) {
    console.log('Реестр решений недоступен (ClickHouse выключен) — проверка пропущена.');
    return;
  }

  if (!result.flagged) {
    console.log('✓ Совпадений с отвергнутыми решениями нет.');
    return;
  }

  console.log('⚠ Подход похож на ранее отвергнутые решения — проанализируй тщательнее прежде чем повторять:');
  console.log('');
  for (const m of result.matches) {
    const head = `  • ${m.decision_id ?? '(без id)'}  [${m.status ?? '?'}, score=${m.score}${m.area ? `, area=${m.area}` : ''}]`;
    console.log(head);
    if (m.reason) console.log(`      причина отклонения: ${m.reason}`);
    if (m.forbidden) console.log(`      запрещено: ${m.forbidden}`);
  }
}

// Полностью защитный контур: любая ошибка не должна ронять advisory-проверку.
try {
  await main();
} catch (error) {
  console.log('Анти-регрессия: проверка пропущена из-за ошибки:', error?.message || error);
} finally {
  process.exit(0);
}
