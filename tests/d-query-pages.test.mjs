import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDynamoReader} from '../services/query/dynamo-reader.mjs';
import {createQueryHandler} from '../services/query/aws-handler-core.mjs';
import {readQuery} from '../services/query/local-contract.mjs';
import {encodeCursor,timeBuckets,timeSample} from '../services/query/pagination.mjs';
const fixture=JSON.parse(await readFile(new URL('../data/samples/d-dashboard/c-shared-example.json',import.meta.url),'utf8'));
const names={analysis:'analysis',summaries:'summaries',cells:'cells'};
const summary=fixture.summaries[0],id=summary.deliveryId,row=fixture.analysis[0];
const event=rawPath=>({rawPath,requestContext:{http:{method:'GET'}}});
const unexpected=async()=>{throw new Error('Unexpected DynamoDB read');};
const make=overrides=>createDynamoReader({names,scan:unexpected,get:unexpected,query:unexpected,...overrides});
test('配送一覧はsummaryだけを1ページ読み、解析・区画テーブルには触れない',async()=>{
 let scans=0;const reader=make({scan:async input=>{scans++;assert.equal(input.TableName,'summaries');assert.equal(input.Limit,50);return {Items:[summary],LastEvaluatedKey:{deliveryId:{S:id}}};}});
 const result=await reader('/api/deliveries',new URLSearchParams('limit=50'));
 assert.equal(scans,1);assert.equal(result.items[0].summary.avgScore,92.5);assert(result.nextToken);
});
test('区画一覧はcellテーブルだけを1ページ読み、続き情報を返す',async()=>{
 const reader=make({scan:async input=>{assert.equal(input.TableName,'cells');return {Items:fixture.cells,LastEvaluatedKey:{cellId:{S:fixture.cells[0].cellId}}};}});
 assert((await reader('/api/cells')).nextToken);
});
test('配送詳細はsummaryをGetし、指定した配送のGSIをQueryする',async()=>{
 const reader=make({get:async input=>{assert.deepEqual(input.Key,{deliveryId:{S:id}});return {Item:summary};},query:async input=>{assert.equal(input.IndexName,'DeliveryTimeIndex');assert.equal(input.TableName,'analysis');assert.equal(input.ExpressionAttributeValues[':delivery'].S,id);assert.equal(input.ScanIndexForward,true);return {Items:[row]};}});
 const result=await reader('/api/deliveries/'+id);assert.equal(result.summary.sampleCount,100);assert.equal(result.measurements.length,1);assert.equal(result.nextToken,null);
});
test('6001件を500件ずつ取得し、全体スコアを再計算せず全件に到達する',async()=>{
 const rows=Array.from({length:6001},(_,i)=>({...row,measurementId:'m-'+String(i).padStart(5,'0'),measuredAt:new Date(Date.UTC(2026,9,12)+i*1000).toISOString()}));
 let calls=0;
 const reader=make({get:async()=>({Item:{...summary,sampleCount:6001}}),query:async input=>{
  calls++;const offset=input.ExclusiveStartKey?Number(input.ExclusiveStartKey.measurementId.S.slice(2))+1:0;
  const items=rows.slice(offset,offset+input.Limit),last=items.at(-1);
  return {Items:items,...(offset+items.length<rows.length?{LastEvaluatedKey:{measurementId:{S:last.measurementId},deliveryId:{S:id},measuredAt:{S:last.measuredAt}}}:{})};
 }});
 let cursor=null;const collected=[];
 do{const params=new URLSearchParams('limit=500');if(cursor)params.set('cursor',cursor);const page=await reader('/api/deliveries/'+id,params);assert.equal(page.summary.avgScore,92.5);assert(page.measurements.length<=500);collected.push(...page.measurements);cursor=page.nextToken;}while(cursor);
 assert.equal(calls,13);assert.equal(collected.length,6001);assert.equal(new Set(collected.map(r=>r.measurementId)).size,6001);
});
test('別配送・別API・壊れたcursorはAWS呼び出し前に拒否する',async()=>{
 const reader=make();
 for(const cursor of ['broken',encodeCursor('dynamodb:delivery:other',{measurementId:{S:'m'},deliveryId:{S:'other'},measuredAt:{S:row.measuredAt}}),encodeCursor('dynamodb:/api/cells',{cellId:{S:'x'}})])await assert.rejects(()=>reader('/api/deliveries/'+id,new URLSearchParams({cursor})),/続き情報/);
 await assert.rejects(()=>reader('/api/cells',new URLSearchParams({cursor:encodeCursor('dynamodb:/api/cells',{arbitrary:{S:'x'}})})),/続き情報/);
});
test('空ページでも継続キーを落とさない',async()=>{
 const reader=make({get:async()=>({Item:summary}),query:async()=>({Items:[],LastEvaluatedKey:{measurementId:{S:'m'},deliveryId:{S:id},measuredAt:{S:row.measuredAt}}})});
 const result=await reader('/api/deliveries/'+id);assert.equal(result.measurements.length,0);assert(result.nextToken);
});
test('healthは全テーブルScanをせずに応答する',async()=>{assert.equal((await make()('/api/health')).queryMode,'delivery-index-pages');});
test('不存在は404、索引不足は503、権限不足は500となる',async()=>{
 const notFound=createQueryHandler(make({get:async()=>({}),query:async()=>({Items:[]})}));assert.equal((await notFound(event('/api/deliveries/missing'))).statusCode,404);
 const indexError=Object.assign(new Error('Index is backfilling'),{name:'ValidationException'});
 const unavailable=createQueryHandler(make({get:async()=>({Item:summary}),query:async()=>{throw indexError;}}));const result=await unavailable(event('/api/deliveries/'+id));assert.equal(result.statusCode,503);assert.match(JSON.parse(result.body).error,/ACTIVE/);
 const denied=createQueryHandler(make({get:async()=>{throw Object.assign(new Error('denied'),{name:'AccessDeniedException'});}}));assert.equal((await denied(event('/api/deliveries/'+id))).statusCode,500);
});
test('limit/offsetの不正を拒否し、累計件数を制限しない',async()=>{
 for(const text of ['limit=0','limit=1001','limit=abc','offset=3'])await assert.rejects(()=>make()('/api/deliveries',new URLSearchParams(text)),/limit|offset/);
});
test('構成側の1ページ件数を小さくしても画面の500件要求を処理できる',async()=>{
 const reader=make({maxPageItems:100,scan:async input=>{assert.equal(input.Limit,100);return {Items:[summary]};}});
 assert.equal((await reader('/api/deliveries',new URLSearchParams('limit=500'))).items.length,1);
});
test('ローカルでも同じcursor形式で続きが読める',()=>{
 const dataset={...fixture,analysis:[row,{...row,measurementId:'second'}]};
 const first=readQuery(dataset,'/api/deliveries/'+id,new URLSearchParams('limit=1'));
 const second=readQuery(dataset,'/api/deliveries/'+id,new URLSearchParams({limit:'1',cursor:first.nextToken}));
 assert.equal(first.measurements[0].measurementId,row.measurementId);assert.equal(second.measurements[0].measurementId,'second');assert.equal(second.nextToken,null);
});

const samplingRows=count=>Array.from({length:count},(_,i)=>({...row,measurementId:'m-'+String(i).padStart(5,'0'),measuredAt:new Date(Date.UTC(2026,9,12)+i*1000).toISOString()}));
function samplingReader(rows,{maxPageItems=100,summaryItem=summary}={}){
 const inputs=[];let readCount=0;
 const reader=make({maxPageItems,get:async()=>summaryItem?{Item:summaryItem}:{},query:async input=>{
  inputs.push(input);assert.equal(input.ExclusiveStartKey,undefined);assert.equal(input.FilterExpression,undefined);
  const values=input.ExpressionAttributeValues;
  let matches=rows.filter(row=>!values[':start']||(row.measuredAt>=values[':start'].S&&row.measuredAt<=values[':end'].S));
  if(!input.ScanIndexForward)matches=matches.slice().reverse();
  const items=matches.slice(0,input.Limit);readCount+=items.length;
  // 続きがあっても抽出処理がページを追わないことを確認する。
  return {Items:items,LastEvaluatedKey:{measurementId:{S:'do-not-follow'}}};
 }});
 return {reader,inputs,get readCount(){return readCount;}};
}

test('AWSは先頭・末尾と50時間帯だけをQueryし、6001件全体を読まずに500件を返す',async()=>{
 const rows=Array.from({length:6001},(_,i)=>({...row,measurementId:'m-'+String(i).padStart(5,'0'),measuredAt:new Date(Date.UTC(2026,9,12)+i*1000).toISOString()}));
 const db=samplingReader(rows);
 const params=new URLSearchParams('limit=500&sampling=uniform');
 const aws=await db.reader('/api/deliveries/'+id,params);
 const local=readQuery({...fixture,analysis:rows},'/api/deliveries/'+id,params);
 assert.equal(db.inputs.length,52);assert.equal(db.readCount,500);assert.equal(aws.measurements.length,500);
 assert.equal(aws.measurements[0].measurementId,rows[0].measurementId);assert.equal(aws.measurements.at(-1).measurementId,rows.at(-1).measurementId);
 assert(db.inputs.slice(2).every(input=>input.KeyConditionExpression.includes('BETWEEN')&&input.Limit<=10));
 assert.deepEqual(aws.measurements,local.measurements);
 assert.equal(aws.total,summary.sampleCount);assert.equal(aws.summary.sampleCount,summary.sampleCount);
 assert.equal(aws.nextToken,null);assert.equal(aws.sampling,'uniform');
});

test('空区間・同時刻・短時間・少数件でも重複せず上限を守る',async()=>{
 const regular=samplingRows(6001);
 const datasets=[[],[row],regular.slice(0,2),regular.filter((_,i)=>i<100||i===6000),regular.map(r=>({...r,measuredAt:row.measuredAt})),regular.map((r,i)=>({...r,measuredAt:new Date(Date.UTC(2026,9,12)+(i<3000?0:1)).toISOString()}))];
 for(const rows of datasets){
  for(const limit of [1,2,3,50,500]){
   const db=samplingReader(rows,{summaryItem:null});
   const result=await db.reader('/api/deliveries/'+id,new URLSearchParams({sampling:'uniform',limit:String(limit)}));
   if(!rows.length){assert.equal(result,null);continue;}
   assert(result.measurements.length<=limit);assert(db.readCount<=limit);
   assert.equal(new Set(result.measurements.map(r=>r.measurementId)).size,result.measurements.length);
   assert.equal(result.total,null);assert.equal(result.nextToken,null);
  }
 }
 const sparse=datasets[3],sample=timeSample(sparse,500);
 assert(sample.length<500);assert.equal(sample.at(-1).measurementId,sparse.at(-1).measurementId);
 const buckets=timeBuckets(regular[0].measuredAt,regular.at(-1).measuredAt,500);
 assert.equal(buckets.length,50);assert.equal(buckets.reduce((n,b)=>n+b.limit,2),500);
 for(let i=1;i<buckets.length;i++)assert(Date.parse(buckets[i].start)>Date.parse(buckets[i-1].end));
});

test('MAX_PAGE_ITEMSが少ない場合も各区間の続きを読まずに取得量を抑える',async()=>{
 const db=samplingReader(samplingRows(6001),{maxPageItems:1});
 const result=await db.reader('/api/deliveries/'+id,new URLSearchParams('sampling=uniform'));
 assert.equal(db.inputs.length,52);assert.equal(db.readCount,52);assert.equal(result.measurements.length,52);
 assert(db.inputs.every(input=>input.Limit===1));
});

test('不正な抽出モードとcursorの併用はAWS呼び出し前に拒否する',async()=>{
 for(const text of ['sampling=random','sampling=uniform&cursor=broken']){
  await assert.rejects(()=>make()('/api/deliveries/'+id,new URLSearchParams(text)),/sampling/);
  assert.throws(()=>readQuery(fixture,'/api/deliveries/'+id,new URLSearchParams(text)),/sampling/);
 }
 await assert.rejects(()=>make()('/api/cells',new URLSearchParams('sampling=uniform')),/配送詳細/);
});
