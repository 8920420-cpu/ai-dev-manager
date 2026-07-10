import { describe, expect, it } from 'vitest';
import { looksLikeUuid, makeUuid } from './ids';

describe('ids', () => {
  it('makeUuid returns UUID-formatted ids', () => {
    expect(makeUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('looksLikeUuid accepts UUIDs and rejects local draft ids', () => {
    expect(looksLikeUuid('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(looksLikeUuid('stage_local')).toBe(false);
    expect(looksLikeUuid(undefined)).toBe(false);
  });
});
