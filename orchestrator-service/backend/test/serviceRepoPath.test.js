import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deriveServicePathFromFiles,
  serviceDirExists,
  findServiceDirByCode,
  resolveServiceRepoPath,
} from '../src/serviceRepoPath.js';
import { getOrCreateService } from '../src/db.js';

// Мини-клиент pg (как в scannerAutocreate.test.js): отвечает по первому правилу.
function fakeClient(rules) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const rule of rules) {
        if (rule.re.test(sql)) {
          rule.hits = (rule.hits ?? 0) + 1;
          const out = typeof rule.reply === 'function' ? rule.reply(rule.hits, params) : rule.reply;
          return out ?? { rows: [], rowCount: 0 };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// Временное дерево каталогов проекта для fs-тестов. Возвращает корень; каждый
// путь из dirs создаётся как каталог.
function makeTree(dirs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svcrepo-'));
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

// --- deriveServicePathFromFiles (общий каталоговый префикс) -------------------

test('deriveServicePathFromFiles: общий каталог нескольких файлов', () => {
  assert.equal(
    deriveServicePathFromFiles(['CRM/Chat_Service/a.js', 'CRM/Chat_Service/sub/b.js']),
    'CRM/Chat_Service',
  );
});

test('deriveServicePathFromFiles: один файл → его каталог', () => {
  assert.equal(deriveServicePathFromFiles(['Auth/IAM_Service/index.ts']), 'Auth/IAM_Service');
});

test('deriveServicePathFromFiles: объекты {path} и бэкслэши поддерживаются', () => {
  assert.equal(
    deriveServicePathFromFiles([{ path: 'CRM\\Chat_Service\\a.js' }, { path: 'CRM\\Chat_Service\\b.js' }]),
    'CRM/Chat_Service',
  );
});

test('deriveServicePathFromFiles: нет общего префикса → пусто', () => {
  assert.equal(deriveServicePathFromFiles(['CRM/a.js', 'WEBSTORE/b.js']), '');
});

test('deriveServicePathFromFiles: пусто/абсолютные/диск → пусто', () => {
  assert.equal(deriveServicePathFromFiles([]), '');
  assert.equal(deriveServicePathFromFiles(['/abs/x.js']), '');
  assert.equal(deriveServicePathFromFiles(['C:/win/x.js']), '');
  assert.equal(deriveServicePathFromFiles(['file-in-root.js']), '');
});

// --- serviceDirExists --------------------------------------------------------

test('serviceDirExists: существующий каталог → true, отсутствующий/пустой → false', () => {
  const root = makeTree(['CRM/Chat_Service']);
  assert.equal(serviceDirExists(root, 'CRM/Chat_Service'), true);
  assert.equal(serviceDirExists(root, 'CRM/Ghost'), false);
  assert.equal(serviceDirExists(root, ''), false); // пустой путь = «в корне» — не каталог сервиса
  assert.equal(serviceDirExists(root, '../escape'), false);
});

// --- findServiceDirByCode (бэкфилл по коду) -----------------------------------

test('findServiceDirByCode: единственное совпадение имени каталога → относительный путь', () => {
  const root = makeTree(['CRM/Chat_Service', 'Auth/IAM_Service', 'WEBSTORE']);
  assert.equal(findServiceDirByCode(root, 'Chat_Service'), 'CRM/Chat_Service');
  assert.equal(findServiceDirByCode(root, 'IAM_Service'), 'Auth/IAM_Service');
  assert.equal(findServiceDirByCode(root, 'WEBSTORE'), 'WEBSTORE');
});

test('findServiceDirByCode: совпадение регистронезависимо (GETWAY ↔ Getway)', () => {
  const root = makeTree(['Getway']);
  assert.equal(findServiceDirByCode(root, 'GETWAY'), 'Getway');
});

test('findServiceDirByCode: несколько совпадений → null (неоднозначно)', () => {
  const root = makeTree(['a/Svc', 'b/Svc']);
  assert.equal(findServiceDirByCode(root, 'Svc'), null);
});

test('findServiceDirByCode: нет совпадений → null', () => {
  const root = makeTree(['CRM/Chat_Service']);
  assert.equal(findServiceDirByCode(root, 'Nope'), null);
});

test('findServiceDirByCode: глубже maxDepth не находит', () => {
  const root = makeTree(['a/b/c/Deep']); // глубина 4
  assert.equal(findServiceDirByCode(root, 'Deep', { maxDepth: 3 }), null);
  assert.equal(findServiceDirByCode(root, 'Deep', { maxDepth: 4 }), 'a/b/c/Deep');
});

test('findServiceDirByCode: node_modules и скрытые каталоги игнорируются', () => {
  const root = makeTree(['node_modules/Svc', '.hidden/Svc', 'real/Svc']);
  assert.equal(findServiceDirByCode(root, 'Svc'), 'real/Svc');
});

test('findServiceDirByCode: пустой корень/код или несуществующий корень → null', () => {
  assert.equal(findServiceDirByCode('', 'Svc'), null);
  assert.equal(findServiceDirByCode('/no/such/root', 'Svc'), null);
  const root = makeTree(['Svc']);
  assert.equal(findServiceDirByCode(root, ''), null);
});

// --- resolveServiceRepoPath (валидный/бэкфилл/провал) -------------------------

test('resolveServiceRepoPath: валидный существующий путь оставляем как есть', () => {
  const root = makeTree(['CRM/Chat_Service']);
  const r = resolveServiceRepoPath(root, 'Chat_Service', 'CRM/Chat_Service');
  assert.deepEqual(r, { ok: true, repositoryPath: 'CRM/Chat_Service', changed: false });
});

test('resolveServiceRepoPath: пустой путь → бэкфилл по коду (changed=true)', () => {
  const root = makeTree(['CRM/Chat_Service']);
  const r = resolveServiceRepoPath(root, 'Chat_Service', null);
  assert.equal(r.ok, true);
  assert.equal(r.repositoryPath, 'CRM/Chat_Service');
  assert.equal(r.changed, true);
});

test('resolveServiceRepoPath: устаревший путь (каталога нет) → бэкфилл по коду', () => {
  const root = makeTree(['CRM/Chat_Service']);
  const r = resolveServiceRepoPath(root, 'Chat_Service', 'services/chat');
  assert.equal(r.ok, true);
  assert.equal(r.repositoryPath, 'CRM/Chat_Service');
  assert.equal(r.changed, true);
});

test('resolveServiceRepoPath: путь пуст и по коду не найдено → service_path_unresolved', () => {
  const root = makeTree(['CRM/Other']);
  const r = resolveServiceRepoPath(root, 'GETWAY', null);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'service_path_unresolved');
  assert.match(r.message, /GETWAY/);
  assert.match(r.message, /repository_path не задан\/не найден/);
});

test('resolveServiceRepoPath: неоднозначный код → service_path_unresolved (не угадываем)', () => {
  const root = makeTree(['a/Svc', 'b/Svc']);
  const r = resolveServiceRepoPath(root, 'Svc', null);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'service_path_unresolved');
});

// --- getOrCreateService: авторегистрация пишет repository_path ----------------

test('getOrCreateService: новый сервис — repository_path попадает в INSERT', async () => {
  const c = fakeClient([
    { re: /SELECT id FROM services WHERE project_id/, reply: { rowCount: 0, rows: [] } },
    { re: /INSERT INTO services/, reply: { rowCount: 1, rows: [{ id: 'svc-new' }] } },
  ]);
  const id = await getOrCreateService(c, 'proj-1', 'Chat_Service', null, 'CRM/Chat_Service');
  assert.equal(id, 'svc-new');
  const ins = c.calls.find((q) => /INSERT INTO services/.test(q.sql));
  assert.match(ins.sql, /repository_path/);
  assert.equal(ins.params[3], 'CRM/Chat_Service', 'repository_path записан 4-м параметром');
});

test('getOrCreateService: пустой путь → repository_path = NULL', async () => {
  const c = fakeClient([
    { re: /SELECT id FROM services WHERE project_id/, reply: { rowCount: 0, rows: [] } },
    { re: /INSERT INTO services/, reply: { rowCount: 1, rows: [{ id: 'svc-new' }] } },
  ]);
  await getOrCreateService(c, 'proj-1', 'Svc', null, '');
  const ins = c.calls.find((q) => /INSERT INTO services/.test(q.sql));
  assert.equal(ins.params[3], null, 'пустой путь пишется как NULL');
});

test('getOrCreateService: существующий сервис — INSERT не выполняется', async () => {
  const c = fakeClient([
    { re: /SELECT id FROM services WHERE project_id/, reply: { rowCount: 1, rows: [{ id: 'svc-1' }] } },
  ]);
  const id = await getOrCreateService(c, 'proj-1', 'Svc', null, 'CRM/Svc');
  assert.equal(id, 'svc-1');
  assert.equal(c.calls.some((q) => /INSERT INTO services/.test(q.sql)), false, 'существующий не пересоздаём');
});
