// TASK-ACCEPTANCE-001 — доска приёмки включает CANCELLED с причиной отмены.
// getAcceptanceBoardTx выполняет один SELECT; тестируем через мини-клиент pg
// (в проекте нет живой БД под тестами — тот же приём, что в taskDuplicateClose.test.js).
// Строки задаём в той форме, в которой их отдаёт Postgres после LEFT JOIN LATERAL к
// task_events и извлечения data_card->>'…', и проверяем маппинг и форму выборки.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAcceptanceBoardTx } from '../src/db.js';

// Мини-клиент: на единственный SELECT доски возвращает заданные строки; SQL
// сохраняем, чтобы проверить форму выборки (WHERE IN, LATERAL, порядок, лимит).
function boardClient(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
  };
}

// Принятая DONE-задача: причины отмены нет.
const DONE_ROW = {
  id: 'task-done', title: 'Готовая задача', status: 'DONE', priority: '2',
  accepted_at: new Date('2026-07-01T10:00:00Z'), updated_at: new Date('2026-07-01T10:05:00Z'),
  project_id: 'p1', project_name: 'Проект', service_name: 'svc',
  duplicate_note: null, duplicate_of: null, ev_reason: null, ev_note: null,
};
// Дубль (insertDuplicateClosedTaskTx): duplicateNote/duplicateOf в data_card,
// событие TASK_CANCELLED с reason='duplicate_closed'. Причина берётся из note дубля.
const DUP_ROW = {
  id: 'task-dup', title: 'Дубль', status: 'CANCELLED', priority: '2',
  accepted_at: null, updated_at: new Date('2026-07-02T10:00:00Z'),
  project_id: 'p1', project_name: 'Проект', service_name: null,
  duplicate_note: 'Дубль живой задачи task-orig (совпал отпечаток текста): закрыт автоматически',
  duplicate_of: 'task-orig', ev_reason: 'duplicate_closed', ev_note: null,
};
// Обычная отмена: причина из reason последнего события task_events to_status='CANCELLED'.
const CANCEL_ROW = {
  id: 'task-cancel', title: 'Отменённая', status: 'CANCELLED', priority: '1',
  accepted_at: null, updated_at: new Date('2026-07-03T10:00:00Z'),
  project_id: 'p1', project_name: 'Проект', service_name: 'svc',
  duplicate_note: null, duplicate_of: null,
  ev_reason: 'Задача больше не актуальна', ev_note: 'снята постановщиком',
};
// Отмена без reason → причина из note.
const CANCEL_NOTE_ONLY = {
  id: 'task-cancel2', title: 'Отменённая без reason', status: 'CANCELLED', priority: '2',
  accepted_at: null, updated_at: null,
  project_id: 'p1', project_name: 'Проект', service_name: null,
  duplicate_note: '', duplicate_of: null, ev_reason: '', ev_note: 'закрыто вручную',
};

test('getAcceptanceBoardTx: выборка охватывает DONE и CANCELLED (форма запроса)', async () => {
  const c = boardClient([]);
  await getAcceptanceBoardTx(c);
  const sql = c.calls[0].sql;
  assert.match(sql, /WHERE t\.status IN \('DONE','CANCELLED'\)/);
  assert.match(sql, /LEFT JOIN LATERAL/);
  assert.match(sql, /to_status = 'CANCELLED'/);
  assert.match(sql, /data_card->>'duplicateNote'/);
  assert.match(sql, /data_card->>'duplicateOf'/);
  // Порядок и лимит доски не изменились.
  assert.match(sql, /ORDER BY t\.priority ASC, t\.created_at ASC, t\.id DESC/);
  assert.match(sql, /LIMIT 1000/);
});

test('getAcceptanceBoardTx: CANCELLED видны, cancelReason и duplicateOf заполнены', async () => {
  const c = boardClient([DONE_ROW, DUP_ROW, CANCEL_ROW, CANCEL_NOTE_ONLY]);
  const { tasks } = await getAcceptanceBoardTx(c);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // DONE: статус, приём, причина отмены отсутствует.
  const done = byId.get('task-done');
  assert.equal(done.status, 'DONE');
  assert.equal(done.accepted, true);
  assert.equal(done.cancelReason, null);
  assert.equal(done.duplicateOf, null);

  // Дубль: причина из duplicateNote (приоритетнее reason события), duplicateOf проброшен.
  const dup = byId.get('task-dup');
  assert.equal(dup.status, 'CANCELLED');
  assert.equal(dup.accepted, false);
  assert.equal(dup.cancelReason, DUP_ROW.duplicate_note);
  assert.equal(dup.duplicateOf, 'task-orig');

  // Обычная отмена: причина из reason события; дубля нет.
  const cancel = byId.get('task-cancel');
  assert.equal(cancel.status, 'CANCELLED');
  assert.equal(cancel.cancelReason, 'Задача больше не актуальна');
  assert.equal(cancel.duplicateOf, null);

  // Пустой reason → причина берётся из note.
  const cancel2 = byId.get('task-cancel2');
  assert.equal(cancel2.cancelReason, 'закрыто вручную');
  assert.equal(cancel2.duplicateOf, null);
});

test('getAcceptanceBoardTx: контракт и поля прочих задач не сломаны', async () => {
  const c = boardClient([DONE_ROW]);
  const { tasks } = await getAcceptanceBoardTx(c);
  assert.equal(tasks.length, 1);
  const t = tasks[0];
  assert.deepEqual(Object.keys(t).sort(), [
    'accepted', 'acceptedAt', 'cancelReason', 'duplicateOf', 'id', 'priority',
    'projectId', 'projectName', 'serviceName', 'status', 'title', 'updatedAt',
  ]);
  assert.equal(t.id, 'task-done');
  assert.equal(t.projectId, 'p1');
  assert.equal(t.projectName, 'Проект');
  assert.equal(t.serviceName, 'svc');
  assert.equal(t.priority, '2');
  assert.equal(typeof t.acceptedAt, 'string');
  assert.equal(typeof t.updatedAt, 'string');
});
