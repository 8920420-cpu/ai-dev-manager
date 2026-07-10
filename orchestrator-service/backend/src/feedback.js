// FEEDBACK-WIDGET-001 — backend приёма виджета «Обратная связь» UI оркестратора.
//
// Виджет (заморожённый контракт src/types/feedback.ts) шлёт same-origin:
//   POST /api/feedback             — обращение (FeedbackPayload);
//   POST /api/feedback/screenshot  — скриншот data-URL'ом → { id, url };
//   GET  /api/feedback/screenshot/:id — отдача сохранённого скриншота.
//
// Приём переиспользует acceptIntakeReport (INTAKE-INTEGRATIONS-001): задача сразу в
// BACKLOG под Приёмщиком, data_card.source='intake-integration', идемпотентность по
// externalId, анти-спам. Токен предзарегистрированной интеграции «orchestrator-ui»
// подставляет СЕРВЕР (в бандл фронтенда секрет не попадает); интеграция создаётся
// лениво при первом обращении (enabled=true) и её token_hash синхронизируется.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptIntakeReport } from './db.js';
import { ensureIntegrationWithToken, generateToken } from './intakeIntegrations.js';
import { asObject } from './dataCard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Имя предзарегистрированной интеграции канала UI-виджета (совпадает с
// FeedbackPayload.service — так acceptIntakeReport авторизует приём).
export const UI_INTEGRATION_NAME = 'orchestrator-ui';

function feedbackError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

// --- Токен интеграции UI (server-side секрет; в бандл не попадает) ------------
let cachedToken = null;
export function resolveUiIntakeToken() {
  if (cachedToken) return cachedToken;
  const fromEnv = String(process.env.ORCHESTRATOR_UI_INTAKE_TOKEN ?? '').trim();
  // Fallback для локального запуска без заданного секрета: пер-процессный токен.
  // Его хэш синхронизируется в intake_integrations при каждом приёме (ensure),
  // поэтому авторизация работает и без внешней конфигурации.
  cachedToken = fromEnv || generateToken();
  return cachedToken;
}
// Тестовый помощник: сбросить кэш токена (env считывается заново).
export function __resetTokenCacheForTest() {
  cachedToken = null;
}

// --- Приём обращения ---------------------------------------------------------
// Собираем вход acceptIntakeReport из FeedbackPayload. service жёстко фиксируем на
// канал UI-виджета (контракт), не доверяя вводу; токен подставляет сервер.
function buildIntakeInput(payload, token) {
  const p = asObject(payload);
  return {
    token,
    externalId: p.externalId,
    message: p.message,
    user: p.user,
    service: UI_INTEGRATION_NAME,
    form: p.form,
    category: p.category,
    autocontext: p.autocontext,
    screenshotUrl: p.screenshotUrl ?? null,
  };
}

// Ответ acceptIntakeReport → FeedbackResult (контракт фронтенда).
function toFeedbackResult(result, externalId) {
  const r = asObject(result);
  return {
    accepted: Boolean(r.accepted),
    duplicate: Boolean(r.duplicate),
    reportNumber: typeof r.reportNumber === 'number' ? r.reportNumber : null,
    taskId: r.taskId ?? null,
    externalId: r.externalId ?? externalId ?? null,
  };
}

// deps — точка подмены для тестов (без живого Postgres): ensureIntegration,
// acceptIntakeReport, token.
export async function acceptFeedback(s, payload, deps = {}) {
  const token = deps.token ?? resolveUiIntakeToken();
  const ensure = deps.ensureIntegration ?? ((t) => ensureIntegrationWithToken(UI_INTEGRATION_NAME, t));
  const accept = deps.acceptIntakeReport ?? acceptIntakeReport;
  // Ленивое автопровижининг интеграции + синхронизация секрета перед приёмом.
  await ensure(token);
  const result = await accept(s, buildIntakeInput(payload, token));
  return toFeedbackResult(result, payload?.externalId);
}

// --- Хранилище скриншотов обращений -----------------------------------------
export const SCREENSHOT_DIR =
  process.env.FEEDBACK_SCREENSHOT_DIR || resolve(__dirname, '../data/feedback-screenshots');

// Потолок РАЗМЕРА ДЕКОДИРОВАННОГО скриншота (после base64). Тело запроса ограничено
// отдельно в server.js (readBody maxBytes) — оно больше из-за оверхеда base64.
export const MAX_SCREENSHOT_BYTES = Number(process.env.FEEDBACK_SCREENSHOT_MAX_BYTES) || 5 * 1024 * 1024;

// Разрешаем только растровые форматы (SVG исключён — может нести скрипты).
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

// Разбор data-URL скриншота: валидация MIME, декодирование base64, лимит размера.
export function parseScreenshotDataUrl(image, { maxBytes = MAX_SCREENSHOT_BYTES } = {}) {
  const s = String(image ?? '').trim();
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(s);
  if (!m) throw feedbackError(422, 'screenshot_invalid');
  const ext = MIME_EXT[m[1].toLowerCase()];
  if (!ext) throw feedbackError(415, 'screenshot_unsupported_type');
  const buffer = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw feedbackError(422, 'screenshot_empty');
  if (buffer.length > maxBytes) throw feedbackError(413, 'screenshot_too_large');
  return { ext, buffer };
}

// Сохранить скриншот на диск. id — случайный hex; url доступен GET-ом ниже.
export async function saveScreenshot(image, { dir = SCREENSHOT_DIR, maxBytes } = {}) {
  const { ext, buffer } = parseScreenshotDataUrl(image, { maxBytes });
  const id = randomBytes(16).toString('hex');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.${ext}`), buffer);
  return { id, url: `/api/feedback/screenshot/${id}.${ext}` };
}

// Отдать сохранённый скриншот. idParam — «<hex>» или «<hex>.<ext>» (строгий формат:
// hex-id защищает от path traversal). Нет файла → 404 not_found.
export async function readScreenshot(idParam, { dir = SCREENSHOT_DIR } = {}) {
  const m = /^([0-9a-f]{8,64})(?:\.([a-z0-9]+))?$/i.exec(String(idParam ?? ''));
  if (!m) throw feedbackError(404, 'not_found');
  const id = m[1].toLowerCase();
  let ext = (m[2] || '').toLowerCase();
  let file = null;
  if (ext && existsSync(join(dir, `${id}.${ext}`))) {
    file = join(dir, `${id}.${ext}`);
  } else if (existsSync(dir)) {
    const found = (await readdir(dir)).find((e) => e.startsWith(`${id}.`));
    if (found) {
      file = join(dir, found);
      ext = extname(found).slice(1).toLowerCase();
    }
  }
  if (!file) throw feedbackError(404, 'not_found');
  return { buffer: await readFile(file), mime: EXT_MIME[ext] || 'application/octet-stream' };
}
