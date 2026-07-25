export const DEFAULT_ROW_HEIGHT = 28;
export const DEFAULT_COLUMN_WIDTH = 160;
export const MIN_ROW_HEIGHT = 20;
export const MAX_ROW_HEIGHT = 200;
export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 600;

export interface AxisMetrics {
  count: number;
  defaultSize: number;
  sizeAt: (index: number) => number;
  offsetAt: (index: number) => number;
  indexAt: (offset: number) => number;
  rangeSize: (start: number, endExclusive: number) => number;
  totalSize: number;
}

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function clampGridSize(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function withSizeOverride(
  overrides: Record<number, number>,
  index: number,
  size: number,
  defaultSize: number,
): Record<number, number> {
  const next = { ...overrides };
  if (size === defaultSize) delete next[index];
  else next[index] = size;
  return next;
}

export function createAxisMetrics(
  count: number,
  defaultSize: number,
  overrides: Record<number, number>,
): AxisMetrics {
  const safeCount = Math.max(0, Math.floor(count));
  const entries = Object.entries(overrides)
    .map(([index, size]) => [Number(index), size] as const)
    .filter(([index, size]) => Number.isInteger(index)
      && index >= 0
      && index < safeCount
      && Number.isFinite(size)
      && size > 0)
    .sort(([left], [right]) => left - right);
  const indices = entries.map(([index]) => index);
  const sizes = new Map(entries);
  const prefixDeltas: number[] = [];
  let accumulatedDelta = 0;
  for (const [, size] of entries) {
    accumulatedDelta += size - defaultSize;
    prefixDeltas.push(accumulatedDelta);
  }

  const sizeAt = (index: number) => sizes.get(index) ?? defaultSize;
  const offsetAt = (index: number) => {
    const safeIndex = Math.min(safeCount, Math.max(0, Math.floor(index)));
    const overrideCount = lowerBound(indices, safeIndex);
    const delta = overrideCount > 0 ? prefixDeltas[overrideCount - 1] : 0;
    return safeIndex * defaultSize + delta;
  };
  const indexAt = (offset: number) => {
    if (safeCount <= 1) return 0;
    const safeOffset = Math.max(0, offset);
    if (safeOffset >= offsetAt(safeCount)) return safeCount - 1;
    let low = 0;
    let high = safeCount - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (offsetAt(middle + 1) <= safeOffset) low = middle + 1;
      else high = middle;
    }
    return low;
  };

  return {
    count: safeCount,
    defaultSize,
    sizeAt,
    offsetAt,
    indexAt,
    rangeSize: (start, endExclusive) => offsetAt(endExclusive) - offsetAt(start),
    totalSize: offsetAt(safeCount),
  };
}
