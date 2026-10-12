import { afterEach, expect, it, vi } from 'vitest';
import { normalizeApiUrl, uploadMeasurements } from './upload';
import type { Measurement } from './types';

const measurement = (id: string): Measurement => ({ schemaVersion: '0.1.0', measurementId: id, deviceId: 'device', deliveryId: 'session', measuredAt: '2026-10-12T00:00:00Z', acceleration: { x: 0, y: 0, z: 9.81, includesGravity: true }, tiltDegrees: null, position: null });
const response = (...ids: string[]) => new Response(JSON.stringify({ savedMeasurementIds: ids, failedMeasurementIds: [] }));
const options = () => ({ signal: new AbortController().signal, sentIds: new Set<string>(), onSent: vi.fn(async () => {}), onProgress: vi.fn() });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('配列でPOSTし、模擬モードを区別する。送信済みは省略する', async () => {
  const fetchMock = vi.fn().mockResolvedValue(response('second'));
  vi.stubGlobal('fetch', fetchMock);
  const o = options(); o.sentIds.add('first');
  await uploadMeasurements('https://example.com/dev/measurements', [measurement('first'), measurement('second')], 'demo', o);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const request = fetchMock.mock.calls[0][1];
  expect(JSON.parse(request.body)).toEqual({ measurements: [{ ...measurement('second'), mode: 'demo' }] });
  expect(request.headers).toEqual({ 'Content-Type': 'application/json' });
  expect(o.onSent).toHaveBeenCalledWith('second');
  expect(o.onProgress).toHaveBeenLastCalledWith(2, 2);
});

it('部分成功後の再送は失敗したIDだけ送る', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ savedMeasurementIds: ['first', 'third'], failedMeasurementIds: ['second'] })));
  vi.stubGlobal('fetch', fetchMock);
  const o = options();
  const items = [measurement('first'), measurement('second'), measurement('third')];
  await expect(uploadMeasurements('https://example.com/measurements', items, 'device', o)).rejects.toThrow('1件');
  expect([...o.sentIds]).toEqual(['first', 'third']);
  fetchMock.mockResolvedValueOnce(response('second'));
  await uploadMeasurements('https://example.com/measurements', items, 'device', o);
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).measurements.map((item: Measurement) => item.measurementId)).toEqual(['second']);
});

it('65件を30・30・5件に分け、途中のHTTP失敗で後続を送らない', async () => {
  const items = Array.from({ length: 65 }, (_, i) => measurement(String(i)));
  const fetchMock = vi.fn().mockImplementation((_url, init) => response(...JSON.parse(init.body).measurements.map((item: Measurement) => item.measurementId)));
  vi.stubGlobal('fetch', fetchMock);
  await uploadMeasurements('https://example.com/measurements', items, 'device', options());
  expect(fetchMock.mock.calls.map(call => JSON.parse(call[1].body).measurements.length)).toEqual([30, 30, 5]);
  fetchMock.mockReset().mockResolvedValueOnce(response(...items.slice(0, 30).map(item => item.measurementId))).mockResolvedValueOnce(new Response('', { status: 500 }));
  const o = options();
  await expect(uploadMeasurements('https://example.com/measurements', items, 'device', o)).rejects.toThrow('HTTP 500');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(o.sentIds.size).toBe(30);
});

it('欠落・重複・成功失敗の重複・旧形式の応答を保存確認として認めない', async () => {
  for (const result of [
    { savedMeasurementIds: [], failedMeasurementIds: [] },
    { savedMeasurementIds: ['first', 'first'], failedMeasurementIds: [] },
    { savedMeasurementIds: ['first'], failedMeasurementIds: ['first'] },
    { message: 'saved', measurementId: 'first' }, null,
  ]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(result))));
    const o = options();
    await expect(uploadMeasurements('https://example.com/measurements', [measurement('first')], 'device', o)).rejects.toThrow('保存確認');
    expect(o.onSent).not.toHaveBeenCalled();
  }
});

it('保存確認が違う場合は成功扱いにしない', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('different')));
  const o = options();
  await expect(uploadMeasurements('https://example.com/measurements', [measurement('first')], 'device', o)).rejects.toThrow('保存確認');
  expect(o.onSent).not.toHaveBeenCalled();
});

it('取得済みGPSの緯度・経度・時刻・精度・速度をPOST本文に含める', async () => {
  const fetchMock = vi.fn().mockResolvedValue(response('gps'));
  vi.stubGlobal('fetch', fetchMock);
  const position = { measuredAt: '2026-10-12T00:00:00Z', latitude: 35.123456, longitude: 139.123456, accuracyMeters: 8, speedMetersPerSecond: null };
  await uploadMeasurements('https://example.com/measurements', [{ ...measurement('gps'), position }], 'device', options());
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).measurements[0].position).toEqual(position);
});

it('中止済みの場合は通信しない', async () => {
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  const controller = new AbortController(); controller.abort();
  await expect(uploadMeasurements('https://example.com/measurements', [measurement('first')], 'device', { ...options(), signal: controller.signal })).rejects.toThrow('中止');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('応答待ちを15秒で打ち切る', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })));
  const operation = expect(uploadMeasurements('https://example.com/measurements', [measurement('first')], 'device', options())).rejects.toThrow('タイムアウト');
  await vi.advanceTimersByTimeAsync(15_000);
  await operation;
});

it('HTTPSの完全な送信先を要求し、秘密情報をURLに含めない', () => {
  expect(normalizeApiUrl(' https://example.com/dev/measurements/ ')).toBe('https://example.com/dev/measurements');
  for (const url of ['http://example.com', 'invalid', 'https://user:secret@example.com', 'https://example.com?key=secret']) {
    expect(() => normalizeApiUrl(url)).toThrow();
  }
});
