import type { Measurement } from './types';

// services/analysis/analysis1.py の prototype-0.3 と同じ判定前の値。
export const STANDARD_GRAVITY = 9.80665;
export const DEFAULT_IMPACT_THRESHOLD = 3;
export type VibrationPoint = { at: number; value: number };

export function vibration(acceleration: Measurement['acceleration']): number | null {
  const { x, y, z, includesGravity } = acceleration;
  if (![x, y, z].every(Number.isFinite)) return null;
  const magnitude = Math.sqrt(x * x + y * y + z * z);
  const value = includesGravity ? Math.abs(magnitude - STANDARD_GRAVITY) : magnitude;
  return Number.isFinite(value) ? value : null;
}

export function analyzeVibration(measurements: Measurement[]) {
  const values: number[] = [];
  const points: VibrationPoint[] = [];
  for (const item of measurements) {
    const value = vibration(item.acceleration);
    if (value === null) continue;
    values.push(value);
    const at = Date.parse(item.measuredAt);
    if (Number.isFinite(at)) points.push({ at, value });
  }
  values.sort((a, b) => a - b);
  points.sort((a, b) => a.at - b.at);
  const n = values.length;
  return {
    values, points, count: n, invalid: measurements.length - n,
    median: n ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2 : null,
    p95: n ? values[Math.ceil(n * .95) - 1] : null,
    max: n ? values[n - 1] : null,
  };
}

export function thresholdCount(sortedValues: number[], threshold: number): number {
  let low = 0, high = sortedValues.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (sortedValues[mid] < threshold) low = mid + 1;
    else high = mid;
  }
  return sortedValues.length - low;
}

// 表示を最大約400点に集約。各区間の最小・最大を残し、短いピークを落とさない。
export function chartEnvelope(points: VibrationPoint[], buckets = 200): VibrationPoint[] {
  if (points.length <= buckets * 2) return points;
  const result: VibrationPoint[] = [];
  for (let start = 0; start < points.length;) {
    const end = Math.min(points.length, start + Math.ceil(points.length / buckets));
    let min = start, max = start;
    for (let i = start + 1; i < end; i++) {
      if (points[i].value < points[min].value) min = i;
      if (points[i].value > points[max].value) max = i;
    }
    for (const index of [...new Set([min, max])].sort((a, b) => a - b)) result.push(points[index]);
    start = end;
  }
  return result;
}
