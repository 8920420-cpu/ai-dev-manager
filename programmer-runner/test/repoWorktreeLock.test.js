import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { withRepoWorktreeLock, lockPathFor, repoLockKey } from '../../shared/repoWorktreeLock.js';

// WORKTREE-CROSSPROC-LOCK-001 — межпроцессный файловый лок структурных git-операций репо.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Уникализируем ключи репозиториев по прогону, чтобы тесты не делили lock-файлы.
const uniq = (n) => `Z:/__wtlock_test__/${process.pid}/${n}`;

test('канонизация ключа: слэши и регистр не влияют', () => {
  assert.equal(repoLockKey('F:\\git\\PS'), repoLockKey('F:/git/ps'));
  assert.notEqual(repoLockKey('F:/git/PS'), repoLockKey('F:/git/OTHER'));
});

test('взаимное исключение: две секции одного репо НЕ пересекаются', async () => {
  const repo = uniq('excl');
  let active = 0; let maxActive = 0; const order = [];
  const worker = (tag) => withRepoWorktreeLock(repo, async () => {
    active += 1; maxActive = Math.max(maxActive, active); order.push(`+${tag}`);
    await sleep(40);
    order.push(`-${tag}`); active -= 1;
  }, { pollMs: 5 });
  await Promise.all([worker('a'), worker('b'), worker('c')]);
  assert.equal(maxActive, 1, 'одновременно активна максимум одна секция');
  // Каждый вход закрыт до следующего входа (никакого перекрытия +a +b).
  for (let i = 0; i < order.length; i += 2) {
    assert.equal(order[i][0], '+'); assert.equal(order[i + 1][0], '-');
    assert.equal(order[i].slice(1), order[i + 1].slice(1), 'вход и выход одной секции подряд');
  }
});

test('разные репозитории идут параллельно', async () => {
  const r1 = uniq('par1'); const r2 = uniq('par2');
  let bothActive = false; let a = 0;
  const w = (repo) => withRepoWorktreeLock(repo, async () => {
    a += 1; if (a === 2) bothActive = true; await sleep(50); a -= 1;
  }, { pollMs: 5 });
  await Promise.all([w(r1), w(r2)]);
  assert.equal(bothActive, true, 'два разных репо держат локи одновременно');
});

test('протухший держатель (мёртвый pid) — крадётся', async () => {
  const repo = uniq('stale');
  const p = lockPathFor(repo);
  mkdirSync(dirname(p), { recursive: true });
  // Мёртвый pid на этом же хосте (99999999 почти наверняка не существует).
  writeFileSync(p, JSON.stringify({ pid: 99999999, host: (await import('node:os')).hostname(), ts: Date.now() }));
  let ran = false;
  await withRepoWorktreeLock(repo, async () => { ran = true; }, { pollMs: 5, timeoutMs: 5000 });
  assert.equal(ran, true, 'секция выполнилась, мёртвый лок снят');
  assert.equal(existsSync(p), false, 'lock-файл снят после выхода');
});

test('таймаут: живой держатель не отдаёт лок — ждущий падает по таймауту', async () => {
  const repo = uniq('timeout');
  let release;
  const held = new Promise((r) => { release = r; });
  // Держим лок «долго» (живой pid = наш процесс, не крадётся).
  const holder = withRepoWorktreeLock(repo, () => held, { pollMs: 5 });
  await sleep(20);
  await assert.rejects(
    () => withRepoWorktreeLock(repo, async () => {}, { pollMs: 5, timeoutMs: 60, staleMs: 100000 }),
    /repo_worktree_lock_timeout/,
  );
  release(); await holder;
});

test.after(() => { try { rmSync(lockPathFor(uniq('excl')), { force: true }); } catch { /* ok */ } });
