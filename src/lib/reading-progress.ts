export type ReadingProgress = {
  activeIndex: number;
  sectionProgress: number;
  totalProgress: number;
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** Offsets are measured from the rendered article, so image/font reflow is respected. */
export const getReadingProgress = (
  starts: readonly number[],
  end: number,
  cursor: number,
  atPageBottom = false
): ReadingProgress => {
  if (starts.length === 0) return { activeIndex: -1, sectionProgress: 0, totalProgress: 0 };
  const first = starts[0]!;
  const last = starts[starts.length - 1]!;
  const bottom = Math.max(end, last + 1);
  if (atPageBottom || cursor >= bottom) {
    return { activeIndex: starts.length - 1, sectionProgress: 1, totalProgress: 1 };
  }
  let activeIndex = 0;
  for (let index = 1; index < starts.length; index++) {
    if (starts[index]! > cursor) break;
    activeIndex = index;
  }
  const start = starts[activeIndex]!;
  const next = starts[activeIndex + 1] ?? bottom;
  return {
    activeIndex,
    sectionProgress: clamp((cursor - start) / Math.max(1, next - start)),
    totalProgress: clamp((cursor - first) / Math.max(1, bottom - first))
  };
};
