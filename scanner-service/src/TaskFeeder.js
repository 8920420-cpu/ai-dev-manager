import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseDocument, writeFileAtomic } from './TaskScanner.js';

/**
 * Обратный мост БД → файл (Stage 2). Когда слот claude-tasks.json свободен,
 * забирает у оркестратора следующую задачу для Claude и пишет её атомарно
 * (temp+rename) со статусом «готово к работе».
 *
 * Единственный писатель файла со стороны оркестратора — этот сервис: и очистка
 * слота (Scanner), и наполнение (Feeder) идут из одного процесса, поэтому гонки
 * остаются только с Claude и гасятся re-read прямо перед записью + atomic rename.
 */
export class TaskFeeder {
  constructor({ documentPath, claimNext, release, log = console } = {}) {
    if (!documentPath) throw new Error('documentPath is required');
    if (typeof claimNext !== 'function') throw new Error('claimNext must be a function');
    this.documentPath = resolve(documentPath);
    this.claimNext = claimNext;
    this.release = typeof release === 'function' ? release : null;
    this.log = log;
    this.feeding = false;
  }

  async feedOnce() {
    if (this.feeding) return { filled: false, reason: 'feed_in_progress' };
    this.feeding = true;
    try {
      if (!(await this.#slotFree())) return { filled: false, reason: 'slot_busy' };
      const { task } = (await this.claimNext()) ?? {};
      if (!task) return { filled: false, reason: 'no_task' };
      try {
        await this.#writeTask(task);
      } catch (error) {
        // Задача уже захвачена в БД, но в файл не легла — вернуть её в пул,
        // иначе зависнет с назначенным агентом и больше не выдастся.
        if (this.release) await this.release(task.id).catch((e) => this.log.error?.('Feeder release failed', { error: e.message }));
        throw error;
      }
      return { filled: true, taskId: task.id };
    } finally {
      this.feeding = false;
    }
  }

  // Слот свободен, когда задач в документе нет (Scanner удалил завершённую).
  async #slotFree() {
    try {
      return parseDocument(await readFile(this.documentPath, 'utf8')).tasks.length === 0;
    } catch (error) {
      if (error.code === 'ENOENT') return true; // файла ещё нет — слот свободен
      this.log.warn?.('Feeder slot check failed', { error: error.message });
      return false; // битый/недочитанный файл не трогаем
    }
  }

  async #writeTask(task) {
    // Re-read прямо перед записью: между проверкой слота и сюда его мог занять
    // Claude. Пишем только в действительно пустой слот.
    let document = { version: 1, tasks: [] };
    try {
      document = parseDocument(await readFile(this.documentPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (document.tasks.length !== 0) throw new Error('slot_busy_on_write');

    const record = {
      id: task.id,
      project: task.project,
      service: task.service,
      title: task.title,
      status: 'готово к работе',
      result: '',
      changedFiles: [],
      completedAt: null,
    };
    if (task.description) record.description = task.description;
    // Контекст из предыдущих ролей (проект ARCHITECT, разбивка DECOMPOSER,
    // последнее ревью) — чтобы Claude реализовывал по проекту, а не с нуля.
    if (Array.isArray(task.priorRoleOutputs) && task.priorRoleOutputs.length) {
      record.context = { priorRoleOutputs: task.priorRoleOutputs };
      if (task.lastReview) record.context.lastReview = task.lastReview;
    }
    await writeFileAtomic(this.documentPath, `${JSON.stringify({ version: 1, tasks: [record] }, null, 2)}\n`);
  }
}
