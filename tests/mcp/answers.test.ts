import { describe, expect, it } from 'vitest';
import { closeNames, fitAnswer } from '../../server/mcp/answers.ts';

describe('fitAnswer', () => {
  it('keeps a short answer whole', () => {
    expect(fitAnswer('short', 'narrow it', 100)).toBe('short');
  });

  it('cuts a long answer to the budget and says how to narrow it', () => {
    const answer = fitAnswer('x'.repeat(500), 'Pass `type`.', 200);
    expect(answer.length).toBeLessThanOrEqual(200);
    expect(answer).toContain('[Cut at 200 of 500 characters. Pass `type`.]');
  });
});

describe('closeNames', () => {
  it('finds names that contain the text, then near spellings', () => {
    expect(closeNames('order', ['Order', 'OrderStatus', 'Customer'])).toEqual(['Order', 'OrderStatus']);
    expect(closeNames('Custmer', ['Order', 'Customer'])).toEqual(['Customer']);
    expect(closeNames('zzz', ['Order'])).toEqual([]);
  });
});
