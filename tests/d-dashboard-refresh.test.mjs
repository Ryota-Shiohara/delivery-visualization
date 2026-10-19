import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../apps/dashboard/app.js',import.meta.url),'utf8');
async function dashboard(respond,{impactsRespond=()=>({impacts:'only',measurements:[],nextToken:null})}={}){
 const elements=new Map(),listeners={},timers=new Map(),calls=[],renders=[];
 let nextTimer=0,now=Date.UTC(2026,9,19);
 class ClockDate extends Date{static now(){return now;}}
 const document={hidden:false,getElementById(id){
  if(!elements.has(id))elements.set(id,{disabled:false,hidden:false,value:'',style:{},classList:{toggle(){}},setAttribute(){},addEventListener(){}});
  return elements.get(id);
 },querySelectorAll(){return [];},addEventListener(name,callback){listeners[name]=callback;}};
 const window={DASHBOARD_CONFIG:{},addEventListener(name,callback){listeners[name]=callback;}};
 const context=vm.createContext({document,window,AbortSignal,URL,Intl,console,Date:ClockDate,
  setTimeout(callback,ms){const id=++nextTimer;timers.set(id,{callback,ms});return id;},
  clearTimeout(id){timers.delete(id);},
  async fetch(path,options){calls.push({path,options});const data=await (path.includes('impacts=only')?impactsRespond(path):respond(path));return {ok:!data.error,status:data.status??200,json:async()=>data};}
 });
 const api=await vm.runInContext(`(async()=>{${source.replace('initializeMap();await reload();scheduleRefresh();','')}
 renderList=()=>{};renderCells=()=>{};renderDetail=preserve=>renders.push(preserve);
 return {state,reload,refreshDashboard,scheduleRefresh,loadCollectionMore,loadDelivery,setMapMode,loadAllMap};})()`,vm.createContext({...context,renders}));
 Object.assign(api.state,{selectedId:'A',deliveries:[{deliveryId:'A'}],cells:[],meta:{label:'old'},
  detail:{deliveryId:'A',measurements:[{measurementId:'old'}],summary:{sampleCount:1},nextToken:null},page:2,eventsOnly:false});
 return {...api,elements,document,listeners,timers,calls,renders,advance(ms){now+=ms;}};
}
const response=path=>path.startsWith('/api/deliveries?')?{items:[{deliveryId:'A'}],meta:{label:'new'},nextToken:null}:
 path.startsWith('/api/cells?')?{items:[{cellId:'cell',sampleCount:2}],nextToken:null}:
 {deliveryId:'A',summary:{sampleCount:2},measurements:[{measurementId:'new'}],nextToken:null};

test('自動更新で一覧・区画・配送詳細を更新し、ページと地図表示を保持する',async()=>{
 const app=await dashboard(response);await app.refreshDashboard();
 assert.equal(app.state.detail.measurements[0].measurementId,'new');
 assert.equal(app.state.detail.summary.sampleCount,2);assert.equal(app.state.cells[0].sampleCount,2);
 assert.equal(app.state.meta.label,'new');assert.equal(app.state.selectedId,'A');
 assert.equal(app.state.page,2);assert.equal(app.state.eventsOnly,false);assert.deepEqual(app.renders,[true]);
 assert(app.calls.every(({options})=>options.cache==='no-store'&&options.signal));
});
test('通信エラーで表示を保持し、次回の自動取得で回復する',async()=>{
 let fail=true;const app=await dashboard(path=>{if(fail)throw new Error('offline');return response(path);});
 const previous=app.state.detail;await app.refreshDashboard();assert.equal(app.state.detail,previous);
 assert.match(app.elements.get('alert').textContent,/前回取得/);
 fail=false;await app.refreshDashboard();assert.equal(app.state.detail.summary.sampleCount,2);
 assert.equal(app.elements.get('alert').hidden,true);
});
test('更新中の選択変更を古い応答で上書きしない',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);
 const app=await dashboard(async path=>{await pending;return response(path);});
 const refresh=app.refreshDashboard();app.state.selectedId='B';app.state.loadToken++;
 release();await refresh;assert.equal(app.state.selectedId,'B');assert.equal(app.state.meta.label,'old');
});
test('ページの追加取得中に自動更新結果を反映しない',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);
 const app=await dashboard(async path=>{await pending;return response(path);});
 const refresh=app.refreshDashboard();app.state.detailBusy=true;release();await refresh;
 assert.equal(app.state.detail.measurements[0].measurementId,'old');
});
test('非表示タブでは取得せず、タブへ戻ると取得して次回を予約する',async()=>{
 const app=await dashboard(response);app.document.hidden=true;
 await app.refreshDashboard();app.scheduleRefresh();assert.equal(app.calls.length,0);assert.equal(app.timers.size,0);
 app.document.hidden=false;await app.listeners.visibilitychange();
 // visibilitychangeのイベントハンドラーは非同期取得を開始する。
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(app.state.meta.label,'new');assert.equal([...app.timers.values()][0].ms,5000);
 app.document.hidden=true;app.listeners.visibilitychange();assert.equal(app.timers.size,0);
});
test('取得処理を重複させず、完了後5秒で次回更新する',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);
 const app=await dashboard(async path=>{await pending;return response(path);});
 app.scheduleRefresh();const timer=[...app.timers.values()][0];app.timers.clear();
 const refresh=timer.callback();await app.refreshDashboard();assert.equal(app.calls.length,2);
 assert.equal(app.timers.size,0);release();await refresh;assert.equal(app.calls.length,4);
 assert.equal([...app.timers.values()][0].ms,5000);
});
test('初回取得と自動更新は全区間の最大500件を要求する',async()=>{
 const app=await dashboard(path=>{
  if(!path.startsWith('/api/deliveries/A?'))return response(path);
  const params=new URL(path,'http://localhost').searchParams;
  assert.equal(params.get('sampling'),'uniform');assert.equal(params.get('limit'),'500');assert.equal(params.has('cursor'),false);
  return {deliveryId:'A',measurements:[{measurementId:'first'},{measurementId:'last'}],summary:{sampleCount:6001},sampling:'uniform',nextToken:null};
 });
 await app.loadDelivery('A');await app.refreshDashboard();
 assert.equal(app.calls.filter(({path})=>path.startsWith('/api/deliveries/A?')&&path.includes('sampling=uniform')).length,2);
 assert.deepEqual(Array.from(app.state.detail.measurements,row=>row.measurementId),['first','last']);
 assert.equal(app.state.detail.nextToken,null);
});
test('追加読み込み済みの一覧の範囲と選択を保持する',async()=>{
 const app=await dashboard(path=>{
  if(!path.startsWith('/api/deliveries?'))return response(path);
  return path.includes('cursor=next')?{items:[{deliveryId:'A'}],meta:{label:'new'},nextToken:null}:
   {items:[{deliveryId:'B'}],meta:{label:'new'},nextToken:'next'};
 });
 app.state.deliveries=[{deliveryId:'B'},{deliveryId:'A'}];await app.refreshDashboard();
 assert.equal(app.state.deliveries.length,2);assert.equal(app.state.selectedId,'A');
});
test('削除された配送は次の配送に切り替える',async()=>{
 const app=await dashboard(path=>path.startsWith('/api/deliveries?')?{items:[{deliveryId:'B'}],meta:{label:'new'}}:
  path.startsWith('/api/deliveries/A?')?{error:'missing',status:404}:
  path.startsWith('/api/deliveries/B?')?{deliveryId:'B',measurements:[],summary:{sampleCount:0}}:response(path));
 await app.refreshDashboard();assert.equal(app.state.selectedId,'B');assert.equal(app.state.detail.deliveryId,'B');
 assert.equal(app.state.page,0);assert.deepEqual(app.renders,[false]);
});

const mapDetail=id=>({deliveryId:id,measurements:[{measurementId:id+'-point',latitude:35,longitude:139}],nextToken:null});
test('全配送モードは一覧の全ページを読み、配送ごとの抽出APIを2並列以内で取得する',async()=>{
 let active=0,maximum=0;
 const app=await dashboard(async path=>{
  if(path.startsWith('/api/deliveries?'))return path.includes('cursor=next')?
   {items:[{deliveryId:'C'},{deliveryId:'D'}],nextToken:null}:
   {items:[{deliveryId:'A'},{deliveryId:'B'}],nextToken:'next'};
  active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setImmediate(resolve));active--;
  assert.match(path,/limit=500&sampling=uniform/);
  return mapDetail(path.split('/')[3].split('?')[0]);
 });
 await app.setMapMode('all');
 assert.equal(app.state.mapMode,'all');assert.equal(app.state.allMapDetails.length,4);
 assert.equal(app.state.deliveries.length,4);assert.equal(app.state.listCursor,null);
 assert.equal(maximum,2);assert.equal(app.state.detail.deliveryId,'A');assert.equal(app.state.allMapBusy,false);
 assert.match(app.elements.get('map-status').textContent,/4配送を取得・GPSあり4配送/);
 const calls=app.calls.length;await app.setMapMode('selected');assert.equal(app.calls.length,calls);
});

test('全配送取得中に選択中モードへ戻ると古い応答を反映せず、追加取得も停止する',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);
 const app=await dashboard(async path=>{await pending;return {items:[{deliveryId:'B'}],nextToken:null};});
 const loading=app.setMapMode('all');await app.setMapMode('selected');release();await loading;
 assert.equal(app.state.mapMode,'selected');assert.equal(app.state.allMapBusy,false);
 assert.equal(app.state.allMapDetails.length,0);assert.equal(app.state.deliveries[0].deliveryId,'A');
 assert.equal(app.calls.length,1);
});

test('全配送の取得失敗では前回の全配送表示を保持し、次の取得で回復する',async()=>{
 let fail=true;
 const app=await dashboard(path=>{
  if(path.startsWith('/api/deliveries?'))return {items:[{deliveryId:'A'}],nextToken:null};
  if(fail)throw new Error('offline');return mapDetail('A');
 });
 const previous=[mapDetail('old')];app.state.allMapDetails=previous;
 await app.setMapMode('all');assert.equal(app.state.allMapDetails,previous);assert.equal(app.state.allMapBusy,false);
 assert.match(app.elements.get('map-status').textContent,/取得に失敗.*前回/);
 fail=false;await app.loadAllMap();assert.equal(app.state.allMapDetails[0].deliveryId,'A');assert.equal(app.state.allMapError,'');
});

test('全配送モードの自動更新では新しい配送も取得する',async()=>{
 const app=await dashboard(path=>{
  if(path.startsWith('/api/deliveries?'))return {items:[{deliveryId:'A'},{deliveryId:'B'}],meta:{label:'new'},nextToken:null};
  if(path.startsWith('/api/cells?'))return {items:[],nextToken:null};
  return mapDetail(path.split('/')[3].split('?')[0]);
 });
 app.state.mapMode='all';app.state.allMapDetails=[mapDetail('A')];
 await app.refreshDashboard();
 assert.deepEqual(Array.from(app.state.allMapDetails,row=>row.deliveryId),['A','B']);
 assert.equal(app.state.selectedId,'A');assert.equal(app.state.detail.deliveryId,'A');
});

test('配送なし・GPSなし・取得途中で削除された配送を区別する',async()=>{
 const empty=await dashboard(()=>({items:[],nextToken:null}));await empty.setMapMode('all');
 assert.equal(empty.state.allMapDetails.length,0);assert.match(empty.elements.get('map-status').textContent,/0配送を取得/);
 const app=await dashboard(path=>path.startsWith('/api/deliveries?')?{items:[{deliveryId:'A'},{deliveryId:'B'}],nextToken:null}:
  path.includes('/A?')?{deliveryId:'A',measurements:[]}:{error:'missing',status:404});
 await app.setMapMode('all');assert.equal(app.state.allMapDetails.length,1);
 assert.match(app.elements.get('map-status').textContent,/GPS座標がありません/);
});

const versionedSummary=(version=0)=>({updatedAt:new Date(Date.UTC(2026,9,19)+version*1000).toISOString(),sampleCount:100+version,impactCount:0,avgScore:90,maxVibration:4,maxTilt:10});
function deliveryResponses(getItems){
 return path=>{
  const items=getItems();
  if(path.startsWith('/api/deliveries?'))return {items,nextToken:null,meta:{label:'test'}};
  if(path.startsWith('/api/cells?'))return {items:[],nextToken:null};
  const id=decodeURIComponent(path.split('/')[3].split('?')[0]);
  return {...mapDetail(id),summary:items.find(item=>item.deliveryId===id)?.summary};
 };
}
const detailCalls=app=>app.calls.filter(({path})=>/^\/api\/deliveries\//.test(path)&&path.includes('sampling=uniform'));

test('全配送の更新がなければ一覧と区画だけ取得し、更新された配送と新規配送だけ再取得する',async()=>{
 let items=['A','B','C'].map(deliveryId=>({deliveryId,summary:versionedSummary()}));
 const app=await dashboard(deliveryResponses(()=>items));
 app.state.deliveries=items;
 await app.loadDelivery('A');await app.setMapMode('all');
 assert.equal(detailCalls(app).length,3); // 選択中のAも重複取得しない。
 const before=app.state.allMapDetails.find(row=>row.deliveryId==='A');
 app.calls.length=0;await app.refreshDashboard();
 assert.equal(detailCalls(app).length,0);assert.equal(app.calls.filter(({path})=>path.startsWith('/api/deliveries?')).length,1);
 items=[items[0],{deliveryId:'B',summary:versionedSummary(1)},{deliveryId:'D',summary:versionedSummary()}];
 app.calls.length=0;await app.refreshDashboard();
 assert.deepEqual(detailCalls(app).map(({path})=>path.split('/')[3].split('?')[0]).sort(),['B','D']);
 assert.deepEqual(Array.from(app.state.allMapDetails,row=>row.deliveryId),['A','B','D']);
 assert.equal(app.state.allMapDetails[0],before);assert.equal(app.state.detail,before);
 items.push({deliveryId:'C',summary:versionedSummary()});app.calls.length=0;await app.refreshDashboard();
 assert.equal(detailCalls(app).length,1);assert.match(detailCalls(app)[0].path,/\/C\?/);
});

test('選択中の配送も更新がなければ再利用し、同じ更新日時でも件数が変われば取得する',async()=>{
 let summary=versionedSummary();const app=await dashboard(deliveryResponses(()=>[{deliveryId:'A',summary}]));
 app.state.deliveries=[{deliveryId:'A',summary}];
 await app.loadDelivery('A');app.calls.length=0;await app.refreshDashboard();assert.equal(detailCalls(app).length,0);
 summary={...summary,sampleCount:101};await app.refreshDashboard();assert.equal(detailCalls(app).length,1);
 const detail=app.state.detail;await app.setMapMode('all');assert.equal(detailCalls(app).length,1);assert.equal(app.state.detail,detail);
});

test('初回と更新直後は10秒後に索引を再確認し、その後は取得から60秒で再確認する',async()=>{
 let summary=versionedSummary();const app=await dashboard(deliveryResponses(()=>[{deliveryId:'A',summary}]));
 app.state.deliveries=[{deliveryId:'A',summary}];
 await app.loadDelivery('A');app.calls.length=0;
 app.advance(5000);await app.refreshDashboard();assert.equal(detailCalls(app).length,0);
 app.advance(5000);await app.refreshDashboard();assert.equal(detailCalls(app).length,1);
 app.calls.length=0;app.advance(59000);await app.refreshDashboard();assert.equal(detailCalls(app).length,0);
 app.advance(1000);await app.refreshDashboard();assert.equal(detailCalls(app).length,1);
 summary=versionedSummary(1);app.calls.length=0;await app.refreshDashboard();assert.equal(detailCalls(app).length,1);
 app.calls.length=0;app.advance(10000);await app.refreshDashboard();assert.equal(detailCalls(app).length,1);
 app.calls.length=0;await app.refreshDashboard();assert.equal(detailCalls(app).length,0);
});

test('全配送の一部の取得失敗を更新済みとして記録せず、次回に取り直す',async()=>{
 let summary=versionedSummary(),fail=false;
 const respond=deliveryResponses(()=>['A','B'].map(deliveryId=>({deliveryId,summary})));
 const app=await dashboard(path=>{if(fail&&path.startsWith('/api/deliveries/B?'))throw new Error('offline');return respond(path);});
 await app.setMapMode('all');const previous=app.state.allMapDetails;
 summary=versionedSummary(1);fail=true;app.calls.length=0;await app.refreshDashboard();
 assert.equal(app.state.allMapDetails,previous);assert.match(app.state.allMapError,/取得に失敗/);
 fail=false;app.calls.length=0;await app.refreshDashboard();
 assert.equal(detailCalls(app).length,2);assert.equal(app.state.allMapError,'');
 app.calls.length=0;await app.refreshDashboard();assert.equal(detailCalls(app).length,0);
});

test('更新日時が欠けた配送ではキャッシュ判定をせず再取得する',async()=>{
 const app=await dashboard(deliveryResponses(()=>[{deliveryId:'A',summary:{sampleCount:1}}]));
 await app.loadDelivery('A');app.calls.length=0;await app.refreshDashboard();assert.equal(detailCalls(app).length,1);
});

test('手動更新ではキャッシュを破棄し、全配送でも選択中の配送を重複取得しない',async()=>{
 const items=['A','B'].map(deliveryId=>({deliveryId,summary:versionedSummary()}));
 const app=await dashboard(deliveryResponses(()=>items));await app.setMapMode('all');
 app.calls.length=0;await app.reload();assert.equal(detailCalls(app).length,2);
 assert.equal(app.state.allMapDetails.length,2);assert.equal(app.elements.get('reload').disabled,false);
});

test('取得中にモードを変更した結果をキャッシュへ保存しない',async()=>{
 const items=[{deliveryId:'A',summary:versionedSummary()}];let release,entered;
 const pending=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const respond=deliveryResponses(()=>items);
 const app=await dashboard(async path=>{if(path.startsWith('/api/deliveries/A?')){entered();await pending;}return respond(path);});
 const loading=app.setMapMode('all');await started;await app.setMapMode('selected');release();await loading;
 app.calls.length=0;await app.setMapMode('all');assert.equal(detailCalls(app).length,1);
});

test('衝撃は全ページを取得し、軌跡の抽出にない衝撃も保持する',async()=>{
 const app=await dashboard(response,{impactsRespond:path=>path.includes('cursor=next')?
  {impacts:'only',measurements:[{measurementId:'hidden-impact',isImpact:true}],nextToken:null}:
  {impacts:'only',measurements:[],nextToken:'next'}});
 await app.loadDelivery('A');
 assert.equal(app.state.detail.measurements[0].measurementId,'new');
 assert.equal(app.state.detail.impacts[0].measurementId,'hidden-impact');
 assert.equal(app.calls.filter(({path})=>path.includes('impacts=only')).length,2);
});

test('衝撃取得だけの失敗は軌跡を保持し、10秒後に再取得して回復する',async()=>{
 let failed=true;
 const summary=versionedSummary();
 const app=await dashboard(deliveryResponses(()=>[{deliveryId:'A',summary}]),{impactsRespond:()=>failed?{error:'index unavailable',status:503}:{impacts:'only',measurements:[],nextToken:null}});
 app.state.deliveries=[{deliveryId:'A',summary}];await app.loadDelivery('A');
 assert.equal(app.state.detail.measurements.length,1);assert.match(app.state.detail.impactError,/index unavailable/);
 failed=false;app.advance(10000);await app.refreshDashboard();assert.equal(app.state.detail.impactError,undefined);assert.equal(app.state.detail.impacts.length,0);
});

test('衝撃の続き情報が循環したら全件取得成功とせず失敗を表示する',async()=>{
 const app=await dashboard(response,{impactsRespond:()=>({impacts:'only',measurements:[],nextToken:'same'})});
 await app.loadDelivery('A');assert.match(app.state.detail.impactError,/続きを取得/);assert.equal(app.state.detail.impacts,undefined);
});


test('旧APIがimpacts指定を無視して通常計測を返しても全衝撃として扱わない',async()=>{
 const app=await dashboard(response,{impactsRespond:()=>({measurements:[{measurementId:'normal',isImpact:false}],nextToken:'more-normal'})});
 await app.loadDelivery('A');assert.equal(app.state.detail.impacts,undefined);assert.match(app.state.detail.impactError,/対応していないAPI/);
 assert.equal(app.calls.filter(({path})=>path.includes('impacts=only')).length,1);
});
