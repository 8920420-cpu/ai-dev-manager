#!/usr/bin/env node
// Host-CLI: наполнение реестра решений (decision ledger) в ClickHouse.
//
// Источники:
//   1) DECISIONS.md (ADR-журнал PS) — принятые решения + отвергнутые альтернативы;
//   2) `git log --oneline` — фактические изменения как «решения кода».
// best-effort: недоступность/выключенность ClickHouse не фатальна. С --dry (или при
// выключенном CH) скрипт только парсит и печатает сводку, в ClickHouse не пишет.
//
// Примеры:
//   node scripts/seed-decisions.mjs --dry --git-repo E:/git/ai-dev-manager --git-limit 20
//   node scripts/seed-decisions.mjs --decisions E:/git/PS/DECISIONS.md --git-repo E:/git/PS
//
// ClickHouse-параметры — из env (CLICKHOUSE_URL, CLICKHOUSE_DATABASE,
// CLICKHOUSE_OBSERVABILITY_ENABLED, CLICKHOUSE_USER/PASSWORD, CLICKHOUSE_DECISIONS_TABLE).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  parseDecisionsMarkdown,
  parseGitLogDecisions,
  ensureDecisionSchema,
  upsertDecisions,
} from '../orchestrator-service/backend/src/decisionLedger.js';
import { clickhouseEnabled } from '../orchestrator-service/backend/src/clickhouseClient.js';

function printUsage() {
  console.log(`Использование: node scripts/seed-decisions.mjs [опции]

  --decisions <path>   путь к DECISIONS.md (по умолч. E:/git/PS/DECISIONS.md, если существует)
  --git-repo <path>    репозиторий для git log --oneline (по умолч. .)
  --git-limit <n>      сколько последних коммитов брать (по умолч. 200)
  --dry                не писать в ClickHouse, только показать распарсенное
  -h, --help           показать эту справку`);
}

function parseArgs(argv) {
  const args = { decisions: 'E:/git/PS/DECISIONS.md', gitRepo: '.', gitLimit: 200, dry: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry') args.dry = true;
    else if (a === '--decisions') args.decisions = argv[++i];
    else if (a === '--git-repo') args.gitRepo = argv[++i];
    else if (a === '--git-limit') args.gitLimit = Number(argv[++i]) || 200;
    else if (a === '-h' || a === '--help') args.help = true;
    else console.error(`Неизвестный аргумент: ${a} (пропущен)`);
  }
  return args;
}

// Прочитать и разобрать DECISIONS.md (если существует). Ошибки не бросаем.
function collectDecisions(decisionsPath) {
  try {
    if (decisionsPath && fs.existsSync(decisionsPath)) {
      const md = fs.readFileSync(decisionsPath, 'utf8');
      const rows = parseDecisionsMarkdown(md, { sourceRef: path.basename(decisionsPath) });
      console.log(`DECISIONS.md: распарсено ${rows.length} строк из ${decisionsPath}`);
      return rows;
    }
    console.log(`DECISIONS.md: файл не найден (${decisionsPath}) — пропуск`);
  } catch (e) {
    console.error(`DECISIONS.md: ошибка чтения/разбора: ${e.message}`);
  }
  return [];
}

// Получить и разобрать `git log --oneline -n <limit>` из репо. Ошибки не бросаем.
function collectGit(gitRepo, gitLimit) {
  try {
    const out = execFileSync('git', ['-C', gitRepo, 'log', '--oneline', '-n', String(gitLimit)], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const rows = parseGitLogDecisions(out, { repo: gitRepo });
    console.log(`git: распарсено ${rows.length} коммитов из ${gitRepo}`);
    return rows;
  } catch (e) {
    const first = String(e?.message || e).split('\n')[0];
    console.error(`git: не удалось получить лог (${gitRepo}): ${first}`);
    return [];
  }
}

// Сводка: сколько adopted/rejected и топ областей.
function printSummary(rows) {
  const adopted = rows.filter((r) => r.status === 'adopted').length;
  const rejected = rows.filter((r) => r.status === 'rejected').length;
  const areaCounts = {};
  for (const r of rows) {
    const a = r.area || 'general';
    areaCounts[a] = (areaCounts[a] || 0) + 1;
  }
  const topAreas = Object.entries(areaCounts)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 10)
    .map(([a, n]) => `${a}=${n}`);
  console.log(`Итого строк: ${rows.length} (adopted=${adopted}, rejected=${rejected})`);
  console.log(`Топ area: ${topAreas.join(', ') || '—'}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return 0;
  }

  const rows = [
    ...collectDecisions(args.decisions),
    ...collectGit(args.gitRepo, args.gitLimit),
  ];

  printSummary(rows);

  const chOn = clickhouseEnabled();
  if (args.dry || !chOn) {
    console.log(
      args.dry
        ? 'Режим --dry: запись в ClickHouse пропущена.'
        : 'ClickHouse выключен (CLICKHOUSE_OBSERVABILITY_ENABLED != 1): запись пропущена.',
    );
    return 0;
  }

  if (rows.length === 0) {
    console.log('Нечего писать (0 строк).');
    return 0;
  }

  try {
    const ens = await ensureDecisionSchema();
    console.log(`ensureDecisionSchema: ${JSON.stringify(ens)}`);
    const res = await upsertDecisions(rows);
    console.log(`upsertDecisions: ${JSON.stringify(res)}`);
  } catch (e) {
    console.error(`Запись в ClickHouse не удалась: ${e?.message || e}`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    console.error('Непредвиденная ошибка:', e?.message || e);
    process.exit(0);
  });
