const $=id=>document.getElementById(id);
const state={deliveries:[],cells:[],detail:null,meta:null,selectedId:null,eventsOnly:true,page:0,view:'monitor',loadToken:0,reloadToken:0,listCursor:null,cellsCursor:null,detailBusy:false};
Object.assign(state,{mapMode:'selected',allMapDetails:[],allMapBusy:false,allMapToken:0,allMapProgress:'',allMapError:''});
const deliveryCache=new Map(),DETAIL_RECHECK_MS=60000,INDEX_RETRY_MS=10000;
// 一覧の更新日時に加えて、同時刻に書き込まれた集計値の変化も検出する。
function summaryVersion(summary){
 if(!summary?.updatedAt||!Number.isFinite(Date.parse(summary.updatedAt)))return null;
 return JSON.stringify([summary.updatedAt,summary.sampleCount,summary.impactCount,summary.avgScore,summary.maxVibration,summary.maxTilt]);
}
async function deliveryEntry(item){
 const cached=deliveryCache.get(item.deliveryId),version=summaryVersion(item.summary),now=Date.now();
 if(version&&cached?.version===version&&now-cached.fetchedAt<DETAIL_RECHECK_MS&&(!cached.retryAt||now<cached.retryAt))return cached;
 const [detail,impactResult]=await Promise.all([
  request(`/api/deliveries/${encodeURIComponent(item.deliveryId)}?limit=500&sampling=uniform`),
  readImpacts(item.deliveryId).then(impacts=>({impacts}),error=>({impactError:error.message}))
 ]);
 Object.assign(detail,impactResult);
 const incomplete=detail.impactError||(detail.impacts&&Number.isFinite(detail.summary?.impactCount)&&detail.impacts.length!==detail.summary.impactCount);
 return {detail,version,fetchedAt:Date.now(),retryAt:incomplete||!cached||cached.version!==version?Date.now()+INDEX_RETRY_MS:null};
}
async function readImpacts(id){
 let cursor=null,rows=[];const seen=new Set();
 do{
  const part=await request(`/api/deliveries/${encodeURIComponent(id)}?limit=500&impacts=only${cursor?'&cursor='+encodeURIComponent(cursor):''}`);
  if(part.impacts!=='only')throw new Error('衝撃の全件取得に対応していないAPIです。');
  rows=mergeRows(rows,part.measurements,'measurementId');cursor=part.nextToken??null;
  if(cursor&&seen.has(cursor))throw new Error('衝撃データの続きを取得できません。');
  if(cursor)seen.add(cursor);
 }while(cursor);
 return rows.sort((a,b)=>Date.parse(a.measuredAt)-Date.parse(b.measuredAt)||a.measurementId.localeCompare(b.measurementId));
}
function displayRows(detail){
 return mergeRows(detail?.measurements??[],detail?.impacts??[],'measurementId').sort((a,b)=>Date.parse(a.measuredAt)-Date.parse(b.measuredAt)||a.measurementId.localeCompare(b.measurementId));
}
function impactCoverage(detail){
 if(!detail)return '';
 if(detail.impactError)return '衝撃の全件取得に失敗しました。取得済みの計測に含まれる衝撃のみ表示しています。';
 if(!detail.impacts)return '衝撃を取得中です。';
 const missing=detail.impacts.filter(row=>!finite(row.latitude)||!finite(row.longitude)).length;
 const expected=detail.summary?.impactCount,actual=detail.impacts.length;
 const status=finite(expected)&&expected!==actual?`衝撃${actual}件を取得（集計${expected}件。反映差があるため再取得します）`:`衝撃${actual}件を全件取得`;
 return `${status}。${missing?`座標なし${missing}件は地図に表示できません。`:''}`;
}
const base=(window.DASHBOARD_CONFIG?.apiBaseUrl??'').replace(/\/$/,'');
const cloudMode=window.DASHBOARD_CONFIG?.deployment==='aws'||/^https:\/\/[^/]+\.execute-api\.[^/]+\.amazonaws\.com/.test(base);
let map,overlay,grid,tiles,selectedMarker,recordMarkers=new Map(),fitBounds;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const number=(v,d=1)=>finite(v)?new Intl.NumberFormat('ja-JP',{maximumFractionDigits:d}).format(v):'—';
const time=v=>v&&Number.isFinite(Date.parse(v))?new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(v)):'—';
const datetime=v=>v&&Number.isFinite(Date.parse(v))?new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(v)):'—';
const set=(id,text)=>{$(id).textContent=text;};
function toast(text){set('toast',text);$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,4200);}
function alert(message){set('alert',message);$('alert').hidden=!message;}
async function request(path,options){const res=await fetch(`${base}${path}`,{cache:'no-store',signal:AbortSignal.timeout(15000),...options});const data=await res.json();if(!res.ok)throw Object.assign(new Error(data.error??`APIエラー (${res.status})`),{status:res.status});return data;}
const post=(path,payload)=>request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
function modeLabel(){
 const sources=Object.values(state.meta?.sources??{});
 if(state.meta?.mode==='c-example')return'サンプル例';
 if(state.meta?.mode==='demo')return'架空データ';
 if(state.meta?.mode==='dynamodb')return'DynamoDB';
 if(sources.includes('架空デモ')&&sources.includes('取り込みJSON'))return'取り込み＋架空データ';
 return'取り込みデータ';
}
async function reload(){
 try{
  const reloadToken=++state.reloadToken; ++state.loadToken;
  deliveryCache.clear();
  ++state.allMapToken;state.allMapBusy=false;state.allMapDetails=[];state.allMapError='';
  $('reload').disabled=true;alert('');
  const [list,cells]=await Promise.all([request('/api/deliveries?limit=50'),request('/api/cells?limit=100')]);
  if(reloadToken!==state.reloadToken)return;
  $('more-deliveries').disabled=false;$('more-cells').disabled=false;
  state.listCursor=list.nextToken??null;state.cellsCursor=cells.nextToken??null;
  state.deliveries=list.items;state.cells=cells.items;state.meta=list.meta;
  set('connection',cloudMode?'AWS参照APIに接続':base?'参照APIに接続':'ローカルAPIに接続');set('mode-badge',modeLabel());set('dataset-label',state.meta.label);
  $('demo-button').style.color=state.meta.mode==='demo'?'#d7edbb':'';$('example-button').style.color=state.meta.mode==='c-example'?'#d7edbb':'';
  if(base){for(const id of ['open-import','demo-button','example-button'])$(id).hidden=true;}
  renderCells();
  if(!state.deliveries.some(row=>row.deliveryId===state.selectedId))state.selectedId=state.deliveries[0]?.deliveryId??null;
  renderList();await loadDelivery(state.selectedId);
  if(state.mapMode==='all'&&reloadToken===state.reloadToken)await loadAllMap();
 }catch(error){set('connection','接続エラー');alert(`読み込みに失敗しました：${error.message}。表示済みの値は前回取得したデータです。`);}
 finally{$('reload').disabled=false;}
}
function renderList(){
 const query=$('search').value.toLowerCase();$('delivery-list').replaceChildren();set('delivery-total',state.deliveries.length+(state.listCursor?'+':''));$('more-deliveries').hidden=!state.listCursor;
 for(const item of state.deliveries.filter(row=>row.deliveryId.toLowerCase().includes(query))){
  const button=document.createElement('button');button.className=`delivery-choice ${item.deliveryId===state.selectedId?'active':''}`;button.setAttribute('aria-pressed',String(item.deliveryId===state.selectedId));
  const id=document.createElement('span');id.className='id';id.textContent=item.deliveryId;
  const meta=document.createElement('span');meta.className='meta';const count=document.createElement('span');count.textContent=`${number(item.summary?.sampleCount,0)}件 / 衝撃 ${number(item.summary?.impactCount,0)}回`;
  const score=document.createElement('span');score.className='score';score.textContent=number(item.summary?.avgScore,1);meta.append(count,score);button.append(id,meta);
  button.addEventListener('click',()=>{state.selectedId=item.deliveryId;state.page=0;renderList();loadDelivery(item.deliveryId).catch(error=>alert(error.message));});$('delivery-list').append(button);
 }
 if(!$('delivery-list').children.length){const p=document.createElement('p');p.textContent=state.deliveries.length?'一致する配送がありません。':'配送データがありません。';p.style.fontSize='11px';$('delivery-list').append(p);}
}
async function loadDelivery(id){
 const token=++state.loadToken,generation=state.reloadToken;
 if(!id){state.detail=null;renderDetail();return;}
 state.detail=null;state.detailBusy=true;renderDetail();
 try{
  const entry=await deliveryEntry(state.deliveries.find(item=>item.deliveryId===id)??{deliveryId:id});
  if(token!==state.loadToken||generation!==state.reloadToken)return;
  deliveryCache.set(id,entry);state.detail=entry.detail;state.page=0;
 }finally{if(token===state.loadToken){state.detailBusy=false;renderDetail();}}
}
function renderDetail(preserveMap=false){
 const detail=state.detail,summary=detail?.summary,rows=detail?.measurements??[],shown=displayRows(detail);
 set('selected-delivery',detail?.deliveryId??state.selectedId??'配送データがありません');
 set('delivery-subtitle',rows.length?`${datetime(rows[0].measuredAt)} – ${time(rows.at(-1).measuredAt)} JST / ${number(rows.length,0)}件${detail?.sampling==='uniform'?'を全区間から抽出':'を取得'}`:state.selectedId?'計測データを読み込み中、または未取得です。':'左の配送一覧から選択してください。');
 const versions=[...new Set(rows.map(row=>row.algorithmVersion))];set('algorithm',versions.length?versions.join(' / '):'解析バージョン未受領');
 set('avg-score',number(summary?.avgScore,1));$('score-meter').style.width=`${Math.max(0,Math.min(100,summary?.avgScore??0))}%`;
 set('impact-count',number(summary?.impactCount,0));set('impact-subtitle',summary?'配送全体の集計値':'集計データ未受領');
 set('max-tilt',number(summary?.maxTilt,1));set('sample-count',number(summary?.sampleCount,0));set('available-count',`表示可能な計測：${number(shown.length,0)}件`);
 set('visible-impacts',`${displayRows(detail).filter(row=>row.isImpact).length}回`);
 const vibrations=shown.map(row=>row.vibration).filter(finite);set('visible-vibration',vibrations.length?number(vibrations.reduce((max,value)=>Math.max(max,value),-Infinity),2):'—');
 const positions=shown.filter(row=>finite(row.latitude)&&finite(row.longitude));set('gps-count',`${positions.length} / ${shown.length}件`);set('low-gps-count',`${positions.filter(row=>finite(row.accuracyMeters)&&row.accuracyMeters>50).length}件`);set('updated-at',datetime(summary?.updatedAt));
 const total=summary?.sampleCount??detail?.total;
 let note=detail?`集計${number(total,0)}件 / 計測${rows.length}件を読み込み済み。グラフ・軌跡は読み込み済みの範囲を表示します。`:'配送を選択してください。';
 if(detail?.sampling==='uniform')note=`集計${number(detail.total,0)}件 / 先頭・末尾を含め、最大50の時間帯から合計最大500件を取得。空の時間帯がある場合などは500件未満になります。軌跡は抽出した計測を表示します。衝撃は別途全件を取得します。集計値は配送全体の値です。`;
 set('loaded-info',detail?.sampling==='uniform'?`全区間から${rows.length}件を抽出`:`計測${rows.length}件を読み込み済み${detail?.nextToken?'・続きがあります':''}`);$('more-measurements').hidden=!detail?.nextToken;$('more-measurements').disabled=state.detailBusy;
 if(modeLabel()==='取り込み＋架空データ')note+=' 取り込みデータと架空サンプルが混在しています。';
 if(detail)note+=' '+impactCoverage(detail);
 set('coverage-note',note);const chartRows=displayRows(detail);renderChart('vibration-chart',chartRows,'vibration','#348e74');renderChart('tilt-chart',chartRows,'tiltDegrees','#7897a3');renderRecords();renderMap(preserveMap||state.mapMode==='all');
}
function renderChart(id,rows,key,color){
 const area=$(id);area.replaceChildren();if(!rows.length||!rows.some(row=>finite(row[key]))){area.innerHTML='<div class="empty-state">表示できる計測がありません。</div>';return;}
 const stride=Math.max(1,Math.ceil(rows.length/800));const displayed=rows.filter((row,i)=>i%stride===0||row.isImpact||i===rows.length-1);
 const values=displayed.map(row=>row[key]).filter(finite),max=values.reduce((a,b)=>Math.max(a,b),1)*1.12,min=values.reduce((a,b)=>Math.min(a,b),0),range=max-min||1;
 const start=Date.parse(rows[0].measuredAt),end=Date.parse(rows.at(-1).measuredAt),duration=Math.max(1000,end-start);
 const width=540,height=170,left=35,right=15,top=12,bottom=27;
 const x=row=>left+(Date.parse(row.measuredAt)-start)/duration*(width-left-right),y=value=>top+(max-value)/range*(height-top-bottom);
 const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
 const add=(type,attrs,text)=>{const el=document.createElementNS(ns,type);for(const [k,v]of Object.entries(attrs))el.setAttribute(k,String(v));if(text!==undefined)el.textContent=text;svg.append(el);return el;};
 for(let i=0;i<4;i++){const value=min+range*i/3,yy=y(value);add('line',{x1:left,x2:width-right,y1:yy,y2:yy,stroke:'#e7ede4','stroke-width':1});add('text',{x:left-7,y:yy+3,'text-anchor':'end'},number(value,1));}
 for(let i=0;i<4;i++){const xx=left+i/3*(width-left-right);add('text',{x:xx,y:height-6,'text-anchor':i===0?'start':i===3?'end':'middle'},time(new Date(start+duration*i/3).toISOString()));}
 let path='',pen=false;for(const row of displayed){if(!finite(row[key])){pen=false;continue;}path+=`${pen?'L':'M'}${x(row).toFixed(2)},${y(row[key]).toFixed(2)} `;pen=true;}
 add('path',{d:path,fill:'none',stroke:color,'stroke-width':2,'stroke-linecap':'round','stroke-linejoin':'round'});
 for(const row of displayed.filter(row=>row.isImpact&&finite(row[key]))){add('line',{x1:x(row),x2:x(row),y1:top,y2:height-bottom,stroke:'#e6b19f','stroke-dasharray':'3 4'});const circle=add('circle',{cx:x(row),cy:y(row[key]),r:3.8,fill:'#dd765e',stroke:'white','stroke-width':1.5});const title=document.createElementNS(ns,'title');title.textContent=`${time(row.measuredAt)} / ${number(row[key],2)}`;circle.append(title);}
 if(displayed.length===1){add('circle',{cx:x(displayed[0]),cy:y(displayed[0][key]),r:3.5,fill:color});}
 area.append(svg);area.setAttribute('aria-label',`${key}のグラフ。${rows.length}件中${displayed.length}点を描画。衝撃は間引かず表示。`);
}
function cellState(value){return value==='evaluated'?'評価済み':value==='reference'||value==='demo_insufficient'?'参考値':value;}
// CのCELL_SIZE=0.0005度と同じ区画。密度や測定回数による重み付けはしない。
const CELL_SIZE=0.0005;
let heatmapOpacity=.35,heatmapLayers=[];
function cellScore(cell){return finite(cell.avgScore)&&cell.avgScore>=0&&cell.avgScore<=100?cell.avgScore:null;}
function cellScoreLabel(cell){const score=cellScore(cell);return score===null?'未取得':`${number(score,1)} / 100`;}
function heatmapColor(score){
 const stops=[[198,66,58],[241,193,75],[23,137,143]],index=score<=50?0:1,t=(score-index*50)/50;
 return '#'+stops[index].map((value,i)=>Math.round(value+(stops[index+1][i]-value)*t).toString(16).padStart(2,'0')).join('');
}
function cellHeatStyle(cell){
 const score=cellScore(cell),reference=cell.evalStatus!=='evaluated';
 return {pane:'cell-heatmap',color:score===null?'#737b80':heatmapColor(score),weight:1,opacity:heatmapOpacity===0?0:.65,
  fillColor:score===null?'#737b80':heatmapColor(score),fillOpacity:score===null?heatmapOpacity*.2:heatmapOpacity,
  dashArray:score===null||reference?'4 3':undefined};
}
function cellBounds(cell){const half=CELL_SIZE/2;return [[cell.centerLat-half,cell.centerLon-half],[cell.centerLat+half,cell.centerLon+half]];}
function updateHeatmapOpacity(value){
 const percent=Number(value);if(!Number.isFinite(percent))return;
 heatmapOpacity=Math.max(0,Math.min(75,percent))/100;
 set('heatmap-opacity-value',`${Math.round(heatmapOpacity*100)}%`);
 for(const {layer,cell}of heatmapLayers)layer.setStyle(cellHeatStyle(cell));
}
function updateMapNote(){
 const missing=state.cells.filter(cell=>cellScore(cell)===null).length;
 set('map-note',`${$('basemap').checked?'背景地図：OpenStreetMap。':'座標プレビュー：背景地図なし。'} 全配送の区画平均スコアを表示（高いほど高評価）。破線は参考値・未取得。読み込み済み${state.cells.length}区画${state.cellsCursor?'・続きあり':''}、スコア未取得${missing}区画。架空データは実際の路面状態を示しません。`);
}
function popup(title,lines){const container=document.createElement('div');container.className='map-popup';const heading=document.createElement('strong');heading.textContent=title;container.append(heading);for(const line of lines){const p=document.createElement('p');p.textContent=line;container.append(p);}return container;}
function initializeMap(){
 map=L.map('map',{zoomControl:true,attributionControl:true,preferCanvas:true}).setView([35.5556,139.657],16);map.attributionControl.setPrefix('Leaflet');
 map.createPane('cell-heatmap').style.zIndex='350';
 const Grid=L.GridLayer.extend({createTile(coords){const tile=document.createElement('div');tile.className='coordinate-grid coordinate-tile';const latLng=map.unproject(L.point(coords.x*256,coords.y*256),coords.z);tile.textContent=`${latLng.lat.toFixed(4)}, ${latLng.lng.toFixed(4)}`;return tile;}});
 grid=new Grid({tileSize:256,attribution:'座標プレビュー / 背景地図なし'}).addTo(map);overlay=L.layerGroup().addTo(map);
 $('fit-map').addEventListener('click',()=>{map.invalidateSize();if(fitBounds?.isValid())map.fitBounds(fitBounds,{padding:[30,30],maxZoom:17});});
 $('basemap').addEventListener('change',()=>{
  if($('basemap').checked){
   tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'});
   let warned=false;tiles.on('tileerror',()=>{if(!warned){warned=true;toast('背景地図を取得できません。チェックを外すと座標プレビューに戻れます。');}});
   grid.remove();tiles.addTo(map);
  }else{tiles?.remove();grid.addTo(map);}
  updateMapNote();
 });
}
function renderMapMode(){
 const all=state.mapMode==='all';
 for(const [id,active]of [['map-selected',!all],['map-all',all]]){$(id).classList.toggle('active',active);$(id).setAttribute('aria-pressed',String(active));}
 set('map-description',all?'地図は全配送、スコア・グラフ・明細は選択中の配送を表示':'軌跡は選択した配送、区画は全配送の集計');
 const gps=state.allMapDetails.filter(detail=>displayRows(detail).some(row=>finite(row.latitude)&&finite(row.longitude))).length;
 set('map-status',all?(state.allMapBusy?state.allMapProgress:state.allMapError||`${state.allMapDetails.length}配送を取得・GPSあり${gps}配送。各配送は最大500件の抽出軌跡と取得した衝撃を表示します。${state.allMapDetails.reduce((n,detail)=>n+(detail.impacts??[]).filter(row=>!finite(row.latitude)||!finite(row.longitude)).length,0)}件の衝撃は座標がありません。${state.allMapDetails.some(detail=>detail.impactError)?'衝撃の全件取得に失敗した配送があります。':''}${state.allMapDetails.some(detail=>detail.impacts&&finite(detail.summary?.impactCount)&&detail.impacts.length!==detail.summary.impactCount)?'衝撃の集計と取得件数に反映差があります。':''}${state.allMapDetails.length&&!gps?'表示できるGPS座標がありません。':''}`):`選択中の配送の軌跡を表示しています。${impactCoverage(state.detail)}`);
 $('map').setAttribute('aria-busy',String(all&&state.allMapBusy));
}
async function setMapMode(mode){
 if(mode===state.mapMode)return;
 state.mapMode=mode;++state.allMapToken;state.allMapBusy=false;state.allMapError='';
 renderMapMode();renderMap();
 if(mode==='all')await loadAllMap();
}
async function loadAllMap(preserveView=false,providedList=null){
 if(state.mapMode!=='all'||state.allMapBusy)return;
 const token=++state.allMapToken,generation=state.reloadToken;
 const current=()=>token===state.allMapToken&&generation===state.reloadToken&&state.mapMode==='all';
 state.allMapBusy=true;state.allMapError='';state.allMapProgress='全配送の一覧を取得中…';renderMapMode();
 try{
  const list=providedList??await refreshPages('/api/deliveries',50,'items',0,true);
  if(!current())return;
  const details=new Array(list.items.length);let next=0,done=0;
  state.allMapProgress=`全配送の軌跡を取得中… 0 / ${list.items.length}配送`;renderMapMode();
  // 各配送のAPI内でも複数Queryを行うため、配送単位の取得は2並列に抑える。
  await Promise.all(Array.from({length:Math.min(2,list.items.length)},async()=>{
   while(current()&&next<list.items.length){
    const index=next++,id=list.items[index].deliveryId;
    try{details[index]=await deliveryEntry(list.items[index]);}
    catch(error){if(error.status!==404)throw error;}
    if(!current())return;
    state.allMapProgress=`全配送の軌跡を取得中… ${++done} / ${list.items.length}配送`;renderMapMode();
   }
  }));
  if(!current())return;
  const entries=details.filter(Boolean),ids=new Set(entries.map(entry=>entry.detail.deliveryId));
  for(const id of deliveryCache.keys())if(!ids.has(id))deliveryCache.delete(id);
  for(const entry of entries)deliveryCache.set(entry.detail.deliveryId,entry);
  state.allMapDetails=entries.map(entry=>entry.detail);state.deliveries=list.items;state.listCursor=list.nextToken??null;
  const selected=entries.find(entry=>entry.detail.deliveryId===state.selectedId)??entries[0];
  if(!state.detailBusy){
   const id=selected?.detail.deliveryId??null;
   if(id!==state.selectedId)state.page=0;
   state.selectedId=id;state.detail=selected?.detail??null;renderDetail(true);
  }
  renderList();renderMap(preserveView);
 }catch(error){
  if(current()){++state.allMapToken;state.allMapError=`全配送の取得に失敗しました：${error.message}。${state.allMapDetails.length?'前回の軌跡を表示しています。':''}「更新」で再取得できます。`;}
 }finally{
  if(generation===state.reloadToken&&state.mapMode==='all'&&(token===state.allMapToken||token+1===state.allMapToken)){state.allMapBusy=false;renderMapMode();}
 }
}
function deliveryColor(id){let hash=0;for(const character of id)hash=(hash*31+character.codePointAt(0))>>>0;return ['#238267','#4267ac','#9865a6','#b47b26','#29888e','#a05c65'][hash%6];}
function renderMap(preserveView=false){
 renderMapMode();
 if(!map)return;overlay.clearLayers();heatmapLayers=[];recordMarkers=new Map();selectedMarker=null;fitBounds=L.latLngBounds([]);
 const all=state.mapMode==='all',details=all?state.allMapDetails:state.detail?[state.detail]:[];
 let hasPositions=false;
 for(const detail of details){
 const rows=detail.measurements,color=all?deliveryColor(detail.deliveryId):'#238267';let segment=[];const finish=()=>{if(segment.length>1)L.polyline(segment,{color,weight:detail.deliveryId===state.selectedId?4:3,opacity:.8}).bindPopup(popup(detail.deliveryId,[`取得した計測：${rows.length}件`,'各配送の軌跡を個別に表示しています。'])).addTo(overlay);segment=[];};
 for(const row of rows){if(!finite(row.latitude)||!finite(row.longitude)){finish();continue;}const point=[row.latitude,row.longitude];segment.push(point);fitBounds.extend(point);}
 finish();
 const usable=displayRows(detail).filter(row=>finite(row.latitude)&&finite(row.longitude));
 for(const row of usable)fitBounds.extend([row.latitude,row.longitude]);
 hasPositions||=usable.length>0;
 const stride=Math.max(1,Math.ceil(usable.length/800));
 usable.forEach((row,i)=>{if(all&&!row.isImpact&&i!==0&&i!==usable.length-1)return;if(i%stride!==0&&!row.isImpact&&i!==usable.length-1)return;const marker=L.circleMarker([row.latitude,row.longitude],{radius:row.isImpact?6:2.5,color:row.isImpact?'#c5644c':color,weight:row.isImpact?2:1,fillColor:row.isImpact?'#dd765e':color,fillOpacity:finite(row.accuracyMeters)&&row.accuracyMeters>50?.25:.9}).bindPopup(popup(detail.deliveryId,[row.measurementId,`${time(row.measuredAt)} JST / ${row.isImpact?'衝撃あり':'衝撃なし'}`,`スコア ${number(row.qualityScore,1)} / 振動 ${number(row.vibration,2)}`,`傾斜 ${number(row.tiltDegrees,1)}° / GPS精度 ${number(row.accuracyMeters,1)}m`])).addTo(overlay);if(detail.deliveryId===state.selectedId)recordMarkers.set(row.measurementId,marker);});
 const trackPositions=rows.filter(row=>finite(row.latitude)&&finite(row.longitude));
 if(trackPositions.length){L.marker([trackPositions[0].latitude,trackPositions[0].longitude],{icon:L.divIcon({className:'map-start',html:'S',iconSize:[21,21]})}).bindPopup(popup(detail.deliveryId,['取得した軌跡の先頭'])).addTo(overlay);}
 }
 for(const cell of state.cells){
  const bounds=cellBounds(cell),layer=L.rectangle(bounds,cellHeatStyle(cell)).bindPopup(popup(cell.cellId,[`区画平均スコア：${cellScoreLabel(cell)}`,`平均振動：${number(cell.avgVibration,2)}m/s²`,`測定 ${cell.sampleCount}件 / 衝撃 ${cell.impactCount}回`,`状態：${cellState(cell.evalStatus)}`,`全配送の集計 / ${datetime(cell.updatedAt)} JST`])).addTo(overlay);
  heatmapLayers.push({layer,cell});if(!hasPositions)for(const point of bounds)fitBounds.extend(point);
 }
 if(!preserveView){if(fitBounds.isValid())map.fitBounds(fitBounds,{padding:[32,32],maxZoom:17});else map.setView([35.5556,139.657],16);}
 updateMapNote();
}
function renderRecords(){
 $('records-body').replaceChildren();const rows=displayRows(state.detail).filter(row=>!state.eventsOnly||row.isImpact),size=15,totalPages=Math.max(1,Math.ceil(rows.length/size));state.page=Math.min(state.page,totalPages-1);
 for(const row of rows.slice(state.page*size,(state.page+1)*size)){
  const tr=document.createElement('tr');tr.tabIndex=0;tr.setAttribute('aria-label',`${time(row.measuredAt)}の計測位置を確認`);
  for(const val of [time(row.measuredAt),number(row.qualityScore,1),number(row.vibration,2),finite(row.tiltDegrees)?`${number(row.tiltDegrees,1)}°`:'未取得',row.isImpact?'衝撃あり':'なし',finite(row.accuracyMeters)?`${number(row.accuracyMeters,1)}m`:'未取得',row.measurementId]){const td=document.createElement('td');td.textContent=val;tr.append(td);}
  tr.children[4].className=row.isImpact?'coral':'neutral-label';
  const select=()=>{document.querySelectorAll('.selected-record').forEach(el=>el.classList.remove('selected-record'));tr.classList.add('selected-record');if(!finite(row.latitude)||!finite(row.longitude)){toast('この計測にはGPS座標がありません。');return;}const marker=recordMarkers.get(row.measurementId);if(marker){map.setView(marker.getLatLng(),17);marker.openPopup();}else{selectedMarker?.remove();selectedMarker=L.circleMarker([row.latitude,row.longitude],{color:'#173b36',radius:8,weight:3}).bindPopup(popup(row.measurementId,[`${time(row.measuredAt)} JST`])).addTo(overlay);map.setView(selectedMarker.getLatLng(),17);selectedMarker.openPopup();}};
  tr.addEventListener('click',select);tr.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}});$('records-body').append(tr);
 }
 if(!rows.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=7;td.className='empty-row';td.textContent=state.eventsOnly?'受領した計測に衝撃イベントはありません。「すべて」で通常の計測を確認できます。':'計測結果がありません。';tr.append(td);$('records-body').append(tr);}
 set('records-info',rows.length?`${rows.length}件 / ${state.page+1}ページ目（${totalPages}ページ）`:'0件');$('prev-records').disabled=state.page===0;$('next-records').disabled=state.page>=totalPages-1;
 $('events-only').classList.toggle('active',state.eventsOnly);$('all-records').classList.toggle('active',!state.eventsOnly);
}
function switchView(view){state.view=view;document.querySelectorAll('[data-view]').forEach(button=>button.classList.toggle('active',button.dataset.view===view));for(const v of ['monitor','roads'])$(`${v}-view`).hidden=v!==view;set('page-title',{monitor:'配送モニター',roads:'路面区画'}[view]);if(view==='monitor')setTimeout(()=>map.invalidateSize(),30);}
function renderCells(){
 $('cells-body').replaceChildren();set('cell-count',`${state.cells.length}区画${state.cellsCursor?'+':''}`);set('cells-loaded-info',`${state.cells.length}区画を読み込み済み`);$('more-cells').hidden=!state.cellsCursor;
 for(const cell of state.cells){const tr=document.createElement('tr');for(const value of [cell.cellId,cell.sampleCount,cellScoreLabel(cell),number(cell.avgVibration,2),number(cell.maxVibration,2),cell.impactCount,cellState(cell.evalStatus),datetime(cell.updatedAt)]){const td=document.createElement('td');td.textContent=value;tr.append(td);}const td=document.createElement('td'),button=document.createElement('button');button.className='button compact';button.textContent='地図で見る';button.addEventListener('click',()=>{switchView('monitor');setTimeout(()=>{map.setView([cell.centerLat,cell.centerLon],17);L.popup().setLatLng([cell.centerLat,cell.centerLon]).setContent(popup(cell.cellId,[`区画平均スコア：${cellScoreLabel(cell)}`,`平均振動 ${number(cell.avgVibration,2)} / ${cell.sampleCount}件`,`状態：${cellState(cell.evalStatus)}`])).openOn(map);},50);});td.append(button);tr.append(td);$('cells-body').append(tr);}
 if(!state.cells.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=9;td.className='empty-row';td.textContent='GPS区画の集計データがありません。';tr.append(td);$('cells-body').append(tr);}
}
function openImport(){$('import-error').hidden=true;$('import-dialog').showModal();}
async function reset(mode){if(state.meta?.mode==='imported'&&!window.confirm('このPCに取り込んだデータを置き換えます。必要なら先にJSONを書き出してください。続けますか？'))return;try{await post('/api/local/reset',{mode});await reload();toast(mode==='empty'?'データを空にしました。3種類を順に取り込めます。':'データセットを切り替えました。');}catch(error){alert(error.message);}}
$('heatmap-opacity').addEventListener('input',event=>updateHeatmapOpacity(event.target.value));
$('search').addEventListener('input',renderList);$('reload').addEventListener('click',reload);
$('map-selected').addEventListener('click',()=>void setMapMode('selected'));
$('map-all').addEventListener('click',()=>void setMapMode('all'));
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>switchView(button.dataset.view)));
$('events-only').addEventListener('click',()=>{state.eventsOnly=true;state.page=0;renderRecords();});$('all-records').addEventListener('click',()=>{state.eventsOnly=false;state.page=0;renderRecords();});
$('prev-records').addEventListener('click',()=>{state.page--;renderRecords();});$('next-records').addEventListener('click',()=>{state.page++;renderRecords();});
$('demo-button').addEventListener('click',()=>reset('demo'));$('example-button').addEventListener('click',()=>reset('c-example'));
$('open-import').addEventListener('click',openImport);
for(const id of ['close-import','cancel-import'])$(id).addEventListener('click',()=>$('import-dialog').close());
$('import-file').addEventListener('change',async()=>{const file=$('import-file').files[0];if(!file)return;if(file.size>12*1024*1024){set('import-error','12MB以内のJSONを選択してください。');$('import-error').hidden=false;return;}$('import-text').value=await file.text();try{const data=JSON.parse($('import-text').value);if(data.analysis&&data.summaries&&data.cells)$('import-type').value='bundle';else{const row=Array.isArray(data)?data[0]:data.Items?.[0]??data.Item??data;if(row?.measurementId)$('import-type').value='analysis';else if(row?.cellId)$('import-type').value='cells';else if(row?.deliveryId)$('import-type').value='summaries';}}catch{/* エラーは取り込み時に表示する。 */}});
$('import-form').addEventListener('submit',async event=>{event.preventDefault();$('import-error').hidden=true;$('import-submit').disabled=true;try{let records;try{records=JSON.parse($('import-text').value);}catch{throw new Error('JSONを読み取れません。末尾のカンマや引用符を確認してください。');}const result=await post('/api/local/import',{type:$('import-type').value,records});$('import-dialog').close();await reload();toast(`取り込み完了：${Object.entries(result.imported).map(([table,n])=>`${table} ${n}件`).join(' / ')}`);}catch(error){set('import-error',error.message);$('import-error').hidden=false;}finally{$('import-submit').disabled=false;}});

if(cloudMode){
 document.querySelector('.local-tag').textContent='配送品質モニター';
 document.querySelector('.sidebar-bottom').hidden=true;
}
function mergeRows(previous,next,key){return [...new Map([...previous,...next].map(row=>[row[key],row])).values()];}
async function loadCollectionMore(type){
 const button=$(type==='deliveries'?'more-deliveries':'more-cells'),cursor=type==='deliveries'?state.listCursor:state.cellsCursor,generation=state.reloadToken;
 if(!cursor||button.disabled)return;button.disabled=true;
 try{
  const part=await request('/api/'+type+'?limit='+ (type==='deliveries'?50:100)+'&cursor='+encodeURIComponent(cursor));
  if(generation!==state.reloadToken)return;
  if(part.nextToken===cursor)throw new Error('続きを読み込めませんでした。更新してください。');
  if(type==='deliveries'){state.deliveries=mergeRows(state.deliveries,part.items,'deliveryId');state.listCursor=part.nextToken??null;renderList();}
  else{state.cells=mergeRows(state.cells,part.items,'cellId');state.cellsCursor=part.nextToken??null;renderCells();renderMap();}
 }catch(error){alert(error.message);}finally{if(generation===state.reloadToken)button.disabled=false;}
}
async function loadMeasurementMore(){
 const current=state.detail,cursor=current?.nextToken,token=state.loadToken;
 if(!cursor||state.detailBusy)return;state.detailBusy=true;$('more-measurements').disabled=true;
 try{
  const part=await request('/api/deliveries/'+encodeURIComponent(current.deliveryId)+'?limit=500&cursor='+encodeURIComponent(cursor));
  if(token!==state.loadToken||state.detail!==current)return;
  if(part.nextToken===cursor)throw new Error('続きを読み込めませんでした。更新してください。');
  current.measurements=mergeRows(current.measurements,part.measurements,'measurementId').sort((a,b)=>Date.parse(a.measuredAt)-Date.parse(b.measuredAt)||a.measurementId.localeCompare(b.measurementId));
  current.nextToken=part.nextToken??null;current.summary=part.summary;
  renderDetail();
 }catch(error){if(token===state.loadToken)alert(error.message);}finally{if(token===state.loadToken){state.detailBusy=false;$('more-measurements').disabled=false;}}
}
$('more-deliveries').addEventListener('click',()=>loadCollectionMore('deliveries'));
$('more-cells').addEventListener('click',()=>loadCollectionMore('cells'));
$('more-measurements').addEventListener('click',loadMeasurementMore);
// 読み込み済みの範囲を先頭から取り直し、途中のページの更新も反映する。
async function refreshPages(path,limit,key,count,readToEnd=false){
 let result,cursor=null,items=[];const seen=new Set();
 do{
  const part=await request(`${path}?limit=${limit}${cursor?'&cursor='+encodeURIComponent(cursor):''}`);
  result=part;items=mergeRows(items,part[key],key==='measurements'?'measurementId':key==='items'&&path==='/api/cells'?'cellId':'deliveryId');
  cursor=part.nextToken??null;
  if(cursor&&seen.has(cursor))throw new Error('続きを読み込めませんでした。更新してください。');
  if(cursor)seen.add(cursor);
 }while(cursor&&(readToEnd||items.length<count));
 return {...result,[key]:items};
}
let refreshing=false,refreshTimer;
function refreshIsCurrent(snapshot){return !$('reload').disabled&&!state.detailBusy&&!$('more-deliveries').disabled&&!$('more-cells').disabled&&snapshot.mapMode===state.mapMode&&snapshot.reloadToken===state.reloadToken&&snapshot.loadToken===state.loadToken&&snapshot.deliveries===state.deliveries&&snapshot.cells===state.cells&&snapshot.detail===state.detail&&snapshot.detailCursor===state.detail?.nextToken;}
async function refreshDashboard(){
 if(refreshing||document.hidden||$('reload').disabled||state.detailBusy||state.allMapBusy||$('more-deliveries').disabled||$('more-cells').disabled)return;
 refreshing=true;
 const snapshot={...state,detailCursor:state.detail?.nextToken};
 try{
  const [list,cells]=await Promise.all([
   refreshPages('/api/deliveries',50,'items',state.deliveries.length,snapshot.mapMode==='all'),
   refreshPages('/api/cells',100,'items',state.cells.length)
  ]);
  let id=snapshot.selectedId??list.items[0]?.deliveryId??null,detail=null,entry=null;
  if(!list.nextToken&&!list.items.some(item=>item.deliveryId===id))id=list.items[0]?.deliveryId??null;
  if(id&&snapshot.mapMode!=='all'){
   try{entry=await deliveryEntry(list.items.find(item=>item.deliveryId===id)??{deliveryId:id});detail=entry.detail;}
   catch(error){
    if(error.status!==404)throw error;
    id=list.items.find(row=>row.deliveryId!==id)?.deliveryId??null;
    if(id){entry=await deliveryEntry(list.items.find(item=>item.deliveryId===id));detail=entry.detail;}
   }
  }
  if(!refreshIsCurrent(snapshot))return;
  if(entry)deliveryCache.set(id,entry);
  ++state.reloadToken;++state.loadToken;
  state.deliveries=list.items;state.listCursor=list.nextToken??null;state.meta=list.meta;
  state.cells=cells.items;state.cellsCursor=cells.nextToken??null;state.detail=snapshot.mapMode==='all'&&id===snapshot.selectedId?snapshot.detail:detail;state.selectedId=id;
  if(id!==snapshot.selectedId)state.page=0;
  set('connection',cloudMode?'AWS参照APIに接続':base?'参照APIに接続':'ローカルAPIに接続');
  set('mode-badge',modeLabel());set('dataset-label',state.meta.label);alert('');
  renderList();renderCells();renderDetail(id===snapshot.selectedId);
  if(state.mapMode==='all')await loadAllMap(true,list);
 }catch(error){
  if(refreshIsCurrent(snapshot)){set('connection','自動更新を再試行中');alert(`自動更新に失敗しました：${error.message}。表示済みの値は前回取得したデータです。接続回復後に自動で更新します。`);}
 }finally{refreshing=false;}
}
function scheduleRefresh(){
 clearTimeout(refreshTimer);
 if(!document.hidden)refreshTimer=setTimeout(async()=>{await refreshDashboard();scheduleRefresh();},5000);
}
async function resumeRefresh(){clearTimeout(refreshTimer);await refreshDashboard();scheduleRefresh();}
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(refreshTimer);else void resumeRefresh();});
window.addEventListener('online',()=>void resumeRefresh());
initializeMap();await reload();scheduleRefresh();
