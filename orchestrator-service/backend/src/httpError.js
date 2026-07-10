// Общая фабрика HTTP-ошибок для REST-модулей бэкенда. Раньше эта функция была
// продублирована ~15 раз по модулям (по 5 строк каждая) — сведена сюда.
//
// Контракт с обработчиком в server.js (единый catch отдаёт ответ по ошибке):
//   error.statusCode → HTTP-код ответа (иначе 500);
//   error.code       → body.code (машинный код; добавляется в ответ ТОЛЬКО если задан);
//   error.errors[]   → body.errors (привязанные к полям ошибки валидации);
//   error.message    → body.error.
// extra домешивается в объект ошибки через Object.assign (может задать code/errors/…).

// Базовый вариант: code в ответ НЕ добавляется, пока его явно не передали в extra.
export function httpError(statusCode, message, extra) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (extra) Object.assign(error, extra);
  return error;
}

// Вариант, где машинный code по умолчанию совпадает с сообщением (extra может
// переопределить). Так исторически сложилось у части модулей (roles, fields,
// mcpRoles, roleGroups, databaseConnections, auditRuns) — их ответы содержат code.
export function httpCodedError(statusCode, message, extra) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = message;
  if (extra) Object.assign(error, extra);
  return error;
}
