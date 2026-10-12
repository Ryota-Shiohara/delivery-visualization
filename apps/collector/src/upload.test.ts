import { afterEach, expect, it, vi } from 'vitest';
import { normalizeApiUrl, uploadMeasurements } from './upload';
import type { Measurement } from './types';

const measurement = (id: string): Measurement => ({ schemaVersion: '0.1.0', measurementId: id, deviceId: 'device', deliveryId: 'session', measuredAt: '2026-10-12T00:00:00Z', acceleration: { x: 0, y: 0, z: 9.81, includesGravity: true }, tiltDegrees: null, position: null });
const response = (id: string) => new Response(JSON.stringify({ message: 'saved', measurementId: id }));
const options = () => ({ signal: new AbortController().signal, sentIds: new Set<string>(), onSent: vi.fn(async () => {}), onProgress: vi.fn() });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('1件ずつPOSTし、模擬モードを区別する。送信済みは省略する', async () => {
  const fetchMock = vi.fn().mockResolvedValue(response('second'));
  vi.stubGlobal('fetch', fetchMock);
  const o = options(); o.sentIds.add('first');
  await uploadMeasurements('https://example.com/dev/measurements', [measurement('first'), measurement('second')], 'demo', o);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const request = fetchMock.mock.calls[0][1];
  expect(JSON.parse(request.body)).toEqual({ ...measurement('second'), mode: 'demo' });
  expect(request.headers).toEqual({ 'Content-Type': 'application/json' });
  expect(o.onSent).toHaveBeenCalledWith('second');
  expect(o.onProgress).toHaveBeenLastCalledWith(2, 2);
});

it('途中の失敗で停止し、確認済みの後から再送する', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(response('first')).mockResolvedValueOnce(new Response('', { status: 500 }));
  vi.stubGlobal('fetch', fetchMock);
  const o = options();
  const items = [measurement('first'), measurement('second'), measurement('third')];
  await expect(uploadMeasurements('https://example.com/measurements', items, 'device', o)).rejects.toThrow('HTTP 500');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect([...o.sentIds]).toEqual(['first']);
  fetchMock.mockResolvedValueOnce(response('second')).mockResolvedValueOnce(response('third'));
  await uploadMeasurements('https://example.com/measurements', items, 'device', o);
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it('保存確認が違う場合は成功扱いにしない', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('different')));
  const o = options();
  await expect(uploadMeasurements('https://example.com/measurements', [measurement('first')], 'device', o)).rejects.toThrow('保存確認');
  expect(o.onSent).not.toHaveBeenCalled();
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
