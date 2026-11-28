import { describe, expect, it } from 'vitest';
import { NO_DATA, durationLabel, rateLabel, truncate } from './format';

describe('rateLabel', () => {
  it('turns basis points into a percentage', () => {
    expect(rateLabel(3333)).toBe('33.3%');
    expect(rateLabel(5000)).toBe('50%');
    expect(rateLabel(10000)).toBe('100%');
  });

  it('shows a real zero as 0% but never invents a figure for null', () => {
    expect(rateLabel(0)).toBe('0%');
    expect(rateLabel(null)).toBe(NO_DATA);
    expect(NO_DATA).toBe('No data');
  });
});

describe('durationLabel', () => {
  it('formats seconds as minutes and seconds', () => {
    expect(durationLabel(45)).toBe('45 s');
    expect(durationLabel(600)).toBe('10 min');
    expect(durationLabel(1_805)).toBe('30 min 5 s');
  });

  it('uses hours for long waits', () => {
    expect(durationLabel(7_500)).toBe('2 h 5 min');
    expect(durationLabel(3_600)).toBe('1 h');
  });

  it('says No data for null', () => {
    expect(durationLabel(null)).toBe(NO_DATA);
  });
});

describe('truncate', () => {
  it('leaves short text alone and cuts long text with an ellipsis', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
});
