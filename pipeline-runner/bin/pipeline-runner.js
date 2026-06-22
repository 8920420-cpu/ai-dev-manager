#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runPipeline } from '../src/index.js';

const HELP = `pipeline-runner — универсальный запускатель этапов из .pipeline.json

Использование:
  pipeline-runner --config .pipeline.json
  pipeline-runner --config services/catalog/.pipeline.json

Опции:
  -c, --config <path>   путь к конфигу (по умолчанию: .pipeline.json)
  -h, --help            показать справку

Вывод:
  stdout — итоговый JSON { success, runId, reportPath, [failedStage] }
  stderr — ход выполнения (дублируется в pipeline.log)

Код возврата:
  0 — pipeline успешен
  1 — какой-то этап упал
  2 — ошибка конфигурации/запуска
`;

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        config: { type: 'string', short: 'c', default: '.pipeline.json' },
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
