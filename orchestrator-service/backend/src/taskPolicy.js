import { normalizeTaskRoute } from './rolePipeline.js';

export function isOrchestratorProject(projectRow) {
  if (!projectRow) return false;
  const orchCode = String(process.env.ORCHESTRATOR_PROJECT_CODE || 'PROJECT').trim().toLowerCase();
  const code = String(projectRow.code ?? '').trim().toLowerCase();
  if (code && code === orchCode) return true;
  const rootPath = String(projectRow.root_path ?? projectRow.rootPath ?? '');
  return /ai-dev-manager/i.test(rootPath);
}

export function normalizeClientPriority(requested, def = 2) {
  if (requested === null || requested === undefined || requested === '') return def;
  const n = Math.trunc(Number(requested));
  if (!Number.isFinite(n)) return def;
  if (n <= 0) return 1;
  if (n >= 3) return 3;
  return n;
}

export function computeTaskPriority(projectRow, requested, def = 2) {
  if (isOrchestratorProject(projectRow)) return 0;
  return normalizeClientPriority(requested, def);
}

export const TASK_SIZES = ['small', 'medium', 'large'];

export function normalizeTaskSize(value, dflt = 'medium') {
  const s = String(value ?? '').trim().toLowerCase();
  return TASK_SIZES.includes(s) ? s : dflt;
}

function parseCard(dataCard) {
  if (typeof dataCard !== 'string') return dataCard;
  try {
    return JSON.parse(dataCard);
  } catch {
    return null;
  }
}

export function taskSizeFromCard(dataCard) {
  const card = parseCard(dataCard);
  return normalizeTaskSize(card && typeof card === 'object' ? card.task_size : null);
}

export function taskRouteFromCard(dataCard) {
  const card = parseCard(dataCard);
  return normalizeTaskRoute(card && typeof card === 'object' ? card.route : null);
}

export function renderWorkArtifactSections(fields = {}) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const asList = (v) => (Array.isArray(v) ? v : (typeof v === 'string' && v.trim() ? [v] : []))
    .map((x) => String(x).trim()).filter(Boolean);
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const parts = [];
  const ac = asList(f.acceptance_criteria);
  if (ac.length) parts.push(`## Критерии приёмки\n${ac.map((x) => `- ${x}`).join('\n')}`);
  const scope = str(f.scope_limits);
  if (scope) parts.push(`## Границы (не трогать)\n${scope}`);
  const tp = str(f.test_plan) || str(f.test_hints);
  if (tp) parts.push(`## План проверки\n${tp}`);
  const risk = str(f.risk_notes);
  if (risk) parts.push(`## Риски\n${risk}`);
  return parts.join('\n\n');
}

export const REVIEWER_SKIP_MAX_FILES = 5;

const REVIEWER_SKIP_DANGEROUS_RE = [
  /(^|\/)migrations?(\/|$)/i,
  /(^|\/)db(\/|$)/i,
  /\.sql$/i,
  /\.proto$/i,
  /(^|\/)(openapi|swagger)([./_-]|$)/i,
  /(^|\/)package(-lock)?\.json$/i,
  /(^|\/)pnpm-lock\.ya?ml$/i,
  /(^|\/)(docker-compose[^/]*\.ya?ml|Dockerfile[^/]*)$/i,
  /(^|\/)(deploy|k8s|kubernetes|helm|charts?)(\/|$)/i,
  /(^|\/)(auth|security|permissions?|rbac|iam)(\/|$)/i,
];

function changedFilePath(entry) {
  const raw = typeof entry === 'string' ? entry : (entry && typeof entry === 'object' ? entry.path : '');
  return String(raw ?? '').replace(/\\/g, '/').trim();
}

export function reviewerSkipHasDangerousFile(changedFiles = []) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  return files.some((f) => {
    const p = changedFilePath(f);
    return p && REVIEWER_SKIP_DANGEROUS_RE.some((re) => re.test(p));
  });
}

export function shouldSkipReviewerForSmallTask(task, payload = {}) {
  if (taskSizeFromCard(task?.data_card) !== 'small') return false;
  if (task?.task_kind === 'epic') return false;
  const p = payload && typeof payload === 'object' ? payload : {};
  if (p.blockedByService || p.crossService) return false;
  const files = Array.isArray(p.changedFiles) ? p.changedFiles : [];
  if (files.length > REVIEWER_SKIP_MAX_FILES) return false;
  if (reviewerSkipHasDangerousFile(files)) return false;
  return true;
}
