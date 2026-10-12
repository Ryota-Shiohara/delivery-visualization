import {mkdir,readFile,writeFile,copyFile,cp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),destination=path.join(root,'.local/artifacts');
const stage=path.join(root,'.local/aws-build'),lambda=path.join(stage,'lambda'),web=path.join(stage,'web/dashboard');
await mkdir(lambda,{recursive:true});await mkdir(web,{recursive:true});
for(const name of ['index.mjs','aws-handler-core.mjs','local-contract.mjs'])await copyFile(path.join(root,'services/query',name),path.join(lambda,name));
for(const name of ['demo.json','c-shared-example.json'])await copyFile(path.join(root,'data/samples/d-dashboard',name),path.join(lambda,name));
for(const name of ['index.html','app.js','styles.css','config.js'])await copyFile(path.join(root,'apps/dashboard',name),path.join(web,name));
await cp(path.join(root,'apps/dashboard/vendor'),path.join(web,'vendor'),{recursive:true});
await writeFile(path.join(web,'config.js'),'// YOUR_API_IDを自分のHTTP APIのURLに置き換えてください。\nwindow.DASHBOARD_CONFIG = {\n  apiBaseUrl: "https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com",\n  deployment: "aws"\n};\n');
const templates=path.join(destination,'D担当_AWS設定テンプレート');await mkdir(path.join(templates,'dynamodb-items'),{recursive:true});
await writeFile(path.join(templates,'s3-public-read-policy.json'),JSON.stringify({Version:'2012-10-17',Statement:[{Sid:'ReadOnlyDashboardFiles',Effect:'Allow',Principal:'*',Action:'s3:GetObject',Resource:'arn:aws:s3:::YOUR_BUCKET_NAME/dashboard/*'}]},null,2)+'\n');
await writeFile(path.join(templates,'test-deliveries.json'),JSON.stringify({version:'2.0',rawPath:'/api/deliveries',rawQueryString:'',requestContext:{http:{method:'GET'}}},null,2)+'\n');
const c=JSON.parse(await readFile(path.join(root,'data/samples/d-dashboard/c-shared-example.json'),'utf8'));
for(const [type,name]of [['analysis','analysis'],['summaries','summary'],['cells','cell']]){
 const converted=Object.fromEntries(Object.entries(c[type][0]).map(([key,value])=>[key,value===null?{NULL:true}:typeof value==='boolean'?{BOOL:value}:typeof value==='number'?{N:String(value)}:{S:value}]));
 await writeFile(path.join(templates,'dynamodb-items',name+'.json'),JSON.stringify(converted,null,2)+'\n');
}
console.log(`Lambda用：${lambda}\nS3用：${web}\n設定テンプレート：${templates}`);
