import { expect, it } from 'vitest';
import { analyzeVibration, chartEnvelope, STANDARD_GRAVITY, thresholdCount, vibration } from './vibration';
import type { Measurement } from './types';

const measurement = (value: number, time = 0): Measurement => ({
  schemaVersion: '0.1.0', measurementId: String(time), deviceId: 'device', deliveryId: 'session',
  measuredAt: new Date(time).toISOString(), acceleration: { x: value, y: 0, z: 0, includesGravity: false }, tiltDegrees: null, position: null,
});

it('担当Cと同じ重力込み・重力なしの式で計算し、前後サンプルに依存しない', () => {
  expect(vibration({ x: 0, y: 0, z: STANDARD_GRAVITY, includesGravity: true })).toBe(0);
  expect(vibration({ x: 0, y: 0, z: STANDARD_GRAVITY + 3, includesGravity: true })).toBeCloseTo(3);
  expect(vibration({ x: 0, y: 0, z: STANDARD_GRAVITY - 2, includesGravity: true })).toBeCloseTo(2);
  expect(vibration({ x: 3, y: 4, z: 0, includesGravity: false })).toBe(5);
  expect(vibration({ x: NaN, y: 0, z: 0, includesGravity: false })).toBeNull();
});

it('全記録から中央値・nearest-rankの95パーセンタイル・最大値を算出する', () => {
  const stats = analyzeVibration(Array.from({ length: 20 }, (_, i) => measurement(20 - i, 20 - i)));
  expect(stats.median).toBe(10.5);
  expect(stats.p95).toBe(19);
  expect(stats.max).toBe(20);
  expect(stats.count).toBe(20);
  expect(stats.points[0].at).toBe(1);
  expect(thresholdCount(stats.values, 19)).toBe(2);
});

it('境界以上を丸めずに数え、しきい値変更で再計算できる', () => {
  const stats = analyzeVibration([measurement(2.9999), measurement(3), measurement(3.0001)]);
  expect(thresholdCount(stats.values, 3)).toBe(2);
  expect(thresholdCount(stats.values, 0)).toBe(3);
  expect(thresholdCount(stats.values, 4)).toBe(0);
});

it('空記録や不正値を0の振動として扱わない', () => {
  const stats = analyzeVibration([measurement(Infinity)]);
  expect(stats).toMatchObject({ count: 0, invalid: 1, median: null, p95: null, max: null });
  expect(thresholdCount(stats.values, 3)).toBe(0);
  expect(analyzeVibration([measurement(5)]).median).toBe(5);
});

it('グラフの集約で一瞬のピークと低い値を残し、時刻順を維持する', () => {
  const points = Array.from({ length: 30_000 }, (_, at) => ({ at, value: at === 12345 ? 99 : at % 2 }));
  const envelope = chartEnvelope(points);
  expect(envelope.length).toBeLessThanOrEqual(400);
  expect(envelope.some(point => point.value === 99)).toBe(true);
  expect(envelope.some(point => point.value === 0)).toBe(true);
  expect(envelope.every((point, i) => i === 0 || point.at >= envelope[i - 1].at)).toBe(true);
  expect(chartEnvelope(points.slice(0, 2))).toEqual(points.slice(0, 2));
});
