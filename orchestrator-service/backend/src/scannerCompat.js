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

export function looksCorruptedText(text) {
  const s = String(text ?? '');
  if (!s) return false;
  if (s.includes('\uFFFD')) return true;
  if (/\?{3,}/.test(s)) return true;
  const q = (s.match(/\?/g) || []).length;
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
