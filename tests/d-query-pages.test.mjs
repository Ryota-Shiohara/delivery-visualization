import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDynamoReader} from '../services/query/dynamo-reader.mjs';
import {createQueryHandler} from '../services/query/aws-handler-core.mjs';
import {readQuery} from '../services/query/local-contract.mjs';
import {encodeCursor} from '../services/query/pagination.mjs';
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
