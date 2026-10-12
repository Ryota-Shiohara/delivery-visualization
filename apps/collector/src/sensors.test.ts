import { afterEach, expect, it, vi } from 'vitest';
import { connectGps, requestSensorPermissions } from './sensors';

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

it('GPSだけを直接要求し、取得値を渡して終了後の通知を無視する', () => {
  let success!: PositionCallback;
  const watchPosition = vi.fn((callback: PositionCallback) => { success = callback; return 12; });
  const clearWatch = vi.fn();
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('navigator', { geolocation: { watchPosition, clearWatch } });
  const onPosition = vi.fn();
  const close = connectGps({ onPosition, onGpsError: vi.fn() });
  expect(watchPosition).toHaveBeenCalledOnce();
  const value = { timestamp: Date.parse('2026-10-12T00:00:00Z'), coords: { latitude: 35, longitude: 139, accuracy: 8, speed: null } } as GeolocationPosition;
  success(value);
  expect(onPosition).toHaveBeenCalledWith({ measuredAt: '2026-10-12T00:00:00.000Z', latitude: 35, longitude: 139, accuracyMeters: 8, speedMetersPerSecond: null });
  close();
  success(value);
  expect(clearWatch).toHaveBeenCalledWith(12);
  expect(onPosition).toHaveBeenCalledOnce();
});

it('GPSの拒否・取得失敗・タイムアウトを区別して案内する', () => {
  let failure!: PositionErrorCallback;
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('navigator', { geolocation: { watchPosition: (_success: PositionCallback, error: PositionErrorCallback) => { failure = error; return 1; }, clearWatch: vi.fn() } });
  const onGpsError = vi.fn();
  const close = connectGps({ onPosition: vi.fn(), onGpsError });
  for (const [code, message] of [[1, 'サイト設定'], [2, '端末の位置情報'], [3, 'タイムアウト']] as const) {
    failure({ code } as GeolocationPositionError);
    expect(onGpsError).toHaveBeenLastCalledWith(expect.stringContaining(message));
  }
  close();
});

it('GPSのHTTPS不足を検出し、位置情報を要求しない', () => {
  vi.stubGlobal('window', { isSecureContext: false });
  const watchPosition = vi.fn();
  vi.stubGlobal('navigator', { geolocation: { watchPosition } });
  const onGpsError = vi.fn();
  connectGps({ onPosition: vi.fn(), onGpsError });
  expect(onGpsError).toHaveBeenCalledWith(expect.stringContaining('HTTPS'));
  expect(watchPosition).not.toHaveBeenCalled();
});
