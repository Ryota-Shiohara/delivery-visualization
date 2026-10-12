import { useEffect, useRef, useState } from 'react';
import { getMeasurements, markUploaded, uploadedIds } from './storage';
import { normalizeApiUrl, uploadMeasurements } from './upload';
import type { Session } from './types';

export function UploadPanel({ history, disabled, apiUrl, setApiUrl }: { history: Session[]; disabled: boolean; apiUrl: string; setApiUrl: (value: string) => void }) {
  const [selectedId, setSelectedId] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('計測終了後、送る記録を選択してください。');
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { if (disabled) controller.current?.abort(); }, [disabled]);
  const available = history.filter(item => item.sampleCount > 0);
  const selected = available.find(item => item.id === selectedId);

  async function send() {
    if (!selected || disabled || controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setSending(true); setProgress(null); setMessage('送信する記録を読み込んでいます…');
    try {
      const endpoint = normalizeApiUrl(apiUrl);
      try { localStorage.setItem('collector-api-url', endpoint); } catch { /* URLの保存は任意 */ }
      const measurements = await getMeasurements(selected.id);
      if (!measurements.length) throw new Error('送信できる計測データがありません。');
      await uploadMeasurements(endpoint, measurements, selected.mode, {
        signal: abort.signal, sentIds: await uploadedIds(selected.id, endpoint),
        onSent: id => markUploaded(selected.id, endpoint, id),
        onProgress: (sent, total) => {
          if (mounted.current) { setProgress({ sent, total }); setMessage(`${sent.toLocaleString()} / ${total.toLocaleString()}件を送信済み`); }
        },
      });
      if (mounted.current) setMessage(`${measurements.length.toLocaleString()}件の送信が完了しました。端末内の記録も残っています。`);
    } catch (error) {
      if (mounted.current) setMessage(`${error instanceof Error ? error.message : '送信に失敗しました。'} 保存確認済みの分を除いて再送できます。`);
    } finally {
      controller.current = null;
      if (mounted.current) setSending(false);
    }
  }

  return <section className="panel upload-panel" aria-labelledby="upload-title">
    <div className="section-heading"><h2 id="upload-title">APIへ送信</h2><span className="mini-tag">POST</span></div>
    <p className="helper">計測開始と同時に、各サンプルの加速度・位置情報をこのAPIへ自動送信します。模擬モードでは架空の値を送ります。</p>
    <label className="upload-field">送信先API URL<input type="url" value={apiUrl} onChange={event => setApiUrl(event.target.value)} disabled={sending || disabled} placeholder="https://…/dev/measurements" autoCapitalize="none" spellCheck={false} /></label>
    <label className="upload-field">送る記録<select value={selectedId} onChange={event => { setSelectedId(event.target.value); setProgress(null); }} disabled={sending || disabled}>
      <option value="">記録を選択してください</option>
      {available.map(item => <option key={item.id} value={item.id}>{new Date(item.startedAt).toLocaleString('ja-JP')} · {item.mode === 'demo' ? '模擬' : '実機'} · {item.sampleCount.toLocaleString()}件</option>)}
    </select></label>
    {selected?.mode === 'demo' && <p className="notice demo-notice">模擬データを送信します。APIには模擬／実機の区別も保存します。</p>}
    <div className="upload-actions"><button className="button primary" onClick={() => void send()} disabled={disabled || sending || !selected || !apiUrl.trim()}>{sending ? '送信中…' : '選択した記録を送信'}</button>
      {sending && <button className="button secondary" onClick={() => controller.current?.abort()}>送信を中止</button>}</div>
    {progress && <progress max={progress.total} value={progress.sent} aria-label="APIへの送信進捗" />}
    <p className="helper" role="status" aria-live="polite">{message}</p>
    <p className="helper">自動送信に失敗した記録は、計測・自動送信の終了後に再送できます。同じURLへの再送では保存確認済みの計測を省略します。</p>
  </section>;
}
