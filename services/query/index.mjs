import {readFile} from 'node:fs/promises';
import {createQueryHandler} from './aws-handler-core.mjs';
import {readQuery} from './local-contract.mjs';
import {createDynamoReader} from './dynamo-reader.mjs';
const fixtures={};
let reader,configuration;
async function route(pathname,params){
 const mode=process.env.DATA_MODE??'demo';
 if(mode==='demo'||mode==='c-example'){
  if(!fixtures[mode])fixtures[mode]=JSON.parse(await readFile(new URL(mode==='demo'?'./demo.json':'./c-shared-example.json',import.meta.url),'utf8'));
  if(pathname==='/api/health')return {status:'ok',deployment:'aws',dataMode:mode};
  return readQuery(fixtures[mode],pathname,params);
 }
 if(mode!=='dynamodb')throw new Error('DATA_MODEはdemo、c-example、dynamodbのいずれかにしてください。');
 const names={analysis:process.env.ANALYSIS_TABLE,summaries:process.env.SUMMARY_TABLE,cells:process.env.CELL_TABLE};
 const indexName=process.env.ANALYSIS_INDEX??'DeliveryTimeIndex',maxPageItems=Number(process.env.MAX_PAGE_ITEMS??1000);
 const impactIndexName=process.env.IMPACT_INDEX??'ImpactDeliveryTimeIndex';
 const signature=JSON.stringify({names,indexName,impactIndexName,maxPageItems});
 if(!reader||configuration!==signature){
  const {DynamoDBClient,ScanCommand,QueryCommand,GetItemCommand}=await import('@aws-sdk/client-dynamodb');
  const client=new DynamoDBClient({});
  reader=createDynamoReader({names,indexName,impactIndexName,maxPageItems,scan:input=>client.send(new ScanCommand(input)),query:input=>client.send(new QueryCommand(input)),get:input=>client.send(new GetItemCommand(input))});
  configuration=signature;
 }
 return reader(pathname,params);
}
export const handler=createQueryHandler(route);
