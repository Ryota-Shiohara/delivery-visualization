import { describe, expect, it } from 'vitest';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import schema from '../../../contracts/schemas/measurement.schema.json';
import { finiteVector, makeMeasurement, relativeTilt } from './measurement';
import type { Position, Reading, Session } from './types';

const session: Session = {
  id: 'delivery-test', deviceId: 'anonymous-test', mode: 'demo', startedAt: '2026-10-05T00:00:00.000Z',
  endedAt: null, sampleCount: 0, calibration: { beta: 0, gamma: 0 }, status: 'recording',
};
const reading: Reading = {
  measuredAt: Date.parse(session.startedAt), acceleration: { x: 0, y: 0, z: 9.81, includesGravity: true }, linearAcceleration: null,
};
const gps: Position = { measuredAt: session.startedAt, latitude: 35, longitude: 139, accuracyMeters: 5, speedMetersPerSecond: null };

describe('センサ値と共通契約', () => {
  it('未取得・非有限の軸を0と誤認しない', () => {
    expect(finiteVector({ x: 0, y: null, z: 1 })).toBeNull();
    expect(finiteVector({ x: NaN, y: 0, z: 1 })).toBeNull();
    expect(finiteVector({ x: 0, y: 0, z: Infinity })).toBeNull();
    expect(finiteVector({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
  });
  it('基準姿勢、直角、反転、角度の折り返しを扱う', () => {
    const origin = { beta: 0, gamma: 0 };
    expect(relativeTilt(origin, origin)).toBeCloseTo(0);
    expect(relativeTilt({ beta: 90, gamma: 0 }, origin)).toBeCloseTo(90);
    expect(relativeTilt({ beta: 180, gamma: 0 }, origin)).toBeCloseTo(180);
    expect(relativeTilt({ beta: -179, gamma: 0 }, { beta: 179, gamma: 0 })).toBeCloseTo(2);
    expect(relativeTilt(origin, null)).toBeNull();
  });
  it('5秒以上古い位置と計測より未来の位置を対応付けない', () => {
    expect(makeMeasurement(session, reading, 0, gps).position).toEqual(gps);
    expect(makeMeasurement(session, { ...reading, measuredAt: reading.measuredAt + 5001 }, 0, gps).position).toBeNull();
    expect(makeMeasurement(session, { ...reading, measuredAt: reading.measuredAt - 1 }, 0, gps).position).toBeNull();
  });
  it('位置・傾斜未取得を含め、計測データが共通Schemaに適合する', () => {
    const ajv = new Ajv();
    addFormats(ajv);
    const validate = ajv.compile(schema);
    for (const item of [makeMeasurement(session, reading, 0, gps), makeMeasurement(session, reading, null, null)]) {
      expect(validate(item), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(makeMeasurement(session, reading, 0, gps).measurementId).not.toBe(makeMeasurement(session, reading, 0, gps).measurementId);
  });
});
