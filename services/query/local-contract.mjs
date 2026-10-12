// C担当が2026-10-11に共有した結果形式を使うローカル参照API。
// DynamoDBのキー設計が未確定のため、AWS SDKやScanの前提を持ち込まない。
export const TABLES = {
  analysis: 'delivery-analysisDB',
  summaries: 'delivery-summaryDB',
  cells: 'delivery-cellDB'
};
const specs = {
  analysis: {
    strings: ['measurementId', 'deliveryId', 'measuredAt', 'algorithmVersion'],
    numbers: ['qualityScore', 'vibration', 'tiltDegrees', 'latitude', 'longitude', 'accuracyMeters', 'speedMetersPerSecond'],
    nullable: ['tiltDegrees', 'latitude', 'longitude', 'accuracyMeters', 'speedMetersPerSecond'],
    booleans: ['isImpact'], id: 'measurementId', date: 'measuredAt'
  },
  summaries: {
    strings: ['deliveryId', 'updatedAt'], numbers: ['sampleCount', 'impactCount', 'avgScore', 'maxVibration', 'maxTilt'],
    nullable: ['maxTilt'], counts: ['sampleCount', 'impactCount'], id: 'deliveryId', date: 'updatedAt'
  },
  cells: {
    strings: ['cellId', 'evalStatus', 'updatedAt'],
    numbers: ['centerLat', 'centerLon', 'sampleCount', 'avgVibration', 'maxVibration', 'impactCount'],
    counts: ['sampleCount', 'impactCount'], id: 'cellId', date: 'updatedAt'
  }
};
export class InputError extends Error {}
function dynamoValue(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  if (Object.keys(value).length !== 1) return value;
  if ('S' in value) return value.S;
  if ('N' in value) return Number(value.N);
  if ('BOOL' in value) return value.BOOL;
  if ('NULL' in value) return null;
  if ('M' in value) return Object.fromEntries(Object.entries(value.M).map(([k,v])=>[k,dynamoValue(v)]));
  if ('L' in value) return value.L.map(dynamoValue);
  return value;
}
export function normalizeRecords(input) {
  const records = Array.isArray(input) ? input : input?.Items ?? input?.items ?? (input?.Item ? [input.Item] : [input]);
  if (!Array.isArray(records)) throw new InputError('JSON配列、1件のオブジェクト、またはItems配列を指定してください。');
  return records.map(row => {
    const item = row?.Item && !row.deliveryId && !row.cellId ? row.Item : row;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new InputError('各レコードはJSONオブジェクトにしてください。');
    return Object.fromEntries(Object.entries(item).map(([key,value])=>[key,dynamoValue(value)]));
  });
}
export function validateRecords(type, input) {
  const spec = specs[type];
  if (!spec) throw new InputError('取り込み先はanalysis / summaries / cellsのいずれかです。');
  const records = normalizeRecords(input);
  if (records.length > 30000) throw new InputError('1種類につき30,000件以内で取り込んでください。');
  const seen = new Set();
  records.forEach((row,index) => {
    const fail = msg => { throw new InputError(`${TABLES[type]} ${index + 1}件目：${msg}`); };
    for (const key of spec.strings ?? []) if (typeof row[key] !== 'string' || !row[key].trim()) fail(`${key}に文字列が必要です。`);
    for (const key of spec.numbers ?? []) {
      if (row[key] === null && spec.nullable?.includes(key)) continue;
      if (typeof row[key] !== 'number' || !Number.isFinite(row[key])) fail(`${key}に有限の数値が必要です。`);
    }
    for (const key of spec.booleans ?? []) if (typeof row[key] !== 'boolean') fail(`${key}にはtrue/falseが必要です。`);
    if (!Number.isFinite(Date.parse(row[spec.date])) || !/(Z|[+-]\d\d:\d\d)$/.test(row[spec.date])) fail(`${spec.date}はタイムゾーン付きISO日時にしてください。`);
    for (const key of spec.counts ?? []) if (!Number.isInteger(row[key]) || row[key] < 0) fail(`${key}には0以上の整数が必要です。`);
    for (const [key,min,max] of [['latitude',-90,90],['centerLat',-90,90],['longitude',-180,180],['centerLon',-180,180]]) {
      if (key in row && row[key] !== null && (row[key] < min || row[key] > max)) fail(`${key}の範囲が不正です。`);
    }
    if (type === 'analysis' && ((row.latitude === null) !== (row.longitude === null))) fail('latitude/longitudeは両方数値、または両方nullにしてください。');
    if (row.accuracyMeters !== undefined && row.accuracyMeters !== null && row.accuracyMeters < 0) fail('accuracyMetersは0以上にしてください。');
    if (row.impactCount !== undefined && row.impactCount > row.sampleCount) fail('impactCountがsampleCountを超えています。');
    if (seen.has(row[spec.id])) fail(`${spec.id}が重複しています。`);
    seen.add(row[spec.id]);
  });
  return records;
}
export function datasetMetadata(dataset) {
  return {
    mode: dataset.mode, label: dataset.label, sources: dataset.sources,
    counts: Object.fromEntries(Object.keys(TABLES).map(type=>[type,dataset[type].length])),
    notes: ['vibrationの単位とevalStatusの全値・判定基準はC担当に確認中。', 'スコアはCの値をそのまま表示。D側で再計算しない。']
  };
}
export function readQuery(dataset, pathname, params = new URLSearchParams()) {
  if (pathname === '/api/deliveries') {
    const ids = new Set([...dataset.summaries.map(r=>r.deliveryId),...dataset.analysis.map(r=>r.deliveryId)]);
    const items = [...ids].map(deliveryId=>({
      deliveryId,
      summary: dataset.summaries.find(row=>row.deliveryId===deliveryId) ?? null,
      availableAnalysisCount: dataset.analysis.filter(row=>row.deliveryId===deliveryId).length
    })).sort((a,b)=>(b.summary?.updatedAt??'').localeCompare(a.summary?.updatedAt??'') || a.deliveryId.localeCompare(b.deliveryId));
    return {items,meta:datasetMetadata(dataset)};
  }
  if (pathname.startsWith('/api/deliveries/')) {
    let id;
    try { id=decodeURIComponent(pathname.slice('/api/deliveries/'.length)); } catch { throw new InputError('配送IDの形式が不正です。'); }
    const summary=dataset.summaries.find(row=>row.deliveryId===id)??null;
    const all=dataset.analysis.filter(row=>row.deliveryId===id).sort((a,b)=>Date.parse(a.measuredAt)-Date.parse(b.measuredAt) || a.measurementId.localeCompare(b.measurementId));
    if (!summary && !all.length) return null;
    const limit=Number(params.get('limit')??2000),offset=Number(params.get('offset')??0);
    if(!Number.isInteger(limit)||limit<1||limit>30000||!Number.isInteger(offset)||offset<0) throw new InputError('limitは1〜30000、offsetは0以上の整数です。');
    return {deliveryId:id,summary,measurements:all.slice(offset,offset+limit),total:all.length,nextOffset:offset+limit<all.length?offset+limit:null,meta:datasetMetadata(dataset)};
  }
  if (pathname === '/api/cells') return {items:dataset.cells,scope:'全配送の地点集計',meta:datasetMetadata(dataset)};
  return null;
}
