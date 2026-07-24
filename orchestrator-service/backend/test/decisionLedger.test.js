import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDecisionsMarkdown,
  parseGitLogDecisions,
  normalizeSignature,
  decisionRow,
} from '../src/decisionLedger.js';

// Мини-образец DECISIONS.md в реальном стиле журнала: два ADR, у первого есть
// «Альтернативы» (→ companion-строка 'rejected'), у второго — нет.
const SAMPLE_MD = `# DECISIONS.md — журнал

## ADR-01. Каноничный \`nomenclature_id\` = каталог товара

- **Решение:** единственный публичный id товара во всей платформе —
  \`catalog.catalog_items.id\`. Сырые source-link id остаются приватными.
- **Почему:** убрать путаницу пространств имён и коллизии join'ов downstream.
- **Альтернативы:** двойные пространства id (source+canonical) — путаница;
  резолв на стороне downstream — дублирование логики.
- **Нельзя менять:** публиковать сырые id как публичные; вводить второй публичный id.
- Связано с памятью: \`catalog-id-canonical\`.

## ADR-02. ETL — pull-only mirror

- **Решение:** ETL-Splitter отдаёт только pull-API; downstream держат watermark.
- **Почему:** развязать тайминг доставки, единый источник нормализованного потока.
- **Нельзя менять:** возвращать ETL-initiated push как основной контракт доставки.
`;

test('parseDecisionsMarkdown: два ADR → adopted + альтернатива', () => {
  const rows = parseDecisionsMarkdown(SAMPLE_MD, { sourceRef: 'DECISIONS.md' });

  // ADR-01 (adopted) + ADR-01-alt (rejected) + ADR-02 (adopted) = 3 строки.
  assert.equal(rows.length, 3);

  const adopted = rows.filter((r) => r.status === 'adopted');
  const rejected = rows.filter((r) => r.status === 'rejected');
  assert.equal(adopted.length, 2);
  assert.equal(rejected.length, 1);

  const first = rows[0];
  assert.equal(first.decision_id, 'adr-01');
  assert.equal(first.status, 'adopted');
  assert.equal(first.source, 'decisions_md');
  assert.ok(first.approach.length > 0, 'approach не пустой');
  assert.ok(first.approach.includes('публичный id'), 'approach содержит текст «Решение»');
  assert.ok(first.reason.includes('путаницу'), 'reason захвачен');
  assert.ok(first.forbidden.includes('сырые id'), 'forbidden захвачен');
  assert.ok(first.problem_signature.length > 0, 'сигнатура непустая');
  assert.deepEqual(first.related_memory, ['catalog-id-canonical']);

  // companion-строка отвергнутой альтернативы.
  const alt = rows.find((r) => r.decision_id === 'adr-01-alt');
  assert.ok(alt, 'есть строка adr-01-alt');
  assert.equal(alt.status, 'rejected');
  assert.equal(alt.superseded_by, 'adr-01');
  assert.ok(alt.approach.includes('двойные пространства'), 'approach = текст альтернатив');
  assert.ok(alt.reason.includes('ADR-01'), 'reason ссылается на ADR');

  // ADR-02 без альтернатив → только одна (adopted) строка.
  const adr02 = rows.filter((r) => r.decision_id.startsWith('adr-02'));
  assert.equal(adr02.length, 1);
  assert.equal(adr02[0].decision_id, 'adr-02');
  assert.ok(adr02[0].forbidden.includes('push'), 'forbidden ADR-02 захвачен');
});

test('parseGitLogDecisions: scope из conventional-commit', () => {
  const rows = parseGitLogDecisions(
    'abc1234 feat(git-integrator): ребейз стухшей ветки\n def5678 fix(pipeline): npm ci',
    { repo: 'E:/git/ai-dev-manager' },
  );

  assert.equal(rows.length, 2);

  assert.equal(rows[0].decision_id, 'git:abc1234');
  assert.equal(rows[0].area, 'git-integrator');
  assert.deepEqual(rows[0].git_commits, ['abc1234']);
  assert.equal(rows[0].status, 'adopted');
  assert.equal(rows[0].source, 'git');
  assert.equal(rows[0].source_ref, 'E:/git/ai-dev-manager');

  assert.equal(rows[1].area, 'pipeline');
  assert.deepEqual(rows[1].git_commits, ['def5678']);
});

test('parseGitLogDecisions: пустые строки и мусор игнорируются; non-conventional → general', () => {
  const rows = parseGitLogDecisions('\n\nfeed0ff обычное сообщение без типа\n   \n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].area, 'general');
});

test('normalizeSignature: детерминированность и стабильный сортированный порядок', () => {
  const input = 'Каноничный nomenclature_id для каталога; каталог единый ID товара';
  const a = normalizeSignature(input);
  const b = normalizeSignature(input);

  // Детерминированно: два вызова с тем же входом равны.
  assert.equal(a, b);

  const tokens = a.split(' ').filter(Boolean);

  // Уникальность значимых токенов.
  assert.equal(new Set(tokens).size, tokens.length);

  // Стабильный порядок = отсортированный.
  assert.deepEqual(tokens, [...tokens].sort());

  // Короткие/стоп-слова («для», «id») отсеяны, значимые остались.
  assert.ok(tokens.includes('каталог'));
  assert.ok(tokens.includes('nomenclature'));
  assert.ok(!tokens.includes('для'));
});

test('decisionRow: все колонки с дефолтами, updated_at в формате ClickHouse', () => {
  const row = decisionRow({ decision_id: 'adr-99', status: 'adopted', git_commits: ['deadbee'] });
  // Полный набор колонок.
  for (const col of [
    'decision_id', 'source', 'area', 'title', 'problem_signature', 'approach', 'status',
    'reason', 'forbidden', 'alternatives', 'superseded_by', 'git_commits', 'related_memory',
    'source_ref', 'updated_at',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, col), `есть колонка ${col}`);
  }
  assert.equal(row.decision_id, 'adr-99');
  assert.equal(row.area, 'general'); // дефолт
  assert.equal(row.source_ref, ''); // строковый дефолт
  assert.deepEqual(row.related_memory, []); // массивный дефолт
  assert.deepEqual(row.git_commits, ['deadbee']);
  // 'YYYY-MM-DD HH:MM:SS.mmm' без T/Z.
  assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  // version НЕ задаётся тут (в CH — DEFAULT из updated_at).
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'version'));
});
