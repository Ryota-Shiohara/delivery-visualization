import {InputError} from './local-contract.mjs';
export function samplingLimit(params){
 const mode=params.get('sampling');
 if(mode===null)return null;
 if(mode!=='uniform'||params.has('cursor'))throw new InputError('samplingはuniformを指定し、cursorと併用しないでください。');
 return Math.min(500,pageLimit(params));
}
// 両端の2件を予約し、残りを最大50個の重ならない時間帯へ配分する。
export function timeBuckets(first,last,limit){
 const budget=limit-2;
 if(budget<=0)return [];
 let start=Date.parse(first),end=Date.parse(last);
 if(end-start>1){start++;end--;}
 const span=end-start+1,count=Math.min(50,budget,span);
 return Array.from({length:count},(_,i)=>({
  start:new Date(start+Math.floor(span*i/count)).toISOString(),
  end:new Date(start+Math.floor(span*(i+1)/count)-1).toISOString(),
  limit:Math.floor(budget/count)+(i<budget%count?1:0)
 }));
}
export function sortMeasurements(rows){
 return [...new Map(rows.map(row=>[row.measurementId,row])).values()].sort((a,b)=>Date.parse(a.measuredAt)-Date.parse(b.measuredAt)||a.measurementId.localeCompare(b.measurementId));
}
export function timeSample(rows,limit){
 if(!rows.length)return [];
 if(limit===1)return [rows[0]];
 const selected=[rows[0],rows.at(-1)];
 for(const bucket of timeBuckets(rows[0].measuredAt,rows.at(-1).measuredAt,limit)){
  const start=Date.parse(bucket.start),end=Date.parse(bucket.end);
  selected.push(...rows.filter(row=>Date.parse(row.measuredAt)>=start&&Date.parse(row.measuredAt)<=end).slice(0,bucket.limit));
 }
 return sortMeasurements(selected);
}
export function pageLimit(params,maximum=1000,fallback=500){
 const raw=params.get('limit');
 if(raw!==null&&!/^\d+$/.test(raw))throw new InputError('limitは正の整数にしてください。');
 const limit=raw===null?Math.min(fallback,maximum):Number(raw);
 if(!Number.isInteger(limit)||limit<1||limit>1000)throw new InputError('limitは1〜1000にしてください。');
 return Math.min(limit,maximum);
}
export function encodeCursor(scope,key){return key&&Object.keys(key).length?Buffer.from(JSON.stringify({version:1,scope,key})).toString('base64url'):null;}
export function decodeCursor(token,scope){
 if(!token)return undefined;
 try{
  if(token.length>8192||!/^[A-Za-z0-9_-]+$/.test(token))throw new Error();
  const value=JSON.parse(Buffer.from(token,'base64url').toString('utf8'));
  if(value.version!==1||value.scope!==scope||!value.key||Array.isArray(value.key)||typeof value.key!=='object')throw new Error();
  return value.key;
 }catch{throw new InputError('ページの続き情報が不正です。更新して最初から読み込んでください。');}
}
