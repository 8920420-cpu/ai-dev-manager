import { describe, it, expect, vi, beforeEach } from 'vitest';

const post = vi.fn();
vi.mock('./http', () => ({
  http: {
    get: vi.fn(),
    post: (...args: unknown[]) => post(...args),
    put: vi.fn(),
    del: vi.fn(),
  },
}));

import { integrationsApi } from './integrationsApi';

describe('integrationsApi.invoke — канонический контракт { user }', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({
      ok: true,
      response: 'ok',
      exchange: { id: 'e1', status: 'ok', httpStatus: 200, durationMs: 5 },
    });
  });

  it('отправляет поле user и НЕ отправляет legacy-поле prompt', async () => {
    await integrationsApi.invoke('int-1', 'привет');
    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe('/api/integrations/int-1/invoke');
    expect(body).toEqual({ user: 'привет' });
    expect(body).not.toHaveProperty('prompt');
  });

  it('checkConnection использует тот же канонический payload', async () => {
    await integrationsApi.checkConnection('int-2');
    const [, body] = post.mock.calls[0]!;
    expect(body).toEqual({ user: 'ping' });
    expect(body).not.toHaveProperty('prompt');
  });
});
