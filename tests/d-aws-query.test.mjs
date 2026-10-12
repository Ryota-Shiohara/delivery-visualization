import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHandler,buildDynamoDataset} from '../services/query/aws-handler-core.mjs';
const c=JSON.parse(await readFile(new URL('../data/samples/d-dashboard/c-shared-example.json',import.meta.url),'utf8'));
const handler=createHandler(async()=>c);
test('HTTP API v2イベントで既存画面に対応した応答を返す',async()=>{const result=await handler({rawPath:'/api/deliveries',requestContext:{http:{method:'GET'}}});assert.equal(result.statusCode,200);assert.equal(JSON.parse(result.body).items[0].summary.avgScore,92.5);});
test('配送詳細・区画・health・不存在・禁止POSTを処理する',async()=>{for(const path of ['/api/deliveries/sample-delivery-001','/api/cells','/api/health'])assert.equal((await handler({rawPath:path})).statusCode,200);assert.equal((await handler({rawPath:'/api/local/import'})).statusCode,404);assert.equal((await handler({rawPath:'/api/deliveries',requestContext:{http:{method:'POST'}}})).statusCode,405);});
test('DynamoDB JSONを表示用の通常JSONへ変換する',()=>{const tables={};for(const type of ['analysis','summaries','cells'])tables[type]=c[type].map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='string'?{S:v}:typeof v==='boolean'?{BOOL:v}:{N:String(v)}])));const dataset=buildDynamoDataset(tables);assert.equal(dataset.mode,'dynamodb');assert.equal(dataset.analysis[0].isImpact,false);assert.equal(dataset.summaries[0].avgScore,92.5);});
