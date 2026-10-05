export type Mode = 'device' | 'demo';
export type Vector = { x: number; y: number; z: number };
export type Orientation = { beta: number; gamma: number };
export type Position = {
  measuredAt: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  speedMetersPerSecond: number | null;
};
export type Measurement = {
  schemaVersion: '0.1.0';
  measurementId: string;
  deviceId: string;
  deliveryId: string;
  measuredAt: string;
  acceleration: Vector & { includesGravity: boolean };
  tiltDegrees: number | null;
  position: Position | null;
};
export type Reading = {
  acceleration: Measurement['acceleration'];
  linearAcceleration: Vector | null;
  measuredAt: number;
};
export type Session = {
  id: string;
  deviceId: string;
  mode: Mode;
  startedAt: string;
  endedAt: string | null;
  sampleCount: number;
  calibration: Orientation | null;
  status: 'recording' | 'completed' | 'interrupted';
};
