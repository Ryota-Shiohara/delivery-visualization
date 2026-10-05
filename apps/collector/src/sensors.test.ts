import { afterEach, expect, it, vi } from 'vitest';
import { requestSensorPermissions } from './sensors';

afterEach(() => vi.unstubAllGlobals());

it('両センサの権限要求を最初のawaitより前に呼ぶ', async () => {
  let grant!: (result: string) => void;
  const motion = vi.fn(() => new Promise<string>(resolve => { grant = resolve; }));
  const orientation = vi.fn(() => Promise.resolve('granted'));
  vi.stubGlobal('window', { isSecureContext: true, DeviceMotionEvent: { requestPermission: motion }, DeviceOrientationEvent: { requestPermission: orientation } });
  const pending = requestSensorPermissions();
  expect(motion).toHaveBeenCalledOnce();
  expect(orientation).toHaveBeenCalledOnce();
  grant('granted');
  await expect(pending).resolves.toBeUndefined();
});

it('HTTPS不足と権限拒否を成功扱いにしない', async () => {
  vi.stubGlobal('window', { isSecureContext: false });
  await expect(requestSensorPermissions()).rejects.toThrow('HTTPS');
  vi.stubGlobal('window', { isSecureContext: true, DeviceMotionEvent: { requestPermission: () => Promise.resolve('denied') } });
  await expect(requestSensorPermissions()).rejects.toThrow('許可されません');
});
