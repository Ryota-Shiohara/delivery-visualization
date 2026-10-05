import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { getMeasurements, listSessions, saveBatch } from './storage';
import { makeMeasurement } from './measurement';
import type { Session } from './types';

it('同じ計測IDの再保存で重複せず、別配送のデータと混ざらない', async () => {
  const session: Session = {
    id: 'first', deviceId: 'anonymous', mode: 'demo', startedAt: '2026-10-05T00:00:00.000Z',
    endedAt: null, calibration: null, sampleCount: 1, status: 'recording',
  };
  const reading = { measuredAt: Date.parse(session.startedAt), acceleration: { x: 0, y: 0, z: 9.81, includesGravity: true }, linearAcceleration: null };
  const first = makeMeasurement(session, reading, null, null);
  await saveBatch(session, [first]);
  await saveBatch({ ...session, status: 'completed', endedAt: session.startedAt }, [first]);
  const other = { ...session, id: 'second' };
  await saveBatch(other, [makeMeasurement(other, reading, null, null)]);
  expect(await getMeasurements('first')).toEqual([first]);
  expect(await getMeasurements('second')).toHaveLength(1);
  expect((await listSessions()).find(s => s.id === 'first')?.status).toBe('completed');
});
