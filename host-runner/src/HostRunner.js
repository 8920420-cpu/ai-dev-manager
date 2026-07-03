// Оркестрация host-ролей: забрать задачу у оркестратора, выполнить действие на
// хосте, сдать результат. Без БД и без сети напрямую — http и executors
// инъектируются, поэтому логику можно покрыть тестами с подделками.

export class HostRunner {
  /**
   * @param {Object} deps
   * @param {{claim:Function, complete:Function, release:Function}} deps.http
   * @param {Record<string, (task:Object)=>Promise<{success:boolean, output:Object}>>} deps.executors
   * @param {string[]} [deps.roles]
   * @param {Console} [deps.log]
   */
  constructor({ http, executors, roles = ['PIPELINE_SERVICE', 'GIT_INTEGRATOR'], log = console } = {}) {
    if (!http) throw new Error('HostRunner: http required');
    if (!executors) throw new Error('HostRunner: executors required');
    this.http = http;
    this.executors = executors;
    this.roles = roles;
    this.log = log;
    // Пер-ролевой guard реэнтерабельности: role -> Promise выполняемого действия.
    // Роли развязаны — busy одной роли не блокирует опрос другой.
    this.inFlight = new Map();
  }

  // Один проход по всем host-ролям. Роли опрашиваются независимо: pollRole для
  // каждой свободной роли запускается fire-and-forget, а tick сразу возвращает
  // статусы и НЕ ждёт долгих действий (docker build/up, git). Так длинный
  // PIPELINE_SERVICE не мешает GIT_INTEGRATOR забирать задачи между тиками.
  // Повторный опрос той же роли пропускается, пока её действие в полёте —
  // реэнтерабельность сохраняется на уровне роли (одна роль = одно действие).
  tick() {
    const out = [];
    for (const role of this.roles) {
      if (this.inFlight.has(role)) {
        out.push({ role, skipped: 'busy' });
        continue;
      }
      // pollRole обрабатывает claim/throw/вердикт внутри и не бросает, но на
      // всякий случай ловим, чтобы отказ роли не оставил guard навсегда занятым.
      const promise = this.pollRole(role)
        .catch((error) => ({ role, error: error?.message ?? String(error) }))
        .finally(() => this.inFlight.delete(role));
      this.inFlight.set(role, promise);
      out.push({ role, started: true, promise });
    }
    return out;
  }

  async pollRole(role) {
    const exec = this.executors[role];
    if (!exec) return { role, skipped: 'no_executor' };

    let claimed;
    try {
      claimed = await this.http.claim(role);
    } catch (error) {
      this.log.error?.('host claim failed', { role, error: error.message });
      return { role, error: error.message };
    }
    const task = claimed?.task;
    if (!task) return { role, idle: true };

    let result;
    try {
      result = await exec(task);
    } catch (error) {
      // Действие упало по-настоящему (не вердикт «провал», а сбой исполнителя):
      // вернуть задачу в пул, чтобы её не заклинило с назначенным агентом.
      this.log.error?.('host action threw', { role, taskId: task.id, error: error.message });
      await this.http.release(task.id).catch((e) => this.log.error?.('host release failed', { error: e.message }));
      return { role, taskId: task.id, error: error.message };
    }

    await this.http.complete({ taskId: task.id, role, success: result.success, output: result.output ?? {} });
    this.log.info?.('host task completed', { role, taskId: task.id, success: result.success });
    return { role, taskId: task.id, success: result.success };
  }
}
