#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { runPipeline } from '../src/index.js';
import { runServicePipeline } from '../src/ServicePipelineTask.js';

const HELP = `pipeline-runner — универсальный запускатель этапов из .pipeline.json

Использование:
  # Прямой запуск конкретного конфига:
  pipeline-runner --config .pipeline.json
  pipeline-runner --config services/catalog/.pipeline.json

  # Сервисный режим (PIPELINE_SERVICE): запуск pipeline по claim оркестратора.
  # claim — это объект задачи из GET /api/runner/next-host-task (с полем pipeline).
  pipeline-runner --task claim.json --projects-root /abs/projects/root
  cat claim.json | pipeline-runner --task - --projects-root /abs/projects/root

Опции:
  -c, --config <path>        путь к конфигу (по умолчанию: .pipeline.json)
  -t, --task <path|->        путь к JSON claim-задачи ('-' = stdin), сервисный режим
  -r, --projects-root <dir>  АБСОЛЮТНЫЙ корень проектов (для сервисного режима)
  -h, --help                 показать справку

Вывод:
  stdout — итоговый JSON результата (для оркестратора)
  stderr — ход выполнения (дублируется в pipeline.log)

Код возврата:
  0 — pipeline успешен
  1 — какой-то этап упал / задача завершилась неуспехом
  2 — ошибка конфигурации/запуска/аргументов
`;

async function readClaim(source) {
  const raw = source === '-' ? await readStdin() : await readFile(source, 'utf8');
  return JSON.parse(raw);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        config: { type: 'string', short: 'c', default: '.pipeline.json' },
        task: { type: 'string', short: 't' },
        'projects-root': { type: 'string', short: 'r' },
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

  // Сервисный режим: запуск этапа PIPELINE_SERVICE по claim оркестратора.
  if (values.task) {
    if (!values['projects-root']) {
      process.stderr.write('Сервисный режим требует --projects-root (абсолютный путь)\n\n' + HELP);
      process.exit(2);
    }
    let claim;
    try {
      claim = await readClaim(values.task);
    } catch (err) {
      process.stdout.write(
        JSON.stringify({ success: false, error: `Не удалось прочитать claim: ${String(err.message || err)}` }, null, 2) + '\n',
      );
      process.exit(2);
    }
    // claim может прийти как { task: {...} } (ответ API) или как сама задача.
    const task = claim && typeof claim === 'object' && claim.task ? claim.task : claim;
    const result = await runServicePipeline(task, { projectsRoot: values['projects-root'] });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.success ? 0 : 1);
  }

  try {
    const result = await runPipeline({ configPath: values.config });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.success ? 0 : 1);
  } catch (err) {
    // Ошибка конфигурации или иной сбой до/во время оркестрации.
    process.stdout.write(
      JSON.stringify({ success: false, error: String(err.message || err) }, null, 2) + '\n',
    );
    process.exit(2);
  }
}

main();
