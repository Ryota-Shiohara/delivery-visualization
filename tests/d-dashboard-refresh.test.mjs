import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../apps/dashboard/app.js',import.meta.url),'utf8');
async function dashboard(respond){
 const elements=new Map(),listeners={},timers=new Map(),calls=[],renders=[];
 let nextTimer=0;
 const document={hidden:false,getElementById(id){
  if(!elements.has(id))elements.set(id,{disabled:false,hidden:false,value:'',style:{},addEventListener(){}});
  return elements.get(id);
 },querySelectorAll(){return [];},addEventListener(name,callback){listeners[name]=callback;}};
 const window={DASHBOARD_CONFIG:{},addEventListener(name,callback){listeners[name]=callback;}};
 const context=vm.createContext({document,window,AbortSignal,URL,Intl,console,
  setTimeout(callback,ms){const id=++nextTimer;timers.set(id,{callback,ms});return id;},
  clearTimeout(id){timers.delete(id);},
  async fetch(path,options){calls.push({path,options});const data=await respond(path);return {ok:!data.error,status:data.status??200,json:async()=>data};}
 });
 const api=await vm.runInContext(`(async()=>{${source.replace('initializeMap();await reload();scheduleRefresh();','')}
 renderList=()=>{};renderCells=()=>{};renderDetail=preserve=>renders.push(preserve);
 return {state,refreshDashboard,scheduleRefresh,loadCollectionMore,loadDelivery};})()`,vm.createContext({...context,renders}));
 Object.assign(api.state,{selectedId:'A',deliveries:[{deliveryId:'A'}],cells:[],meta:{label:'old'},
  detail:{deliveryId:'A',measurements:[{measurementId:'old'}],summary:{sampleCount:1},nextToken:null},page:2,eventsOnly:false});
 return {...api,elements,document,listeners,timers,calls,renders};
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
 assert.equal(app.timers.size,0);release();await refresh;assert.equal(app.calls.length,3);
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
 assert.equal(app.calls.filter(({path})=>path.startsWith('/api/deliveries/A?')).length,2);
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
