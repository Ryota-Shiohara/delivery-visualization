import { finiteVector } from './measurement';
import type { Mode, Orientation, Position, Reading } from './types';

type PermissionEvent = { requestPermission?: () => Promise<string> };
type Callbacks = {
  onReading: (reading: Reading) => void;
  onOrientation: (orientation: Orientation) => void;
  onPosition: (position: Position) => void;
  onGpsError: (message: string) => void;
};

export async function requestSensorPermissions(): Promise<void> {
  if (!window.isSecureContext) throw new Error('実機計測にはHTTPSが必要です。スマホが信頼する証明書で接続してください。');
  if (!('DeviceMotionEvent' in window)) throw new Error('このブラウザは加速度の取得に対応していません。模擬モードで画面を試せます。');
  const motion = window.DeviceMotionEvent as PermissionEvent;
  const orientation = 'DeviceOrientationEvent' in window ? window.DeviceOrientationEvent as PermissionEvent : undefined;
  // 両方をクリック直後に呼び出す。await後ではiOSのユーザー操作条件を失う場合がある。
  const requests = [motion.requestPermission?.(), orientation?.requestPermission?.()];
  const results = await Promise.all(requests);
  if (results.some(result => result === 'denied')) throw new Error('モーションの利用が許可されませんでした。ブラウザの権限設定を確認してください。');
}

export function connectSensors(mode: Mode, callbacks: Callbacks): () => void {
  if (mode === 'demo') {
    const start = Date.now();
    const motion = setInterval(() => {
      const t = (Date.now() - start) / 1000;
      const bump = Math.pow(Math.max(0, Math.sin(t * 1.4)), 24) * 3.5;
      const linear = { x: Math.sin(t * 3) * 0.28, y: Math.cos(t * 2) * 0.18, z: Math.sin(t * 4) * 0.12 + bump };
      callbacks.onReading({
        measuredAt: Date.now(),
        acceleration: { ...linear, z: linear.z + 9.81, includesGravity: true },
        linearAcceleration: linear,
      });
      callbacks.onOrientation({ beta: Math.sin(t * 0.5) * 12, gamma: Math.cos(t * 0.7) * 5 });
    }, 40);
    const updatePosition = () => callbacks.onPosition({
      measuredAt: new Date().toISOString(), latitude: 35 + (Date.now() - start) / 10_000_000,
      longitude: 139, accuracyMeters: 5, speedMetersPerSecond: 3,
    });
    updatePosition();
    const gps = setInterval(updatePosition, 1000);
    return () => { clearInterval(motion); clearInterval(gps); };
  }

  const onMotion = (event: DeviceMotionEvent) => {
    const raw = finiteVector(event.accelerationIncludingGravity);
    const linear = finiteVector(event.acceleration);
    if (!raw && !linear) return;
    callbacks.onReading({
      measuredAt: Date.now(),
      acceleration: { ...(raw ?? linear!), includesGravity: Boolean(raw) },
      linearAcceleration: linear,
    });
  };
  const onOrientation = (event: DeviceOrientationEvent) => {
    if (typeof event.beta === 'number' && typeof event.gamma === 'number' && Number.isFinite(event.beta) && Number.isFinite(event.gamma)) {
      callbacks.onOrientation({ beta: event.beta, gamma: event.gamma });
    }
  };
  window.addEventListener('devicemotion', onMotion);
  window.addEventListener('deviceorientation', onOrientation);
  return () => {
    window.removeEventListener('devicemotion', onMotion);
    window.removeEventListener('deviceorientation', onOrientation);
  };
}

// ボタンのクリック直後に呼び、モーション権限とは別に位置情報を要求する。
export function connectGps(callbacks: Pick<Callbacks, 'onPosition' | 'onGpsError'>): () => void {
  if (!window.isSecureContext) {
    callbacks.onGpsError('GPSの取得にはHTTPS接続が必要です。');
    return () => {};
  }
  if (!navigator.geolocation) {
    callbacks.onGpsError('このブラウザは位置情報に対応していません。');
    return () => {};
  }
  let cancelled = false;
  const gps = navigator.geolocation.watchPosition(position => {
    if (cancelled) return;
    const { latitude, longitude, accuracy, speed } = position.coords;
    if (![position.timestamp, latitude, longitude, accuracy].every(Number.isFinite) || accuracy < 0 || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      callbacks.onGpsError('有効なGPS座標を取得できませんでした。再試行してください。');
      return;
    }
    callbacks.onPosition({
      measuredAt: new Date(position.timestamp).toISOString(), latitude, longitude, accuracyMeters: accuracy,
      speedMetersPerSecond: speed !== null && Number.isFinite(speed) && speed >= 0 ? speed : null,
    });
  }, error => {
    if (cancelled) return;
    const messages: Record<number, string> = {
      1: '位置情報が拒否されています。ブラウザのサイト設定と端末の位置情報設定を確認し、許可してから再試行してください。',
      2: '現在位置を取得できません。端末の位置情報を有効にし、屋外で再試行してください。',
      3: 'GPSの取得がタイムアウトしました。屋外で再試行してください。',
    };
    callbacks.onGpsError(messages[error.code] || 'GPSの取得に失敗しました。再試行してください。');
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15_000 });
  return () => { cancelled = true; navigator.geolocation.clearWatch(gps); };
}
