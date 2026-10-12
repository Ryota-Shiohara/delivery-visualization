import type { Measurement, Mode } from './types';

export const DEFAULT_API_URL = import.meta.env.VITE_MEASUREMENT_API_URL || 'https://0cori0yr7d.execute-api.us-east-1.amazonaws.com/dev/measurements';
export const UPLOAD_BATCH_SIZE = 30;

export function normalizeApiUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('有効なAPI URLを入力してください。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('API URLは認証情報・クエリ・フラグメントを含まないHTTPS URLにしてください。');
  }
  return url.href.replace(/\/$/, '');
}

// 1リクエストは最大30件。保存確認済みIDだけを再送対象から除外する。
export async function uploadMeasurements(
  endpoint: string, measurements: Measurement[], mode: Mode,
  options: { signal: AbortSignal; sentIds: Set<string>; onSent: (id: string) => Promise<void>; onProgress: (sent: number, total: number) => void },
): Promise<void> {
  const url = normalizeApiUrl(endpoint);
  let sent = measurements.filter(item => options.sentIds.has(item.measurementId)).length;
  options.onProgress(sent, measurements.length);
  const pending = measurements.filter(item => !options.sentIds.has(item.measurementId));
  for (let offset = 0; offset < pending.length; offset += UPLOAD_BATCH_SIZE) {
    if (options.signal.aborted) throw new Error('送信を中止しました。');
    const batch = pending.slice(offset, offset + UPLOAD_BATCH_SIZE);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 15_000);
    try {
      const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ measurements: batch.map(item => ({ ...item, mode })) }), signal: controller.signal,
        credentials: 'omit', redirect: 'error',
      });
      if (!response.ok) throw new Error(`APIがエラーを返しました（HTTP ${response.status}）。`);
      const result = await response.json() as { savedMeasurementIds?: unknown; failedMeasurementIds?: unknown } | null;
      const saved = result?.savedMeasurementIds;
      const failed = result?.failedMeasurementIds;
      const ids = new Set(batch.map(item => item.measurementId));
      if (!Array.isArray(saved) || !Array.isArray(failed)) {
        throw new Error('APIの保存確認が一致しません。APIが一括送信形式に対応しているか確認してください。');
      }
      const acknowledged = [...saved, ...failed];
      if (acknowledged.length !== batch.length || new Set(acknowledged).size !== batch.length ||
          acknowledged.some(id => typeof id !== 'string' || !ids.has(id))) {
        throw new Error('APIの保存確認が一致しないため、送信を停止しました。');
      }
      for (const id of saved as string[]) {
        await options.onSent(id);
        options.sentIds.add(id);
        options.onProgress(++sent, measurements.length);
      }
      if (failed.length) throw new Error(`${failed.length}件をAPIに保存できませんでした。未送信分を再送してください。`);
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
