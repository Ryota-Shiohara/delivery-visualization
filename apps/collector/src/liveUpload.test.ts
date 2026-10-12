import { afterEach, expect, it, vi } from 'vitest';
import { LiveUpload, type LiveUploadStatus } from './liveUpload';
import type { Measurement } from './types';

const item = (id: string) => ({ measurementId: id, deliveryId: 'session' }) as Measurement;
afterEach(() => vi.unstubAllGlobals());

it('新しいサンプルを即送信し、最大6件で待機分を順次送る', async () => {
  const resolve: (() => void)[] = [];
  const fetchMock = vi.fn((_url, init) => new Promise<Response>(done => {
    const id = JSON.parse(init.body).measurementId;
    resolve.push(() => done(new Response(JSON.stringify({ message: 'saved', measurementId: id }))));
  }));
  vi.stubGlobal('fetch', fetchMock);
  let status: LiveUploadStatus | undefined;
  const receipt = vi.fn(async () => {});
  const uploader = new LiveUpload('https://example.com/measurements', 'demo', receipt, value => { status = value; });
  uploader.enqueue([item('0')]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  uploader.enqueue(Array.from({ length: 7 }, (_, i) => item(String(i + 1))));
  expect(fetchMock).toHaveBeenCalledTimes(6);
  expect(status?.pending).toBe(8);
  resolve[0]();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
  resolve.slice(1).forEach(done => done());
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));
  resolve[7]();
  await vi.waitFor(() => expect(status).toEqual({ sent: 8, pending: 0, error: null }));
  expect(receipt).toHaveBeenCalledTimes(8);
});

it('通信失敗で後続の自動送信を止め、成功扱いにしない', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
  vi.stubGlobal('fetch', fetchMock);
  let status: LiveUploadStatus | undefined;
  const receipt = vi.fn(async () => {});
  const uploader = new LiveUpload('https://example.com/measurements', 'device', receipt, value => { status = value; });
  uploader.enqueue([item('first')]);
  await vi.waitFor(() => expect(status?.error).toContain('HTTP 500'));
  uploader.enqueue([item('second')]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(receipt).not.toHaveBeenCalled();
  expect(status?.pending).toBe(0);
});

it('画面を閉じると進行中の通信を中止し、待機分を送らない', async () => {
  const signals: AbortSignal[] = [];
  const fetchMock = vi.fn((_url, init) => new Promise((_resolve, reject) => {
    signals.push(init.signal);
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  vi.stubGlobal('fetch', fetchMock);
  const uploader = new LiveUpload('https://example.com/measurements', 'device', async () => {}, () => {});
  uploader.enqueue(Array.from({ length: 8 }, (_, i) => item(String(i))));
  uploader.close();
  expect(signals.every(signal => signal.aborted)).toBe(true);
  await new Promise(done => setTimeout(done, 0));
  expect(fetchMock).toHaveBeenCalledTimes(6);
});
