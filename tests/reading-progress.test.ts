import { describe, expect, it } from 'vitest';
import { getReadingProgress } from '../src/lib/reading-progress';

describe('article reading progress', () => {
  it('counts the introduction as a section before the first Markdown heading', () => {
    expect(getReadingProgress([100, 300, 700], 1100, 200)).toEqual({
      activeIndex: 0,
      sectionProgress: 0.5,
      totalProgress: 0.1
    });
  });

  it('reports progress within the active heading interval and advances at its boundary', () => {
    const halfway = getReadingProgress([100, 300, 700], 1100, 500);
    expect(halfway.activeIndex).toBe(1);
    expect(halfway.sectionProgress).toBe(0.5);
    expect(halfway.totalProgress).toBe(0.4);

    expect(getReadingProgress([100, 300, 700], 1100, 700)).toEqual({
      activeIndex: 2,
      sectionProgress: 0,
      totalProgress: 0.6
    });
  });

  it('leaves the first section unread when the reading cursor is before the article', () => {
    expect(getReadingProgress([200, 400], 800, 0)).toEqual({
      activeIndex: 0,
      sectionProgress: 0,
      totalProgress: 0
    });
  });

  it('skips sections whose headings share the same vertical position', () => {
    expect(getReadingProgress([100, 100, 100, 500], 900, 100)).toEqual({
      activeIndex: 2,
      sectionProgress: 0,
      totalProgress: 0
    });
    expect(getReadingProgress([100, 100, 100, 500], 900, 300)).toEqual({
      activeIndex: 2,
      sectionProgress: 0.5,
      totalProgress: 0.25
    });
  });

  it('marks a short final section complete at the page bottom even when it cannot reach the reading line', () => {
    const starts = [100, 600, 980];
    expect(getReadingProgress(starts, 1000, 850).activeIndex).toBe(1);
    expect(getReadingProgress(starts, 1000, 850, true)).toEqual({
      activeIndex: 2,
      sectionProgress: 1,
      totalProgress: 1
    });
  });

  it('handles a zero-height article without dividing by zero', () => {
    expect(getReadingProgress([100, 100], 100, 100)).toEqual({
      activeIndex: 1,
      sectionProgress: 0,
      totalProgress: 0
    });
    expect(getReadingProgress([100, 100], 100, 101)).toEqual({
      activeIndex: 1,
      sectionProgress: 1,
      totalProgress: 1
    });
  });

  it('keeps the last heading usable when the supplied article end precedes it', () => {
    expect(getReadingProgress([100, 500], 300, 500)).toEqual({
      activeIndex: 1,
      sectionProgress: 0,
      totalProgress: 400 / 401
    });
    expect(getReadingProgress([100, 500], 300, 501)).toEqual({
      activeIndex: 1,
      sectionProgress: 1,
      totalProgress: 1
    });
  });

  it('clamps both progress values after the article ends', () => {
    expect(getReadingProgress([100, 400], 800, 1200)).toEqual({
      activeIndex: 1,
      sectionProgress: 1,
      totalProgress: 1
    });
  });

  it('returns an empty state when the article has no heading sections', () => {
    for (const atPageBottom of [false, true]) {
      expect(getReadingProgress([], 0, 500, atPageBottom)).toEqual({
        activeIndex: -1,
        sectionProgress: 0,
        totalProgress: 0
      });
    }
  });
});
