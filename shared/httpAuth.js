export function readTokenAuthConfig(env = process.env) {
  return {
    token: String(env.ORCHESTRATOR_API_TOKEN || '').trim(),
    allowInsecureLocal: env.ALLOW_INSECURE_LOCAL === '1',
  };
}

export function isBearerOrApiTokenAuthorized(req, {
  token,
  allowInsecureLocal = false,
  allowQueryToken = false,
} = {}) {
  if (!token) return allowInsecureLocal === true;

  const auth = String(req.headers?.authorization || '');
  if (auth === `Bearer ${token}`) return true;
  if (req.headers?.['x-api-token'] === token) return true;

  if (allowQueryToken) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.searchParams.get('token') === token) return true;
  }

  return false;
}

export function isPublicHealthPath(path) {
  return path === '/health' || path === '/healthz' || path === '/readiness';
}
