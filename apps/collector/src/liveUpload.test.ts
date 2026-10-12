import { afterEach, expect, it, vi } from 'vitest';
import { LiveUpload } from './liveUpload';
import type { Measurement } from './types';

const item = (id: string) => ({ measurementId: id, deliveryId: 'session' }) as Measurement;
const items = (count: number) => Array.from({ length: count }, (_, i) => item(String(i)));
const mockFetch = () => vi.fn((_url, init) => Promise.resolve(new Response(JSON.stringify({
  savedMeasurementIds: JSON.parse(init.body).measurements.map((item: Measurement) => item.measurementId), failedMeasurementIds: [],
}))));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('29件では待機し、30件目でまとめて送る', async () => {
  vi.useFakeTimers();
  const fetchMock = mockFetch(); vi.stubGlobal('fetch', fetchMock);
  const status = vi.fn();
  const uploader = new LiveUpload('https://example.com/measurements', 'demo', async () => {}, status);
  uploader.enqueue(items(29));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(status).toHaveBeenLastCalledWith({ sent: 0, pending: 29, error: null });
  uploader.enqueue([item('29')]);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).measurements).toHaveLength(30);
  await vi.advanceTimersByTimeAsync(0);
  expect(status).toHaveBeenLastCalledWith({ sent: 30, pending: 0, error: null });
  uploader.close();
});

it('30件未満でも最初の蓄積から1秒で送信する', async () => {
  vi.useFakeTimers();
  const fetchMock = mockFetch(); vi.stubGlobal('fetch', fetchMock);
  const uploader = new LiveUpload('https://example.com/measurements', 'device', async () => {}, () => {});
  uploader.enqueue([item('first')]);
  await vi.advanceTimersByTimeAsync(900);
  uploader.enqueue([item('second')]);
  expect(fetchMock).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).measurements).toHaveLength(2);
  uploader.close();
});

it('計測終了時は並行送信の空き枠で端数を即送信する', async () => {
  const resolve: (() => void)[] = [];
  const fetchMock = vi.fn((_url, init) => new Promise<Response>(done => {
    const ids = JSON.parse(init.body).measurements.map((item: Measurement) => item.measurementId);
    resolve.push(() => done(new Response(JSON.stringify({ savedMeasurementIds: ids, failedMeasurementIds: [] }))));
  }));
  vi.stubGlobal('fetch', fetchMock);
  const uploader = new LiveUpload('https://example.com/measurements', 'device', async () => {}, () => {});
  uploader.enqueue(items(35));
  expect(fetchMock).toHaveBeenCalledOnce();
  uploader.finish();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).measurements).toHaveLength(5);
  resolve[0]();
  resolve[1]();
  await vi.waitFor(() => expect(resolve).toHaveLength(2));
  uploader.close();
});

it('最大5バッチを並行送信し、応答順が逆でも件数と次の送信を保つ', async () => {
  const resolve: (() => void)[] = [];
  const fetchMock = vi.fn((_url, init) => new Promise<Response>(done => {
    const ids = JSON.parse(init.body).measurements.map((item: Measurement) => item.measurementId);
    resolve.push(() => done(new Response(JSON.stringify({ savedMeasurementIds: ids, failedMeasurementIds: [] }))));
  }));
  vi.stubGlobal('fetch', fetchMock);
  const status = vi.fn();
  const uploader = new LiveUpload('https://example.com/measurements', 'device', async () => {}, status);
  uploader.enqueue(items(185)); uploader.finish();
  expect(fetchMock).toHaveBeenCalledTimes(5);
  expect(status).toHaveBeenLastCalledWith({ sent: 0, pending: 185, error: null });
  resolve[4]();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
  expect(status).toHaveBeenLastCalledWith({ sent: 30, pending: 155, error: null });
  resolve[1]();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
  expect(JSON.parse(fetchMock.mock.calls[6][1].body).measurements).toHaveLength(5);
  resolve[6](); resolve[5](); resolve[3](); resolve[2](); resolve[0]();
  await vi.waitFor(() => expect(status).toHaveBeenLastCalledWith({ sent: 185, pending: 0, error: null }));
  uploader.close();
});

it('並行送信の一部が失敗しても他の成功を記録し、待機バッチは送らない', async () => {
  const resolve: ((failed?: boolean) => void)[] = [];
  const fetchMock = vi.fn((_url, init) => new Promise<Response>(done => {
    const ids = JSON.parse(init.body).measurements.map((item: Measurement) => item.measurementId);
    resolve.push((failed = false) => done(failed ? new Response('', { status: 500 }) : new Response(JSON.stringify({ savedMeasurementIds: ids, failedMeasurementIds: [] }))));
  }));
  vi.stubGlobal('fetch', fetchMock);
  const status = vi.fn();
  const uploader = new LiveUpload('https://example.com/measurements', 'device', async () => {}, status);
  uploader.enqueue(items(180)); uploader.finish();
  resolve[0](true);
  await vi.waitFor(() => expect(status).toHaveBeenLastCalledWith({ sent: 0, pending: 120, error: expect.stringContaining('HTTP 500') }));
  resolve[1](); resolve[2](); resolve[3](); resolve[4]();
  await vi.waitFor(() => expect(status).toHaveBeenLastCalledWith({ sent: 120, pending: 0, error: expect.stringContaining('HTTP 500') }));
  expect(fetchMock).toHaveBeenCalledTimes(5);
  uploader.close();
});

it('部分成功は件数に反映し、後続の自動送信を止める', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ savedMeasurementIds: ['0'], failedMeasurementIds: ['1'] })));
  vi.stubGlobal('fetch', fetchMock);
  const status = vi.fn();
  const uploader = new LiveUpload('https://example.com/measurements', 'device', async () => {}, status);
  uploader.enqueue(items(2)); uploader.finish();
  await vi.waitFor(() => expect(status).toHaveBeenLastCalledWith({ sent: 1, pending: 0, error: expect.stringContaining('1件') }));
  uploader.enqueue([item('other')]);
  expect(fetchMock).toHaveBeenCalledOnce();
  uploader.close();
});

it('終了処理で通信とタイマーを中止し、待機分を送らない', async () => {
  vi.useFakeTimers();
  let signal!: AbortSignal;
  const fetchMock = vi.fn((_url, init) => new Promise((_resolve, reject) => {
    signal = init.signal;
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  vi.stubGlobal('fetch', fetchMock);
  const uploader = new LiveUpload('https://example.com/measurements', 'device', async () => {}, () => {});
  uploader.enqueue(items(35)); uploader.close();
  expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetchMock).toHaveBeenCalledOnce();
});
