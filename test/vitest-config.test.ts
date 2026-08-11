import { describe, expect, it } from 'vitest';
import { vitestFileFiltersAfterDoubleDash } from '../vitest.config.js';

describe('vitest config file filters after --', () => {
  it('treats a post-double-dash unit test path as a unit-only include', () => {
    const filters = vitestFileFiltersAfterDoubleDash([
      '/usr/bin/node',
      '/repo/node_modules/.bin/vitest',
      'run',
      '--',
      'test/raw-input-followup-atomicity.test.ts',
    ]);

    expect(filters).toEqual({
      unit: ['test/raw-input-followup-atomicity.test.ts'],
      e2e: [],
    });
  });

  it('treats a post-double-dash e2e test path as an e2e-only include', () => {
    const filters = vitestFileFiltersAfterDoubleDash([
      '/usr/bin/node',
      '/repo/node_modules/.bin/vitest',
      'run',
      '--',
      'test/opencode-input.e2e.ts',
    ]);

    expect(filters).toEqual({
      unit: [],
      e2e: ['test/opencode-input.e2e.ts'],
    });
  });
});
