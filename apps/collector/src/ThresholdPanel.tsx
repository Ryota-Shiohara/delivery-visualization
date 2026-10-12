import { useEffect, useMemo, useState } from 'react';
import { getMeasurements } from './storage';
import type { Measurement, Session } from './types';
import { analyzeVibration, chartEnvelope, DEFAULT_IMPACT_THRESHOLD, thresholdCount, type VibrationPoint } from './vibration';

type Inspection = { session: Session | null; measurements: Measurement[] };
const empty: Measurement[] = [];
const format = (value: number | null) => value === null ? '—' : value.toFixed(3);
const sessionName = (session: Session) => `${new Date(session.startedAt).toLocaleString('ja-JP')} · ${session.mode === 'demo' ? '模擬' : '実機'} · ${session.id.slice(0, 8)}${session.status === 'recording' ? ' · 終了未確認' : ''}`;

function useSavedMeasurements(id: string, count: number | undefined) {
  const [state, setState] = useState<{ id: string; data: Measurement[]; error: string | null } | null>(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void getMeasurements(id).then(data => {
      if (!cancelled) setState({ id, data, error: null });
    }).catch(() => {
      if (!cancelled) setState({ id, data: [], error: '記録を読み込めませんでした。「保存を再試行・記録を更新」から確認してください。' });
    });
    return () => { cancelled = true; };
  }, [id, count]);
  return {
    data: state?.id === id ? state.data : empty,
    loading: Boolean(id && state?.id !== id),
    error: state?.id === id ? state.error : null,
  };
}

export function ThresholdPanel({ current, history, recording }: { current: Inspection; history: Session[]; recording: boolean }) {
  const [source, setSource] = useState('current');
  const [comparisonId, setComparisonId] = useState('');
  const [thresholdText, setThresholdText] = useState(String(DEFAULT_IMPACT_THRESHOLD));
  const [frozen, setFrozen] = useState<Inspection | null>(null);
  useEffect(() => { setFrozen(null); }, [current.session?.id]);
  const selectedSession = history.find(item => item.id === source);
  const comparisonSession = history.find(item => item.id === comparisonId);
  const saved = useSavedMeasurements(source === 'current' ? '' : source, selectedSession?.sampleCount);
  const comparison = useSavedMeasurements(comparisonId, comparisonSession?.sampleCount);
  const live = frozen ?? current;
  const data = source === 'current' ? live.measurements : saved.data;
  const selected = source === 'current' ? live.session : selectedSession;
  const stats = useMemo(() => analyzeVibration(data), [data]);
  const comparisonStats = useMemo(() => analyzeVibration(comparison.data), [comparison.data]);
  const threshold = Number(thresholdText);
  const validThreshold = thresholdText.trim() !== '' && Number.isFinite(threshold) && threshold >= 0;
  const cutoff = source === 'current' && recording && stats.points.length ? stats.points[stats.points.length - 1].at - 24_000 : -Infinity;
  const plot = useMemo(() => chartEnvelope(stats.points.filter(point => point.at >= cutoff)), [stats.points, cutoff]);
  const available = history.filter(item => item.sampleCount > 0);

  return <section className="panel threshold-panel" aria-labelledby="threshold-title">
    <div className="section-heading"><h2 id="threshold-title"><span className="step">03</span> しきい値の検討</h2><span className="mini-tag">Cと同じ振動指標</span></div>
    <p className="helper">担当Cの判定に使う振動の大きさを、記録全体の分布と比較できます。ここでの変更は検討用で、APIや担当Cの設定には反映しません。</p>
    <div className="threshold-controls">
      <label className="upload-field">表示する記録<select value={source} onChange={event => { setSource(event.target.value); setFrozen(null); }}>
        <option value="current">今回の計測{recording ? '（計測中）' : ''}</option>
        {available.map(item => <option key={item.id} value={item.id}>{sessionName(item)}</option>)}
      </select></label>
      <label className="upload-field">衝撃のしきい値（m/s²）<input type="number" min="0" step="0.1" value={thresholdText} onChange={event => setThresholdText(event.target.value)} aria-invalid={!validThreshold} aria-describedby="threshold-hint" /></label>
    </div>
    <p id="threshold-hint" className={!validThreshold ? 'helper threshold-error' : 'helper'}>{!validThreshold ? '0以上の有限の数値を入力してください。' : '振動指標がこの値以上のサンプルを数えます。担当Cの現在の仮値は3.0 m/s²です。'}</p>
    <div className="threshold-heading"><p className="helper">{selected ? sessionName(selected) : '計測を開始すると表示されます。'}{frozen && source === 'current' ? ' · 表示を一時停止中' : ''}</p>
      {source === 'current' && (recording || frozen) && <button className="button small" onClick={() => setFrozen(frozen ? null : current)}>{frozen ? '表示を再開' : '表示を一時停止'}</button>}
    </div>
    {saved.loading && source !== 'current' && <p className="helper" role="status">記録を読み込んでいます…</p>}
    {saved.error && source !== 'current' && <p className="notice warning" role="alert">{saved.error}</p>}
    {selected?.mode === 'demo' && <p className="notice demo-notice">模擬データです。実機のしきい値決定には、条件をそろえた実測記録を使ってください。</p>}
    <Statistics stats={stats} threshold={validThreshold ? threshold : null} />
    <VibrationChart points={plot} threshold={validThreshold ? threshold : null} />
    <p className="helper">実線：振動指標 / 破線：しきい値。横軸は取得時刻からの経過秒。{source === 'current' && recording ? 'グラフは直近24秒、統計は今回の計測全体です（約1秒ごとに更新）。' : 'グラフ・統計とも記録全体です。'}</p>
    <label className="upload-field">比較する保存済み記録<select value={comparisonId} onChange={event => setComparisonId(event.target.value)}>
      <option value="">比較しない</option>
      {available.map(item => <option key={item.id} value={item.id}>{sessionName(item)}</option>)}
    </select></label>
    {comparisonId && <div className="threshold-comparison">
      <h3>比較記録の統計</h3><p className="helper">{comparisonSession ? sessionName(comparisonSession) : '選択した記録'}</p>
      {comparison.loading ? <p className="helper" role="status">比較記録を読み込んでいます…</p> : comparison.error ? <p className="notice warning" role="alert">{comparison.error}</p> : <>
        {comparisonSession?.mode === 'demo' && <p className="helper">この比較記録は模擬データです。</p>}
        <Statistics stats={comparisonStats} threshold={validThreshold ? threshold : null} />
      </>}
    </div>}
    <details className="threshold-explanation"><summary>計算式と比較するときの注意</summary>
      <p>重力込みは |√(x² + y² + z²) − 9.80665|、重力なしは √(x² + y² + z²)。隣り合うサンプルの差ではありません。担当Cのprototype-0.3と同じ式で、判定は丸める前の値を使います。</p>
      <p>中央値は中央2値の平均、95パーセンタイルは小さい順に並べたときの、件数の95%を切り上げた順位の値です。統計は全サンプルから計算し、グラフだけ区間の最小・最大を残して集約します。</p>
      <p>超過件数はサンプル数で、衝撃イベントの回数ではありません。静止・通常走行・段差などの条件を分け、端末・固定方法・取得頻度をそろえて比較してください。</p>
    </details>
  </section>;
}

function Statistics({ stats, threshold }: { stats: ReturnType<typeof analyzeVibration>; threshold: number | null }) {
  const exceeded = threshold === null ? null : thresholdCount(stats.values, threshold);
  return <>
    <dl className="threshold-stats">
      <div><dt>中央値</dt><dd>{format(stats.median)} <small>m/s²</small></dd></div>
      <div><dt>95パーセンタイル</dt><dd>{format(stats.p95)} <small>m/s²</small></dd></div>
      <div><dt>最大値</dt><dd>{format(stats.max)} <small>m/s²</small></dd></div>
      <div><dt>有効サンプル</dt><dd>{stats.count.toLocaleString()} <small>件</small></dd></div>
      <div><dt>しきい値以上</dt><dd>{stats.count && exceeded !== null ? exceeded.toLocaleString() : '—'} <small>件</small></dd></div>
      <div><dt>超過サンプル率</dt><dd>{stats.count && exceeded !== null ? (exceeded / stats.count * 100).toFixed(1) : '—'} <small>%</small></dd></div>
    </dl>
    {stats.invalid > 0 && <p className="helper">非有限の加速度 {stats.invalid.toLocaleString()}件を統計から除外しました。</p>}
  </>;
}

function VibrationChart({ points, threshold }: { points: VibrationPoint[]; threshold: number | null }) {
  if (!points.length) return <p className="threshold-empty">計測データがありません。計測を開始するか、保存済みの記録を選んでください。</p>;
  const max = Math.max(.1, threshold ?? 0, ...points.map(point => point.value));
  const start = points[0].at, end = points[points.length - 1].at;
  const x = (at: number) => 40 + (at - start) / Math.max(1, end - start) * 530;
  const y = (value: number) => 226 - value / max * 198;
  return <svg className="threshold-chart" viewBox="0 0 600 260" role="img" aria-label={`振動指標の時系列。最大表示値${max.toFixed(3)}m/s²。しきい値${threshold === null ? '未設定' : `${threshold}m/s²`}。`}>
    {[0, .5, 1].map(fraction => <g key={fraction}><line className="threshold-grid" x1="40" x2="570" y1={y(max * fraction)} y2={y(max * fraction)} /><text x="34" y={y(max * fraction) + 4} textAnchor="end">{(max * fraction).toFixed(1)}</text></g>)}
    <text x="40" y="16">m/s²</text>
    {threshold !== null && <line className="threshold-line" x1="40" x2="570" y1={y(threshold)} y2={y(threshold)} />}
    {points.length > 1 ? <polyline className="vibration-line" points={points.map(point => `${x(point.at).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ')} /> : <circle className="vibration-point" cx={x(start)} cy={y(points[0].value)} r="3" />}
    <text x="40" y="250">0秒</text><text x="570" y="250" textAnchor="end">{((end - start) / 1000).toFixed(1)}秒</text>
  </svg>;
}
