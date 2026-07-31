export function scannerError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function resultSummaryText(result) {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    if (typeof result.summary === 'string' && result.summary.trim()) return result.summary;
    try {
      return JSON.stringify(result);
    } catch {
      return '';
    }
  }
  return result == null ? '' : String(result);
}

/**
 * \u041F\u0440\u0438\u0437\u043D\u0430\u043A \u00AB\u0442\u0435\u043A\u0441\u0442 \u043F\u0440\u0438\u0435\u0445\u0430\u043B \u0431\u0438\u0442\u044B\u043C\u00BB (\u043F\u043E\u0442\u0435\u0440\u044F \u043A\u043E\u0434\u0438\u0440\u043E\u0432\u043A\u0438): \u0441\u0438\u043C\u0432\u043E\u043B \u0437\u0430\u043C\u0435\u043D\u044B U+FFFD \u043B\u0438\u0431\u043E
 * \u043C\u0430\u0441\u0441\u043E\u0432\u043E\u0435 \u043F\u0440\u0435\u0432\u0440\u0430\u0449\u0435\u043D\u0438\u0435 \u0431\u0443\u043A\u0432 \u0432 \u00AB?\u00BB.
 *
 * INTAKE-QUESTION-MARKS-001. \u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 \u043D\u0430 \u00AB?\u00BB \u2014 \u044D\u0432\u0440\u0438\u0441\u0442\u0438\u043A\u0430, \u0438 \u043E\u043D\u0430 \u043B\u043E\u0432\u0438\u043B\u0430 \u0436\u0438\u0432\u044B\u0435
 * \u043E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u044F: \u0432 \u0440\u0443\u0441\u0441\u043A\u043E\u043C \u0442\u0435\u043A\u0441\u0442\u0435 \u00AB\u041D\u0435 \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442???\u00BB \u0438 \u00AB\u041A\u0430\u043A \u0431\u044B\u0442\u044C?? \u0427\u0442\u043E \u0434\u0435\u043B\u0430\u0442\u044C??\u00BB \u2014
 * \u043E\u0431\u044B\u0447\u043D\u0430\u044F \u044D\u043C\u043E\u0446\u0438\u043E\u043D\u0430\u043B\u044C\u043D\u0430\u044F \u0437\u0430\u043F\u0438\u0441\u044C, \u0430 \u043D\u0435 \u043F\u043E\u0442\u0435\u0440\u044F\u043D\u043D\u0430\u044F \u043A\u043E\u0434\u0438\u0440\u043E\u0432\u043A\u0430. \u041F\u043E \u043D\u0435\u0439 \u043F\u0440\u0438\u0451\u043C \u043E\u0442\u043A\u043B\u043E\u043D\u044F\u043B
 * \u043E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u0435 \u0441 422 corrupted_encoding, \u0438 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C \u0442\u0435\u0440\u044F\u043B \u0442\u0435\u043A\u0441\u0442 \u0431\u0435\u0437 \u043E\u0431\u044A\u044F\u0441\u043D\u0435\u043D\u0438\u044F
 * (\u0442\u0440\u0438 \u0442\u0430\u043A\u0438\u0445 \u043E\u0442\u043A\u0430\u0437\u0430 \u0432 Mail_Service 4 \u0438\u044E\u043B\u044F 2026).
 *
 * \u041A\u043B\u044E\u0447\u0435\u0432\u043E\u0439 \u043F\u0440\u0438\u0437\u043D\u0430\u043A \u043D\u0430\u0441\u0442\u043E\u044F\u0449\u0435\u0439 \u043F\u043E\u0442\u0435\u0440\u0438 \u043A\u043E\u0434\u0438\u0440\u043E\u0432\u043A\u0438 \u2014 \u0431\u0443\u043A\u0432\u044B \u0418\u0421\u0427\u0415\u0417\u041B\u0418: \u00AB????? ?? ????????\u00BB
 * \u0432\u043C\u0435\u0441\u0442\u043E \u00AB\u041D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442\u00BB. \u041F\u043E\u044D\u0442\u043E\u043C\u0443 \u0442\u0435\u043A\u0441\u0442, \u0432 \u043A\u043E\u0442\u043E\u0440\u043E\u043C \u0431\u0443\u043A\u0432 \u0437\u0430\u043C\u0435\u0442\u043D\u043E \u0431\u043E\u043B\u044C\u0448\u0435, \u0447\u0435\u043C
 * \u0437\u043D\u0430\u043A\u043E\u0432 \u0432\u043E\u043F\u0440\u043E\u0441\u0430, \u0431\u0438\u0442\u044B\u043C \u0431\u043E\u043B\u044C\u0448\u0435 \u043D\u0435 \u0441\u0447\u0438\u0442\u0430\u0435\u0442\u0441\u044F \u2014 \u00AB?\u00BB \u0442\u0430\u043C \u043F\u0443\u043D\u043A\u0442\u0443\u0430\u0446\u0438\u044F. U+FFFD
 * \u043E\u0442\u043A\u043B\u043E\u043D\u044F\u0435\u0442\u0441\u044F \u0432\u0441\u0435\u0433\u0434\u0430: \u043E\u043D \u043F\u043E\u044F\u0432\u043B\u044F\u0435\u0442\u0441\u044F \u0442\u043E\u043B\u044C\u043A\u043E \u043F\u0440\u0438 \u043D\u0435\u0443\u0434\u0430\u0447\u043D\u043E\u043C \u0434\u0435\u043A\u043E\u0434\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0438.
 */
export function looksCorruptedText(text) {
  const s = String(text ?? '');
  if (!s) return false;
  if (s.includes('\uFFFD')) return true;
  const q = (s.match(/\?/g) || []).length;
  if (q === 0) return false;
  const letters = (s.match(/\p{L}/gu) || []).length;
  // \u0411\u0443\u043A\u0432 \u0434\u043E\u0441\u0442\u0430\u0442\u043E\u0447\u043D\u043E, \u0447\u0442\u043E\u0431\u044B \u0442\u0435\u043A\u0441\u0442 \u0447\u0438\u0442\u0430\u043B\u0441\u044F \u2192 \u00AB?\u00BB \u044D\u0442\u043E \u043F\u0443\u043D\u043A\u0442\u0443\u0430\u0446\u0438\u044F. \u041F\u043E\u0440\u043E\u0433 \u0441\u0432\u044F\u0437\u0430\u043D \u0441
  // \u0447\u0438\u0441\u043B\u043E\u043C \u00AB?\u00BB: \u043E\u0434\u0438\u043D\u043E\u0447\u043D\u044B\u0439 \u0432\u043E\u043F\u0440\u043E\u0441 \u0434\u043E\u043F\u0443\u0441\u0442\u0438\u043C \u0438 \u0432 \u043A\u043E\u0440\u043E\u0442\u043A\u043E\u0439 \u0444\u0440\u0430\u0437\u0435, \u0430 \u0432\u043E\u0442 \u0434\u0435\u0441\u044F\u0442\u043E\u043A
  // \u0432\u043E\u043F\u0440\u043E\u0441\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0445 \u0437\u043D\u0430\u043A\u043E\u0432 \u043F\u0440\u0438 \u0442\u0440\u0451\u0445 \u0431\u0443\u043A\u0432\u0430\u0445 \u2014 \u0443\u0436\u0435 \u043F\u043E\u0434\u043E\u0437\u0440\u0438\u0442\u0435\u043B\u044C\u043D\u043E.
  if (letters >= 8 && letters >= q * 2) return false;
  if (/\?{3,}/.test(s)) return true;
  const nonSpace = s.replace(/\s/g, '').length;
  return q >= 3 && nonSpace > 0 && q / nonSpace >= 0.25;
}

export function normalizeScannerCompletion(input) {
  const required = (key) => {
    const value = String(input?.[key] ?? '').trim();
    if (!value) throw scannerError(422, `${key}_required`);
    return value;
  };
  const taskId = required('taskId');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) {
    throw scannerError(422, 'taskId_must_be_uuid');
  }
  return {
    taskId,
    completionKey: required('completionKey'),
    project: required('project'),
    service: required('service'),
    title: required('title'),
    status: 'completed',
    result: resultSummaryText(input?.result),
    changedFiles: Array.isArray(input?.changedFiles) ? input.changedFiles.map(String) : [],
    worktreeBranch: typeof input?.worktreeBranch === 'string' && input.worktreeBranch.trim()
      ? input.worktreeBranch.trim().slice(0, 255) : null,
    deliveredCommit: typeof input?.deliveredCommit === 'string' && input.deliveredCommit.trim()
      ? input.deliveredCommit.trim().slice(0, 80) : null,
    tokensIn: input?.tokensIn ?? null,
    tokensOut: input?.tokensOut ?? null,
    tokensCacheRead: input?.tokensCacheRead ?? null,
    tokensCacheCreation: input?.tokensCacheCreation ?? null,
    costUsd: input?.costUsd ?? null,
    coldStartMs: input?.coldStartMs ?? null,
    numTurns: Number.isFinite(Number(input?.numTurns)) ? Math.trunc(Number(input.numTurns)) : null,
    codeVersion: typeof input?.codeVersion === 'string' && input.codeVersion.trim()
      ? input.codeVersion.trim().slice(0, 80) : null,
    model: typeof input?.model === 'string' && input.model.trim()
      ? input.model.trim().slice(0, 120) : null,
    completedAt: input?.completedAt ?? null,
    sourceDocument: required('sourceDocument'),
    nextRole: 'TASK_REVIEWER',
    fields: input?.fields && typeof input.fields === 'object' && !Array.isArray(input.fields)
      ? input.fields : null,
  };
}
