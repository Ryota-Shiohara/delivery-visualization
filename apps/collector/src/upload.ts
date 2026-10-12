import type { Measurement, Mode } from './types';

export const DEFAULT_API_URL = 'https://0cori0yr7d.execute-api.us-east-1.amazonaws.com/dev/measurements';

export function normalizeApiUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('有効なAPI URLを入力してください。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('API URLは認証情報・クエリ・フラグメントを含まないHTTPS URLにしてください。');
  }
  return url.href.replace(/\/$/, '');
}

// 担当BのAPIは、バッチではなく1件の計測を本文として受け取る。
export async function uploadMeasurements(
  endpoint: string, measurements: Measurement[], mode: Mode,
  options: { signal: AbortSignal; sentIds: Set<string>; onSent: (id: string) => Promise<void>; onProgress: (sent: number, total: number) => void },
): Promise<void> {
  const url = normalizeApiUrl(endpoint);
  let sent = measurements.filter(item => options.sentIds.has(item.measurementId)).length;
  options.onProgress(sent, measurements.length);
  for (const measurement of measurements) {
    if (options.signal.aborted) throw new Error('送信を中止しました。');
    if (options.sentIds.has(measurement.measurementId)) continue;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 15_000);
    try {
      const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...measurement, mode }), signal: controller.signal,
        credentials: 'omit', redirect: 'error',
      });
      if (!response.ok) throw new Error(`APIがエラーを返しました（HTTP ${response.status}）。`);
      const result = await response.json() as { message?: unknown; measurementId?: unknown };
      if (result.message !== 'saved' || result.measurementId !== measurement.measurementId) {
        throw new Error('APIの保存確認が一致しないため、送信を停止しました。');
      }
      await options.onSent(measurement.measurementId);
      options.sentIds.add(measurement.measurementId);
      options.onProgress(++sent, measurements.length);
    } catch (error) {
      if (options.signal.aborted) throw new Error('送信を中止しました。');
      if (controller.signal.aborted) throw new Error('APIの応答がタイムアウトしました。再送できます。');
      if (error instanceof TypeError) throw new Error('APIに接続できません。URL・通信状態・APIのCORS設定を確認してください。');
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', cancel);
    }
  }
}
