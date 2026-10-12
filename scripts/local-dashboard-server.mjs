import http from 'node:http';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {TABLES,validateRecords,readQuery,InputError,datasetMetadata} from '../services/query/local-contract.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),app=path.join(root,'apps/dashboard');
const localDir=process.env.D_LOCAL_DATA_DIR??path.join(root,'data/processed/d-local'),statePath=path.join(localDir,'state.json');
const fixture=async mode=>JSON.parse(await readFile(path.join(root,'data/samples/d-dashboard',mode==='c-example'?'c-shared-example.json':'demo.json'),'utf8'));
let dataset;
try{dataset=JSON.parse(await readFile(statePath,'utf8'));for(const type of Object.keys(TABLES))validateRecords(type,dataset[type]);}catch{dataset=await fixture('demo');}
async function persist(next){await mkdir(localDir,{recursive:true});await writeFile(statePath,JSON.stringify(next,null,2));dataset=next;}
const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function body(req){let parts=[],size=0;for await(const chunk of req){size+=chunk.length;if(size>12*1024*1024)throw new InputError('ファイルは12MB以内にしてください。');parts.push(chunk);}try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new InputError('JSONを読み取れませんでした。形式を確認してください。');}}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};
let mutation=Promise.resolve();
const server=http.createServer(async(req,res)=>{
 try{
  const host=req.headers.host;
  if(!host||!/^127\.0\.0\.1:\d+$/.test(host)&&!/^localhost:\d+$/.test(host)){send(res,403,{error:'ローカル接続専用です。'});return;}
  const url=new URL(req.url,`http://${host}`);
  if(url.pathname==='/api/health'){send(res,200,{status:'ok',localOnly:true,meta:datasetMetadata(dataset)});return;}
  if(url.pathname==='/api/local/export'&&req.method==='GET'){send(res,200,dataset);return;}
  if(url.pathname.startsWith('/api/local/')&&req.method==='POST'){
   if(req.headers.origin&&req.headers.origin!==`http://${host}`){send(res,403,{error:'同じローカル画面から操作してください。'});return;}
   const input=await body(req);
   const task=mutation.catch(()=>{}).then(async()=>{
    if(url.pathname==='/api/local/reset'){
     if(!['demo','c-example','empty'].includes(input.mode))throw new InputError('データモードが不正です。');
     const next=input.mode==='empty'?{mode:'imported',label:'取り込み用・空のデータ',sources:{analysis:'未取り込み',summaries:'未取り込み',cells:'未取り込み'},analysis:[],summaries:[],cells:[]}:await fixture(input.mode);
     await persist(next);return{ok:true,meta:datasetMetadata(dataset)};
    }
    if(url.pathname==='/api/local/import'){
     const next=structuredClone(dataset),types=input.type==='bundle'?Object.keys(TABLES):[input.type];
     for(const type of types){if(!TABLES[type])throw new InputError('取り込み先が不正です。');const content=input.type==='bundle'?input.records?.[type]:input.records;next[type]=validateRecords(type,content);next.sources[type]='取り込みJSON';}
     next.mode='imported';next.label='取り込みデータ（種類別の出所を確認）';
     await persist(next);return{ok:true,imported:Object.fromEntries(types.map(type=>[TABLES[type],next[type].length])),meta:datasetMetadata(next)};
    }
    throw new InputError('操作が見つかりません。');
   });mutation=task;send(res,200,await task);return;
  }
  if(url.pathname.startsWith('/api/')){
   if(req.method!=='GET'){send(res,405,{error:'この参照APIはGET専用です。'});return;}
   const result=readQuery(dataset,url.pathname,url.searchParams);send(res,result?200:404,result??{error:'対象の配送・APIが見つかりません。'});return;
  }
  if(req.method!=='GET'&&req.method!=='HEAD'){send(res,405,{error:'GET専用です。'});return;}
  let resource;try{resource=decodeURIComponent(url.pathname);}catch{send(res,400,{error:'URLが不正です。'});return;}
  const filepath=path.resolve(app,'.'+(resource==='/'?'/index.html':resource));
  if(!filepath.startsWith(app+path.sep)){send(res,403,{error:'アクセスできません。'});return;}
  const info=await stat(filepath);if(!info.isFile()){send(res,404,{error:'ファイルがありません。'});return;}
  res.writeHead(200,{'Content-Type':mime[path.extname(filepath)]??'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
  res.end(req.method==='HEAD'?undefined:await readFile(filepath));
 }catch(error){send(res,error instanceof InputError?400:error.code==='ENOENT'?404:500,{error:error instanceof InputError?error.message:error.code==='ENOENT'?'ファイルがありません。':'ローカル処理でエラーが発生しました。'});if(!(error instanceof InputError)&&error.code!=='ENOENT')console.error(error);}
});
const port=Number(process.env.DASHBOARD_PORT??4173);
server.listen(port,'127.0.0.1',()=>console.log(`D担当のローカル仮環境：http://127.0.0.1:${server.address().port}\nAWS未接続 / Ctrl+Cで終了 / 保存先 data/processed/d-local`));
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`ポート${port}が使用中です。既存の画面を確認するかDASHBOARD_PORTを変更してください。`:error);process.exitCode=1;});
