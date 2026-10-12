import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { getMeasurements, listSessions, saveBatch, markUploaded, uploadedIds } from './storage';
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

it('送信確認をAPI URLと配送ごとに分離して保存する', async () => {
  await markUploaded('upload-first', 'https://a.example/measurements', 'one');
  await markUploaded('upload-first', 'https://a.example/measurements', 'one');
  await markUploaded('upload-first', 'https://b.example/measurements', 'two');
  await markUploaded('upload-second', 'https://a.example/measurements', 'three');
  expect([...await uploadedIds('upload-first', 'https://a.example/measurements')]).toEqual(['one']);
  expect([...await uploadedIds('upload-second', 'https://a.example/measurements')]).toEqual(['three']);
});
