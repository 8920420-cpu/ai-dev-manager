// Build the headless agent prompt from the claimed task payload. The driver still
// verifies changed files through git, so the agent's self-report is not trusted.

function summarizePriorRuns(priorRoleOutputs = []) {
  if (!Array.isArray(priorRoleOutputs) || priorRoleOutputs.length === 0) return '';
  // Keep the latest output per role; retries may send repeated role history.
  const byRole = new Map();
  for (const o of priorRoleOutputs) {
    if (o && o.role) byRole.set(o.role, o);
  }
  const lines = [];
  for (const o of byRole.values()) {
    lines.push(`### Role ${o.role} (${o.status || '-'})`);
    if (o.summary) lines.push(o.summary);
    if (Array.isArray(o.findings) && o.findings.length) {
      for (const f of o.findings.slice(0, 8)) lines.push(`- ${f}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

/**
 * @param {Object} task claimed Claude task
 * @returns {string} prompt for query()
 */
export function buildPrompt(task) {
  const prior = summarizePriorRuns(task.priorRoleOutputs);
  const caps = Array.isArray(task.capabilities) ? task.capabilities.join(', ') : '';
  const fields = Array.isArray(task.requiredFields) && task.requiredFields.length
    ? task.requiredFields.map((f) => (typeof f === 'string' ? f : f?.name)).filter(Boolean).join(', ')
    : '';

  const sections = [
    'You are the PROGRAMMER role in the development pipeline (CODING stage).',
    'You have been assigned one task. Make real, minimal, correct changes in the',
    'current project worktree (cwd) using the available tools.',
    'Do not invent requirements, files, APIs, results, or test outcomes. If a fact',
    'is not available from the task or repository, state that it is unknown.',
    'Do not broaden the scope for optional refactoring or cleanup.',
    '',
    `Project: ${task.project || '-'}    Service: ${task.service || '-'}`,
    `Task: ${task.title || '-'}`,
    caps ? `Capabilities: ${caps}` : '',
    fields ? `Required role fields to cover in the summary: ${fields}` : '',
    '',
    '## Task Description',
    String(task.description || '').trim(),
  ];

  if (prior) {
    sections.push('', '## Previous Role Context', prior);
  }

  sections.push(
    '',
    '## Execution Rules',
    '- Inspect the relevant code before editing.',
    '- Make the smallest change that satisfies the assigned task.',
    '- Add or update relevant tests as code when the task changes behavior.',
    '- If this is a Go project and you use `go`, the environment may require GOWORK=off.',
    '- Do not commit; a later pipeline stage handles git integration.',
    '- Do not claim that tests passed unless you actually ran them and saw the result.',
    '',
    '## Required Final Response',
    'The final message must be exactly one JSON object with nothing after it:',
    '{"success": true|false, "summary": "what changed or why it is blocked", "files_changed": ["path1", "path2"]}',
    'Use success=false when the task could not be completed, and explain the blocker in summary.',
  );

  return sections.filter((s) => s !== undefined && s !== null).join('\n');
}

// Extract the final JSON block from the agent output. Returns an object or null.
export function parseAgentJson(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*\}\s*$/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}
