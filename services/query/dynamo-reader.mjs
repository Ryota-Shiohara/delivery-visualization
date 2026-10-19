import {validateRecords,InputError} from './local-contract.mjs';
import {pageLimit,encodeCursor,decodeCursor,samplingLimit,timeBuckets,sortMeasurements} from './pagination.mjs';
export class IndexUnavailableError extends Error {}
const metadata={mode:'dynamodb',label:'配送・路面の評価',sources:{analysis:'DynamoDB',summaries:'DynamoDB',cells:'DynamoDB'}};
function startKey(params,scope,names){
 const key=decodeCursor(params.get('cursor'),scope);
 if(!key)return undefined;
 if(Object.keys(key).length!==names.length||names.some(name=>!key[name]||Object.keys(key[name]).length!==1||typeof key[name].S!=='string'||!key[name].S||key[name].S.length>2048))throw new InputError('ページの続き情報が不正です。');
 return key;
}
export function createDynamoReader({scan,query,get,names,indexName='DeliveryTimeIndex',impactIndexName='ImpactDeliveryTimeIndex',maxPageItems=1000}){
 if([names.analysis,names.summaries,names.cells].some(name=>!name))throw new Error('解析結果・配送集計・路面区画のテーブル名を設定してください。');
 if(!/^[A-Za-z0-9_.-]{3,255}$/.test(indexName))throw new Error('ANALYSIS_INDEXの索引名が不正です。');
 if(!/^[A-Za-z0-9_.-]{3,255}$/.test(impactIndexName))throw new Error('IMPACT_INDEXの索引名が不正です。');
 if(!Number.isInteger(maxPageItems)||maxPageItems<1||maxPageItems>1000)throw new Error('MAX_PAGE_ITEMSは1〜1000にしてください。');
 return async(pathname,params=new URLSearchParams())=>{
  if(pathname==='/api/health')return {status:'ok',deployment:'aws',dataMode:'dynamodb',queryMode:'delivery-index-pages'};
  const limit=pageLimit(params,maxPageItems);
  const sampleLimit=samplingLimit(params);
  const impacts=params.get('impacts')==='only';
  if(params.has('impacts')&&(!impacts||!pathname.startsWith('/api/deliveries/')||sampleLimit!==null))throw new InputError('impacts=onlyは配送詳細でsamplingと併用せず指定してください。');
  if(sampleLimit!==null&&!pathname.startsWith('/api/deliveries/'))throw new InputError('samplingは配送詳細で指定してください。');
  if(params.has('offset'))throw new InputError('offsetではなく、応答のnextTokenをcursorに指定してください。');
  if(pathname==='/api/deliveries'||pathname==='/api/cells'){
   const type=pathname==='/api/deliveries'?'summaries':'cells',scope='dynamodb:'+pathname;
   const key=startKey(params,scope,[type==='summaries'?'deliveryId':'cellId']);
   const page=await scan({TableName:names[type],Limit:limit,...(key?{ExclusiveStartKey:key}:{})});
   const rows=validateRecords(type,page.Items??[]);
   const items=type==='summaries'?rows.map(summary=>({deliveryId:summary.deliveryId,summary})):rows;
   return {items,nextToken:encodeCursor(scope,page.LastEvaluatedKey),...(type==='cells'?{scope:'全配送の地点集計'}:{}),meta:metadata};
  }
  if(pathname.startsWith('/api/deliveries/')){
   let id;try{id=decodeURIComponent(pathname.slice('/api/deliveries/'.length));}catch{throw new InputError('配送IDが不正です。');}
   if(!id||id.length>512)throw new InputError('配送IDが不正です。');
   const deliveryKey=impacts?'impactDeliveryId':'deliveryId',selectedIndex=impacts?impactIndexName:indexName;
   const scope='dynamodb:delivery:'+id+(impacts?':impacts':''),key=startKey(params,scope,['measurementId',deliveryKey,'measuredAt']);
   if(key&&key[deliveryKey].S!==id)throw new InputError('別の配送の続き情報は使えません。');
   const summaryPage=await get({TableName:names.summaries,Key:{deliveryId:{S:id}}});
   const summary=summaryPage.Item?validateRecords('summaries',[summaryPage.Item])[0]:null;
   const queryPage=async options=>{
    let page;
    try{page=await query({TableName:names.analysis,IndexName:selectedIndex,KeyConditionExpression:'#delivery = :delivery',ExpressionAttributeNames:{'#delivery':deliveryKey},ExpressionAttributeValues:{':delivery':{S:id}},ScanIndexForward:true,...options});}
    catch(error){
     if(error.name==='ResourceNotFoundException'||(error.name==='ValidationException'&&/index|backfill/i.test(error.message)))throw new IndexUnavailableError(`解析結果テーブルの${selectedIndex}を作成し、ACTIVEになってから再読み込みしてください。`);
     throw error;
    }
    const rows=validateRecords('analysis',page.Items??[]);
    if(rows.some(row=>row.deliveryId!==id))throw new Error('索引から別の配送の計測が返されました。');
    if(impacts&&rows.some(row=>!row.isImpact||row.impactDeliveryId!==id))throw new Error('衝撃索引から対象外の計測が返されました。');
    return {...page,rows};
   };
   if(sampleLimit!==null){
    const first=await queryPage({Limit:1});
    const selected=[...first.rows];
    if(selected.length&&sampleLimit>1){
     const last=await queryPage({Limit:1,ScanIndexForward:false});
     selected.push(...last.rows);
     if(last.rows.length&&last.rows[0].measurementId!==first.rows[0].measurementId){
      const buckets=timeBuckets(first.rows[0].measuredAt,last.rows[0].measuredAt,sampleLimit);
      // 問い合わせは最大4並列。各時間帯は1ページだけ読み、続きは追わない。
      let next=0;
      await Promise.all(Array.from({length:Math.min(4,buckets.length)},async()=>{
       while(next<buckets.length){
        const bucket=buckets[next++];
        const part=await queryPage({Limit:Math.min(bucket.limit,maxPageItems),KeyConditionExpression:'#delivery = :delivery AND #time BETWEEN :start AND :end',ExpressionAttributeNames:{'#delivery':'deliveryId','#time':'measuredAt'},ExpressionAttributeValues:{':delivery':{S:id},':start':{S:bucket.start},':end':{S:bucket.end}}});
        selected.push(...part.rows);
       }
      }));
     }
    }
    if(!summary&&!selected.length)return null;
    return {deliveryId:id,summary,measurements:sortMeasurements(selected),total:summary?.sampleCount??null,nextToken:null,sampling:'uniform',meta:metadata};
   }
   const page=await queryPage({Limit:limit,...(key?{ExclusiveStartKey:key}:{})});
   if(!summary&&!page.rows.length&&!page.LastEvaluatedKey)return null;
   return {deliveryId:id,summary,measurements:page.rows,total:(impacts?summary?.impactCount:summary?.sampleCount)??null,nextToken:encodeCursor(scope,page.LastEvaluatedKey),...(impacts?{impacts:'only'}:{}),meta:metadata};
  }
  return null;
 };
}
