import {readFile} from 'node:fs/promises';
import {createHandler,collectScanPages,buildDynamoDataset} from './aws-handler-core.mjs';
const fixtures={};
let cache,expires=0;
async function loadDataset(){
 const mode=process.env.DATA_MODE??'demo';
 if(mode==='demo'||mode==='c-example'){
  if(!fixtures[mode])fixtures[mode]=JSON.parse(await readFile(new URL(mode==='demo'?'./demo.json':'./c-shared-example.json',import.meta.url),'utf8'));
  return fixtures[mode];
 }
 if(mode!=='dynamodb')throw new Error('DATA_MODEはdemo、c-example、dynamodbのいずれかにしてください。');
 if(cache&&Date.now()<expires)return cache;
 const names={analysis:process.env.ANALYSIS_TABLE,summaries:process.env.SUMMARY_TABLE,cells:process.env.CELL_TABLE};
 if(Object.values(names).some(name=>!name))throw new Error('ANALYSIS_TABLE、SUMMARY_TABLE、CELL_TABLEを設定してください。');
 const max=Number(process.env.MAX_TABLE_ITEMS??5000);if(!Number.isInteger(max)||max<1||max>5000)throw new Error('MAX_TABLE_ITEMSは1〜5000にしてください。');
 // 小規模仮環境ではLambdaのNode.jsランタイム内SDKを使用。
 // 最終統合では依存SDKを固定し、B/CとQuery・索引の設計を合意する。
 const {DynamoDBClient,ScanCommand}=await import('@aws-sdk/client-dynamodb');
 const client=new DynamoDBClient({});
 const entries=await Promise.all(Object.entries(names).map(async([type,TableName])=>[type,await collectScanPages(args=>client.send(new ScanCommand({TableName,...args})),max)]));
 cache=buildDynamoDataset(Object.fromEntries(entries));expires=Date.now()+30000;return cache;
}
export const handler=createHandler(loadDataset);
