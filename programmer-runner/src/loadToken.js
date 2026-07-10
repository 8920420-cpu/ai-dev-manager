// Подхват токена подписки Claude Code из файла, который пишет host-runner мост
// (кнопка «Подключить Claude» в настройках оркестратора). Путь общий с
// host-runner/src/claudeToken.js.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function tokenFilePath(env = process.env) {
  if (env.PROGRAMMER_TOKEN_FILE) return env.PROGRAMMER_TOKEN_FILE;
  return path.join(os.homedir(), '.ai-dev-manager', 'claude_oauth_token');
}

/**
 * Если в окружении нет ни ANTHROPIC_API_KEY, ни CLAUDE_CODE_OAUTH_TOKEN —
 * подхватить токен из файла и выставить CLAUDE_CODE_OAUTH_TOKEN.
 * @returns {{loaded:boolean, source:string}}
 */
export function ensureClaudeToken(env = process.env, readFile = readFileSync) {
  if (env.ANTHROPIC_API_KEY) return { loaded: false, source: 'api_key' };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { loaded: false, source: 'env_oauth_token' };
  try {
    const t = String(readFile(tokenFilePath(env), 'utf8')).trim();
    if (t) {
      env.CLAUDE_CODE_OAUTH_TOKEN = t;
      return { loaded: true, source: 'token_file' };
    }
  } catch {
    /* файла нет — рассчитываем на залогиненную подписку */
  }
  return { loaded: false, source: 'none' };
}
