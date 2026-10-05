import { useCollector } from './useCollector';
import type { Session } from './types';

const decimal = (n: number | null | undefined, digits = 2) => n === null || n === undefined ? '—' : n.toFixed(digits);
const duration = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const date = (iso: string) => new Date(iso).toLocaleString('ja-JP');

export function App() {
  const c = useCollector();
  const { snapshot: s } = c;
  const busy = c.recording || c.stopping || c.connecting;
  const reading = s.sensorFresh ? s.reading : null;
  return <>
    <a className="skip-link" href="#main">計測画面へ移動</a>
    <header className="topbar">
      <a className="brand" href="./" aria-label="Collector ホーム"><span className="brand-mark" aria-hidden="true"><Signal /></span>collector<span className="brand-label">配送品質の計測</span></a>
      <span className="prototype">PROTOTYPE <span>01</span></span>
    </header>
    <main id="main" className="shell">
      <section className="intro">
        <p className="eyebrow">DELIVERY FIELD NOTES</p>
        <h1>配送の揺れを、<br className="phone-break" />記録しよう。</h1>
        <p className="intro-copy">スマホを固定して、加速度・傾斜・位置を計測。<br />記録はこの端末に保存できます。</p>
      </section>

      <div className="workspace">
        <div className="main-column">
          <section className="panel setup" aria-labelledby="setup-title">
            <div className="section-heading"><h2 id="setup-title"><span className="step">01</span> 計測の準備</h2><span className="subtle">画面を開いたまま使います</span></div>
            <fieldset className="mode-options" disabled={busy}>
              <legend className="sr-only">データの取得方法</legend>
              <label className={c.mode === 'device' ? 'mode selected' : 'mode'}><input type="radio" name="mode" value="device" checked={c.mode === 'device'} onChange={() => c.changeMode('device')} /><span><strong>実機で計測</strong><small>スマホのセンサを使用</small></span><span className="mode-dot" aria-hidden="true" /></label>
              <label className={c.mode === 'demo' ? 'mode selected' : 'mode'}><input type="radio" name="mode" value="demo" checked={c.mode === 'demo'} onChange={() => c.changeMode('demo')} /><span><strong>模擬データで試す</strong><small>PCでも操作を確認</small></span><span className="mode-dot" aria-hidden="true" /></label>
            </fieldset>
            {c.mode === 'demo' && <p className="notice demo-notice">模擬モード：表示・保存される値はすべて架空のデータです。</p>}
            {c.mode === 'device' && !window.isSecureContext && <p className="notice warning">HTTPSで接続してください。現在の接続では実機センサを利用できません。</p>}
            <div className="setup-actions">
              <button className="button primary" onClick={() => void c.enable()} disabled={c.enabled || c.connecting || c.stopping}>{c.connecting ? '権限を確認中…' : c.enabled ? 'センサ接続済み' : 'センサを有効にする'}</button>
              <button className="button secondary" onClick={c.calibrate} disabled={!c.enabled || !s.orientationFresh || busy}>{c.calibrated ? '基準姿勢を再校正' : 'この姿勢で校正'}</button>
            </div>
            <p className="status-message" role="status">{c.message}</p>
            <ul className="connection-list">
              <li><span>加速度</span><b className={s.sensorFresh ? 'good' : ''}>{s.sensorFresh ? '取得中' : c.enabled ? 'データ待ち' : '未接続'}</b></li>
              <li><span>基準姿勢</span><b className={c.calibrated ? 'good' : ''}>{c.calibrated ? '校正済み' : '未校正'}</b></li>
              <li><span>GPS</span><b className={s.position ? 'good' : ''}>{s.position ? `精度 ±${decimal(s.position.accuracyMeters, 0)} m` : '未取得'}</b></li>
            </ul>
            <p className="helper">未校正・姿勢未取得の場合、傾斜は空欄で記録します。センサ有効化後も加速度が届かない場合は、権限と端末の対応状況を確認してください。</p>
          </section>

          <section className="live-panel" aria-labelledby="live-title">
            <div className="section-heading"><h2 id="live-title"><span className="step">02</span> ライブ計測</h2><span className="live-badge"><i className={s.sensorFresh ? 'dot active' : 'dot'} />{c.recording ? 'RECORDING' : s.sensorFresh ? 'LIVE PREVIEW' : 'STANDBY'}</span></div>
            <div className="readings">
              <div className="big-reading"><span>基準からの傾斜</span><p>{decimal(s.sensorFresh ? s.tilt : null, 1)}<small>°</small></p><small>{c.calibrated ? '校正した姿勢との角度' : '姿勢を校正すると表示されます'}</small></div>
              <div className="axis-readings"><span>3軸加速度 <small>m/s²</small></span>{(['x', 'y', 'z'] as const).map(axis => <div key={axis}><span className={`axis axis-${axis}`}>{axis.toUpperCase()}</span><strong>{decimal(reading?.acceleration[axis])}</strong></div>)}<small>{reading ? reading.acceleration.includesGravity ? '重力成分を含む' : '重力成分を除いた値' : 'センサデータ待ち'}</small></div>
            </div>
            <div className="chart-heading"><span>加速度の大きさ</span><small>{reading?.linearAcceleration ? '重力除去済み' : '重力込みの場合あり'} · 直近約24秒</small></div>
            <Sparkline values={s.points} />
            <div className="chart-footer"><span>24秒前</span><span>現在</span></div>
            <div className="session-stats"><div><span>計測時間</span><strong>{duration(s.elapsed)}</strong></div><div><span>記録件数</span><strong>{s.count.toLocaleString()}<small> 件</small></strong></div><div><span>受信頻度</span><strong>{s.hz}<small> Hz</small></strong></div></div>
            <div className="record-actions">
              {c.recording ? <button className="button stop" onClick={() => void c.stop()}><span className="stop-icon" aria-hidden="true" />計測を終了して保存</button> : <button className="button record" onClick={() => void c.start()} disabled={!s.sensorFresh || !c.enabled || c.stopping || c.connecting}><span className="record-icon" aria-hidden="true" />{c.stopping ? '記録を保存中…' : '計測を開始する'}</button>}
              <button className="button dark-secondary" disabled={s.count === 0 || c.recording || c.stopping} onClick={() => void c.exportCurrent()}>JSON出力</button>
            </div>
            <p className="live-note">{c.wakeMessage}</p>
          </section>
        </div>

        <aside className="side-column">
          <section className="panel position-panel" aria-labelledby="position-title">
            <div className="section-heading"><h2 id="position-title">現在の位置</h2><span className="mini-tag">{c.mode === 'demo' ? 'SAMPLE' : 'GPS'}</span></div>
            <div className="position-illustration" aria-hidden="true"><svg viewBox="0 0 320 132"><path className="map-line" d="M0 30H320M0 100H320M55 0V132M220 0V132M0 132L140 0M120 132L260 0" /><path className="route-line" d="M55 115V100H160Q180 100 180 80V65Q180 48 200 48H255" /><circle className="map-halo" cx="180" cy="80" r="19" /><circle className="map-pin" cx="180" cy="80" r="6" /></svg><span>GPSイメージ（実際の地図ではありません）</span></div>
            <dl className="position-data"><div><dt>緯度</dt><dd>{decimal(s.position?.latitude, 6)}</dd></div><div><dt>経度</dt><dd>{decimal(s.position?.longitude, 6)}</dd></div><div><dt>速度</dt><dd>{decimal(s.position?.speedMetersPerSecond, 1)} <small>m/s</small></dd></div><div><dt>位置の取得時刻</dt><dd>{s.position ? new Date(s.position.measuredAt).toLocaleTimeString('ja-JP') : '—'}</dd></div></dl>
            <p className="helper">{c.gpsMessage}{!s.position && c.enabled ? '（新しい位置データを待っています）' : ''}</p>
          </section>

          <section className="panel records-panel" aria-labelledby="records-title">
            <div className="section-heading"><h2 id="records-title">端末内の記録</h2><span className="mini-tag">LOCAL</span></div>
            <p className="helper" role="status">{c.storageMessage}</p>
            {c.history.length === 0 ? <div className="empty-state"><span className="empty-icon" aria-hidden="true"><Signal /></span><strong>最初の計測をしてみよう</strong><p>終了した記録はここから<br />JSONで取り出せます。</p></div> : <ul className="history-list">{c.history.slice(0, 10).map(item => <HistoryItem key={item.id} session={item} onExport={() => void c.exportSaved(item)} disabled={busy} />)}</ul>}
            {c.history.length > 10 && <p className="helper">直近10件を表示しています。</p>}
            <button className="text-button" disabled={busy} onClick={() => void c.retrySave()}>保存を再試行・記録を更新</button>
            <p className="helper local-note">AWSへの送信は未実装です。ブラウザのデータ削除で記録も消えるため、必要な記録はJSONで保管してください。</p>
          </section>
          <div className="field-tip"><span className="tip-number">FIELD TIP</span><p>バッグ内でスマホを固定。<br />同じ条件で、何度か走ってみよう。</p></div>
        </aside>
      </div>
      <footer className="footer"><span>FOOD DELIVERY QUALITY PROJECT</span><span>記録上限 30,000件 / 1回</span></footer>
    </main>
  </>;
}

function HistoryItem({ session, onExport, disabled }: { session: Session; onExport: () => void; disabled: boolean }) {
  return <li><div><strong>{session.mode === 'demo' ? '模擬計測' : '実機計測'}<span className="history-status">{session.status === 'recording' ? '終了未確認' : '保存済み'}</span></strong><small>{date(session.startedAt)}</small><span>{session.sampleCount.toLocaleString()} 件</span></div><button className="button small" onClick={onExport} disabled={disabled} aria-label={`${date(session.startedAt)}の${session.mode === 'demo' ? '模擬' : '実機'}記録をJSON出力`}>JSON</button></li>;
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(5, ...values);
  const coords = values.map((v, i) => `${((120 - values.length + i) / 119 * 600).toFixed(1)},${(100 - v / max * 85).toFixed(1)}`);
  return <svg className="sparkline" viewBox="0 0 600 112" preserveAspectRatio="none" role="img" aria-label={`加速度の大きさの推移。表示範囲は0から${max.toFixed(1)}メートル毎秒毎秒。`}>
    <path className="chart-grid" d="M0 15H600M0 57H600M0 100H600" />
    {coords.length > 1 && <><polygon className="chart-area" points={`${((120 - values.length) / 119 * 600).toFixed(1)},112 ${coords.join(' ')} 600,112`} /><polyline className="chart-line" points={coords.join(' ')} /></>}
  </svg>;
}

function Signal() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 12h4l3-7 4 14 3-7h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
