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

import { feedbackApi } from './feedbackApi';
import type { FeedbackPayload } from '../types/feedback';

describe('feedbackApi', () => {
  beforeEach(() => post.mockReset());

  it('send → POST /api/feedback с телом обращения; возвращает reportNumber', async () => {
    post.mockResolvedValue({ accepted: true, reportNumber: 7, taskId: 't1' });
    const payload: FeedbackPayload = {
      externalId: 'ext-1',
      message: 'привет',
      user: 'tester',
      category: 'bug',
      service: 'orchestrator-ui',
      form: 'tasks',
      autocontext: {
        url: null,
        buildVersion: null,
        userAgent: null,
        timestamp: null,
        jsErrors: [],
        lastFailedApiRequestId: null,
      },
    };
    const res = await feedbackApi.send(payload);
    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe('/api/feedback');
    expect(body).toBe(payload);
    expect(res.reportNumber).toBe(7);
  });

  it('uploadScreenshot → POST /api/feedback/screenshot с data URL; возвращает url', async () => {
    post.mockResolvedValue({ id: 's1', url: '/api/feedback/screenshot/s1' });
    const res = await feedbackApi.uploadScreenshot('data:image/jpeg;base64,AAAA');
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe('/api/feedback/screenshot');
    expect(body).toEqual({ image: 'data:image/jpeg;base64,AAAA' });
    expect(res.url).toBe('/api/feedback/screenshot/s1');
  });
});
