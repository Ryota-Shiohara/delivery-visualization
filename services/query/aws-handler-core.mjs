import {readQuery,validateRecords,InputError} from './local-contract.mjs';
export class PrototypeLimitError extends Error {}
export async function collectScanPages(scan,maxRecords=5000){
 const items=[];let key;let pages=0;
 do{
  if(++pages>100)throw new PrototypeLimitError('Scanが100ページを超えました。検索条件・キー設計を見直してください。');
  const page=await scan({ExclusiveStartKey:key,Limit:Math.min(250,maxRecords-items.length+1)});
  items.push(...(page.Items??[]));
  if(items.length>maxRecords)throw new PrototypeLimitError(`仮環境の取得上限${maxRecords}件を超えています。Queryと索引を使う設計に切り替えてください。`);
  key=page.LastEvaluatedKey;
 }while(key&&Object.keys(key).length);
 return items;
}
export function createHandler(loadDataset){
 return async event=>{
  const method=event?.requestContext?.http?.method??event?.httpMethod??'GET';
  const pathname=event?.rawPath??event?.path??'';
  const respond=(statusCode,data)=>({statusCode,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'},body:JSON.stringify(data),isBase64Encoded:false});
  if(method!=='GET')return respond(405,{error:'このAWS参照APIはGET専用です。'});
  const supported=pathname==='/api/health'||pathname==='/api/deliveries'||pathname==='/api/cells'||pathname.startsWith('/api/deliveries/');
  if(!supported)return respond(404,{error:'APIが見つかりません。'});
  try{
   const dataset=await loadDataset();
   if(pathname==='/api/health')return respond(200,{status:'ok',deployment:'aws',dataMode:dataset.mode,label:dataset.label});
   const params=new URLSearchParams(event.rawQueryString??event.queryStringParameters??{});
   const result=readQuery(dataset,pathname,params);
   return result?respond(200,result):respond(404,{error:'対象の配送が見つかりません。'});
  }catch(error){
   if(error instanceof PrototypeLimitError)return respond(413,{error:error.message});
   if(error instanceof InputError)return respond(400,{error:error.message});
   console.error('Query failure',{name:error.name,message:error.message});
   return respond(500,{error:'AWS参照処理に失敗しました。LambdaのCloudWatchログとテーブル設定を確認してください。'});
  }
 };
}
export function buildDynamoDataset(tables){
 return {mode:'dynamodb',label:'DynamoDBの解析結果（仮取得・最大30秒キャッシュ）',sources:{analysis:'DynamoDB',summaries:'DynamoDB',cells:'DynamoDB'},...Object.fromEntries(Object.entries(tables).map(([type,items])=>[type,validateRecords(type,items)]))};
}
