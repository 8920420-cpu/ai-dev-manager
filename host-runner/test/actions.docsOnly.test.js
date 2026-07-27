// GI-DOCS-ONLY-SKIP-STALE-001 — предикат docs-only дельты для пропуска нетто-гарда
// stale_branch_reverts_main (только когда вся дельта под docs/, cherry-pick доков не
// может удалить код). Клапан GI_DOCS_ONLY_SKIP_STALE_GUARD гейтит сам пропуск в
// integrateWorktreeBranch; здесь проверяем чистый предикат.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDocsOnlyChangedSet } from '../src/actions.js';

test('docs-only: все пути под docs/ → true (в т.ч. Set, ./ и backslash)', () => {
  assert.equal(isDocsOnlyChangedSet(['docs/audit/pricing-audit.md', 'docs/audit/crm.md']), true);
  assert.equal(isDocsOnlyChangedSet(new Set(['docs/x.md'])), true);
  assert.equal(isDocsOnlyChangedSet(['./docs/x.md']), true);
  assert.equal(isDocsOnlyChangedSet(['docs\\audit\\x.md']), true);
});

test('смешанная дельта (docs + код) → false (код интегрируется штатно)', () => {
  assert.equal(isDocsOnlyChangedSet(['docs/a.md', 'backend/internal/svc.go']), false);
});

test('только код → false', () => {
  assert.equal(isDocsOnlyChangedSet(['backend/main.go']), false);
});

test('пустой набор → false (нечего доставлять)', () => {
  assert.equal(isDocsOnlyChangedSet([]), false);
  assert.equal(isDocsOnlyChangedSet(new Set()), false);
  assert.equal(isDocsOnlyChangedSet(null), false);
});

test('bare-root *.md (README.md, не docs/) → false (узкий предикат docs/)', () => {
  assert.equal(isDocsOnlyChangedSet(['README.md']), false);
  assert.equal(isDocsOnlyChangedSet(['docs/x.md', 'README.md']), false);
});
