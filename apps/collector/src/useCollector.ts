import { useEffect, useRef, useState } from 'react';
import { amplitude, GPS_MAX_AGE_MS, makeMeasurement, MAX_SAMPLES, relativeTilt, SENSOR_MAX_AGE_MS } from './measurement';
import { connectSensors, requestSensorPermissions } from './sensors';
import { downloadSession, getMeasurements, listSessions, saveBatch } from './storage';
import type { Measurement, Mode, Orientation, Position, Reading, Session } from './types';

type Snapshot = { reading: Reading | null; tilt: number | null; position: Position | null; hz: number; count: number; elapsed: number; points: number[]; sensorFresh: boolean; orientationFresh: boolean };
const emptySnapshot: Snapshot = { reading: null, tilt: null, position: null, hz: 0, count: 0, elapsed: 0, points: [], sensorFresh: false, orientationFresh: false };

export function useCollector() {
  const [mode, setMode] = useState<Mode>('device');
  const [enabled, setEnabled] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [calibrated, setCalibrated] = useState(false);
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [message, setMessage] = useState('スマホをバッグ内に固定してから、センサを有効にしてください。');
  const [gpsMessage, setGpsMessage] = useState('未接続');
  const [storageMessage, setStorageMessage] = useState('計測データはこのブラウザに保存されます。');
  const [wakeMessage, setWakeMessage] = useState('計測開始時に画面の点灯維持を試みます。');
  const [history, setHistory] = useState<Session[]>([]);
  const reading = useRef<Reading | null>(null);
  const orientation = useRef<{ value: Orientation; at: number } | null>(null);
  const baseline = useRef<Orientation | null>(null);
  const position = useRef<Position | null>(null);
  const session = useRef<Session | null>(null);
  const samples = useRef<Measurement[]>([]);
  const storedCount = useRef(0);
  const pendingSave = useRef<Promise<void> | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const generation = useRef(0);
  const active = useRef(false);
  const lastSampleAt = useRef(0);
  const ticks = useRef<number[]>([]);
  const points = useRef<number[]>([]);
  const mounted = useRef(true);
  const connectingRef = useRef(false);
  const stopRef = useRef<(reason?: string) => Promise<void>>(async () => {});

  async function refreshHistory() {
    try { const items = await listSessions(); if (mounted.current) setHistory(items); }
    catch { if (mounted.current) setStorageMessage('端末内保存が利用できません。計測後にJSONをダウンロードしてください。'); }
  }

  function flush(): Promise<void> {
    if (pendingSave.current) return pendingSave.current;
    if (!session.current) return Promise.resolve();
    const count = samples.current.length;
    const current = { ...session.current, sampleCount: count };
    const batch = samples.current.slice(storedCount.current, count);
    const operation = saveBatch(current, batch).then(() => {
      storedCount.current = count;
      if (mounted.current) setStorageMessage(`${count.toLocaleString()}件を端末内に保存済み`);
    }).catch(error => {
      if (mounted.current) setStorageMessage('保存に失敗しました。停止後にJSONをダウンロードしてください。');
      throw error;
    }).finally(() => { pendingSave.current = null; });
    pendingSave.current = operation;
    return operation;
  }

  async function stop(reason = '計測を終了しました。端末内の記録を確認できます。') {
    if (!active.current) return;
    active.current = false;
    setRecording(false);
    setStopping(true);
    if (session.current) session.current = { ...session.current, endedAt: new Date().toISOString(), sampleCount: samples.current.length, status: 'completed' };
    setMessage(reason);
    try {
      // 進行中の保存が終わってから、残りの計測と終了状態を保存する。
      try { await pendingSave.current; } catch { /* 次のflushで未保存分を再試行 */ }
      await flush();
      await refreshHistory();
    } catch { /* 保存失敗時もメモリからJSONを出力できる */ }
    finally { if (mounted.current) setStopping(false); }
  }
  stopRef.current = stop;

  useEffect(() => {
    mounted.current = true;
    void refreshHistory();
    const uiTimer = setInterval(() => {
      const now = Date.now();
      ticks.current = ticks.current.filter(tick => now - tick < 1000);
      const fresh = reading.current !== null && now - reading.current.measuredAt <= SENSOR_MAX_AGE_MS;
      const orientationFresh = orientation.current !== null && now - orientation.current.at <= SENSOR_MAX_AGE_MS;
      const gpsFresh = position.current !== null && now - Date.parse(position.current.measuredAt) <= GPS_MAX_AGE_MS;
      if (fresh && reading.current) points.current = [...points.current.slice(-119), amplitude(reading.current)];
      setSnapshot({
        reading: reading.current, tilt: orientationFresh ? relativeTilt(orientation.current!.value, baseline.current) : null,
        position: gpsFresh ? position.current : null, hz: ticks.current.length, count: samples.current.length,
        elapsed: session.current ? ((session.current.endedAt ? Date.parse(session.current.endedAt) : now) - Date.parse(session.current.startedAt)) / 1000 : 0,
        points: [...points.current], sensorFresh: fresh, orientationFresh,
      });
    }, 200);
    const saveTimer = setInterval(() => { if (active.current) void flush().catch(() => {}); }, 2000);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && active.current) void stopRef.current('画面が非表示になったため計測を終了しました。続ける場合は新しい計測を開始してください。');
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mounted.current = false;
      generation.current++;
      cleanup.current?.();
      clearInterval(uiTimer);
      clearInterval(saveTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  // センサ値・保存カーソルはrefsで管理し、購読はマウント中に一度だけ行う。
  }, []);

  useEffect(() => {
    if (!recording) { setWakeMessage('画面の点灯維持は停止中です。'); return; }
    let cancelled = false;
    let lock: WakeLockSentinel | undefined;
    if (!navigator.wakeLock) { setWakeMessage('点灯維持に未対応です。画面の自動ロック設定を確認してください。'); return; }
    void navigator.wakeLock.request('screen').then(result => {
      if (cancelled) { void result.release(); return; }
      lock = result;
      setWakeMessage('画面の点灯を維持しています。');
      result.addEventListener('release', () => { if (!cancelled) setWakeMessage('点灯維持が解除されました。画面を開いたまま計測してください。'); });
    }).catch(() => { if (!cancelled) setWakeMessage('点灯維持が許可されませんでした。画面の自動ロック設定を確認してください。'); });
    return () => { cancelled = true; void lock?.release(); };
  }, [recording]);

  async function enable() {
    if (connectingRef.current || enabled) return;
    connectingRef.current = true;
    setConnecting(true);
    const token = ++generation.current;
    try {
      if (mode === 'device') await requestSensorPermissions();
      if (!mounted.current || token !== generation.current) return;
      setGpsMessage('GPS取得待ち');
      cleanup.current = connectSensors(mode, {
        onReading: value => {
          reading.current = value;
          ticks.current = [...ticks.current.slice(-199), value.measuredAt];
          if (!active.current || !session.current || value.measuredAt - lastSampleAt.current < 20) return;
          lastSampleAt.current = value.measuredAt;
          const tilt = orientation.current && value.measuredAt - orientation.current.at <= SENSOR_MAX_AGE_MS ? relativeTilt(orientation.current.value, baseline.current) : null;
          samples.current.push(makeMeasurement(session.current, value, tilt, position.current));
          if (samples.current.length >= MAX_SAMPLES) void stopRef.current('試作版の上限30,000件に達したため計測を終了しました。');
        },
        onOrientation: value => { orientation.current = { value, at: Date.now() }; },
        onPosition: value => { position.current = value; setGpsMessage(mode === 'demo' ? '架空の位置情報' : '位置情報を取得中'); },
        onGpsError: value => { position.current = null; setGpsMessage(value); },
      });
      setEnabled(true);
      setMessage('センサの値を確認し、スマホを固定した姿勢で校正してください。');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'センサの接続に失敗しました。'); }
    finally { connectingRef.current = false; if (mounted.current) setConnecting(false); }
  }

  function changeMode(next: Mode) {
    if (active.current || stopping || connectingRef.current) return;
    generation.current++;
    cleanup.current?.(); cleanup.current = null;
    reading.current = null; orientation.current = null; baseline.current = null; position.current = null;
    ticks.current = []; points.current = [];
    setEnabled(false); setCalibrated(false); setMode(next); setSnapshot(emptySnapshot);
    setGpsMessage('未接続');
    setMessage(next === 'demo' ? '模擬モードでは架空の加速度・姿勢・位置を使います。' : 'スマホを固定してセンサを有効にしてください。');
  }

  function calibrate() {
    if (!orientation.current || Date.now() - orientation.current.at > SENSOR_MAX_AGE_MS) {
      setMessage('姿勢データが届いていません。姿勢の権限と端末の対応状況を確認してください。'); return;
    }
    baseline.current = { ...orientation.current.value };
    setCalibrated(true);
    setMessage('現在の姿勢を基準にしました。計測を開始できます。');
  }

  async function start() {
    if (active.current || stopping || !enabled || !reading.current || Date.now() - reading.current.measuredAt > SENSOR_MAX_AGE_MS) return;
    if (session.current && storedCount.current < samples.current.length) {
      setMessage('前回の未保存データがあります。保存を再試行してください。保存できない場合はJSONを出力し、ファイルを確認してから再読み込みしてください。'); return;
    }
    samples.current = []; storedCount.current = 0; lastSampleAt.current = 0;
    session.current = {
      id: crypto.randomUUID(), deviceId: deviceId(), mode, startedAt: new Date().toISOString(), endedAt: null,
      calibration: baseline.current, sampleCount: 0, status: 'recording',
    };
    active.current = true; setRecording(true);
    setMessage('計測中です。画面を開いたままにしてください。');
    void flush().catch(() => {});
  }

  async function exportCurrent() {
    if (session.current) downloadSession({ ...session.current, sampleCount: samples.current.length }, samples.current);
  }

  async function exportSaved(item: Session) {
    try { downloadSession(item.status === 'recording' ? { ...item, status: 'interrupted' } : item, await getMeasurements(item.id)); }
    catch { setStorageMessage('保存済みデータの読み出しに失敗しました。'); }
  }

  return { mode, enabled, connecting, recording, stopping, calibrated, snapshot, message, gpsMessage, storageMessage, wakeMessage, history, enable, changeMode, calibrate, start, stop, exportCurrent, exportSaved, retrySave: async () => { try { await flush(); await refreshHistory(); } catch { /* メッセージはflushで表示 */ } } };
}

function deviceId(): string {
  try {
    const stored = localStorage.getItem('collector-device-id');
    if (stored) return stored;
    const id = crypto.randomUUID();
    localStorage.setItem('collector-device-id', id);
    return id;
  } catch { return crypto.randomUUID(); }
}
