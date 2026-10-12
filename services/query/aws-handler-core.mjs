import {readQuery,validateRecords,InputError} from './local-contract.mjs';
import {IndexUnavailableError} from './dynamo-reader.mjs';
export function createHandler(loadDataset){
 return createQueryHandler(async(pathname,params)=>{
  const dataset=await loadDataset();
  return pathname==='/api/health'?{status:'ok',deployment:'aws',dataMode:dataset.mode,label:dataset.label}:readQuery(dataset,pathname,params);
 });
}
export function createQueryHandler(readRequest){
 return async event=>{
  const method=event?.requestContext?.http?.method??event?.httpMethod??'GET';
  const pathname=event?.rawPath??event?.path??'';
  const respond=(statusCode,data)=>({statusCode,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'},body:JSON.stringify(data),isBase64Encoded:false});
  if(method!=='GET')return respond(405,{error:'このAWS参照APIはGET専用です。'});
  const supported=pathname==='/api/health'||pathname==='/api/deliveries'||pathname==='/api/cells'||pathname.startsWith('/api/deliveries/');
  if(!supported)return respond(404,{error:'APIが見つかりません。'});
  try{
   const params=new URLSearchParams(event.rawQueryString??event.queryStringParameters??{});
   const result=await readRequest(pathname,params);
   return result?respond(200,result):respond(404,{error:'対象の配送が見つかりません。'});
  }catch(error){
   if(error instanceof InputError)return respond(400,{error:error.message});
   if(error instanceof IndexUnavailableError)return respond(503,{error:error.message});
   console.error('Query failure',{name:error.name,message:error.message});
   return respond(500,{error:'AWS参照処理に失敗しました。LambdaのCloudWatchログとテーブル設定を確認してください。'});
  }
 };
}
export function buildDynamoDataset(tables){
 return {mode:'dynamodb',label:'DynamoDBの解析結果（配送ごとの取得）',sources:{analysis:'DynamoDB',summaries:'DynamoDB',cells:'DynamoDB'},...Object.fromEntries(Object.entries(tables).map(([type,items])=>[type,validateRecords(type,items)]))};
}
