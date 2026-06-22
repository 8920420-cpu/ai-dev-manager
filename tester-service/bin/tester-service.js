#!/usr/bin/env node
import { parseArgs } from 'node:util';
import process from 'node:process';

import { createServer } from '../src/server.js';
import { TesterService } from '../src/TesterService.js';

const HELP = `tester-service — микросервис роли «Тестировщик (Pipeline Service)»

Запускает Pipeline Runner для задачи и возвращает результат оркестратору.
Сервис не анализирует код и не исправляет ошибки — только исполняет проверку.

Использование:
  tester-service                       запустить HTTP-сервер
  tester-service --check <input.json>  выполнить одну проверку из файла и вывести результат

Опции:
  -p, --port <n>      порт HTTP-сервера (по умолчанию $TESTER_PORT или 4187)
  -c, --check <path>  путь к JSON с входными данными задачи (CLI-режим)
  -h, --help          показать справку

HTTP API:
  GET  /health           проверка живости
  POST /test             тело = { taskId, projectPath, pipelineConfigPath?, changedFiles?, programmerComment? }
  GET  /results/:taskId  ?projectPath=... — сохранённый результат

Код возврата (--check):
  0 — success | 1 — failed | 2 — error/некорректный ввод
`;

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        port: { type: 'string', short: 'p' },
        check: { type: 'string', short: 'c' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (err) {
    process.stderr.write(`Ошибка аргументов: ${err.message}\n\n${HELP}`);
    process.exit(2);
  }

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (values.check) {
    const { readFile } = await import('node:fs/promises');
    let input;
    try {
      input = JSON.parse(await readFile(values.check, 'utf8'));
    } catch (err) {
      process.stdout.write(JSON.stringify({ status: 'error', message: String(err.message) }, null, 2) + '\n');
      process.exit(2);
    }
    const service = new TesterService({ log: (m, meta) => process.stderr.write(`[tester-service] ${m}${meta ? ' ' + JSON.stringify(meta) : ''}\n`) });
    const result = await service.runCheck(input);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.status === 'success' ? 0 : result.status === 'failed' ? 1 : 2);
  }

  const port = Number(values.port ?? process.env.TESTER_PORT ?? 4187);
  const server = createServer();
  server.listen(port, () => {
    process.stderr.write(`[tester-service] слушает порт ${port}\n`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}

main();
