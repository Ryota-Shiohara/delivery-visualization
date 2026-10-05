import type { Measurement, Orientation, Position, Reading, Session, Vector } from './types';

export const MAX_SAMPLES = 30_000;
export const GPS_MAX_AGE_MS = 5_000;
export const SENSOR_MAX_AGE_MS = 2_000;

export function finiteVector(value: { x: number | null; y: number | null; z: number | null } | null): Vector | null {
  if (!value || ![value.x, value.y, value.z].every(v => typeof v === 'number' && Number.isFinite(v))) return null;
  return { x: value.x!, y: value.y!, z: value.z! };
}

// DeviceOrientationのZ-X'-Y''回転から、端末座標系の重力方向を求める。
// 方位の変化を傾きに含めず、開始時の重力方向との角度を評価する。
export function gravityDirection({ beta, gamma }: Orientation): Vector {
  const b = beta * Math.PI / 180;
  const g = gamma * Math.PI / 180;
  return { x: -Math.cos(b) * Math.sin(g), y: Math.sin(b), z: Math.cos(b) * Math.cos(g) };
}

export function relativeTilt(current: Orientation | null, baseline: Orientation | null): number | null {
  if (!current || !baseline) return null;
  const a = gravityDirection(current);
  const b = gravityDirection(baseline);
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  return Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI;
}

export function makeMeasurement(session: Session, reading: Reading, tilt: number | null, position: Position | null): Measurement {
  const age = position ? reading.measuredAt - Date.parse(position.measuredAt) : Infinity;
  return {
    schemaVersion: '0.1.0',
    measurementId: crypto.randomUUID(),
    deviceId: session.deviceId,
    deliveryId: session.id,
    measuredAt: new Date(reading.measuredAt).toISOString(),
    acceleration: reading.acceleration,
    tiltDegrees: tilt,
    position: age >= 0 && age <= GPS_MAX_AGE_MS ? position : null,
  };
}

export function amplitude(reading: Reading): number {
  const v = reading.linearAcceleration ?? reading.acceleration;
  return Math.hypot(v.x, v.y, v.z);
}
