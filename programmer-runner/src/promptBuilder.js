// Сборка промпта для headless-агента из payload захваченной задачи. Контекст —
// то же, что видит живая Claude-сессия: тело задачи с acceptance, выжимки
// предыдущих ролей (Architect/Decomposer), требуемые поля роли. В финале просим
// строгий JSON, чтобы исход был машинно-читаемым (хотя список файлов драйвер
// всё равно перепроверяет через git — самоотчёту агента не доверяем).

function summarizePriorRuns(priorRoleOutputs = []) {
  if (!Array.isArray(priorRoleOutputs) || priorRoleOutputs.length === 0) return '';
  // Берём по одному последнему выводу на роль (оркестратор может прислать историю
  // с повторами после RESTART) — последний обычно самый полный.
  const byRole = new Map();
  for (const o of priorRoleOutputs) {
    if (o && o.role) byRole.set(o.role, o);
  }
  const lines = [];
  for (const o of byRole.values()) {
    lines.push(`### Роль ${o.role} (${o.status || '—'})`);
    if (o.summary) lines.push(o.summary);
    if (Array.isArray(o.findings) && o.findings.length) {
      for (const f of o.findings.slice(0, 8)) lines.push(`- ${f}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

/**
 * @param {Object} task  захваченная claude-задача
 * @returns {string} промпт для query()
 */
export function buildPrompt(task) {
  const prior = summarizePriorRuns(task.priorRoleOutputs);
  const caps = Array.isArray(task.capabilities) ? task.capabilities.join(', ') : '';
  const fields = Array.isArray(task.requiredFields) && task.requiredFields.length
    ? task.requiredFields.map((f) => (typeof f === 'string' ? f : f?.name)).filter(Boolean).join(', ')
    : '';

  const sections = [
    'Ты — исполнитель роли PROGRAMMER в конвейере разработки (стадия CODING).',
    'Тебе выдана задача. Реально внеси изменения в код рабочего дерева текущего',
    'проекта (cwd), используя инструменты (Read/Edit/Write/Bash/Glob/Grep).',
    'Не оставляй задачу недоделанной и не выдумывай результат — downstream-ревью',
    'и тесты проверят твою работу.',
    '',
    `Проект: ${task.project || '—'}    Сервис: ${task.service || '—'}`,
    `Задача: ${task.title || '—'}`,
    caps ? `Разрешения: ${caps}` : '',
    fields ? `Требуемые поля роли (заполни в summary): ${fields}` : '',
    '',
    '## Описание задачи',
    String(task.description || '').trim(),
  ];

  if (prior) {
    sections.push('', '## Контекст предыдущих ролей', prior);
  }

  sections.push(
    '',
    '## Правила выполнения',
    '- Если проект на Go и используешь `go` — учитывай, что окружение может требовать GOWORK=off.',
    '- Сначала разберись в коде, затем вноси минимальные корректные изменения и тесты.',
    '- Не коммить — коммит сделает отдельная стадия конвейера.',
    '',
    '## Формат финального ответа (обязательно)',
    'Последним сообщением выведи ОДИН JSON-объект и больше ничего после него:',
    '{"success": true|false, "summary": "что сделано", "files_changed": ["путь1", "путь2"]}',
    'success=false — если выполнить задачу не удалось (с пояснением в summary).',
  );

  return sections.filter((s) => s !== undefined && s !== null).join('\n');
}

// Достать финальный JSON-блок из текста результата агента. Возвращает объект или null.
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
