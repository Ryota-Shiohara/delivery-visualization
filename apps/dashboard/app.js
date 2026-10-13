const $=id=>document.getElementById(id);
const state={deliveries:[],cells:[],detail:null,meta:null,selectedId:null,eventsOnly:true,page:0,view:'monitor',loadToken:0,reloadToken:0,listCursor:null,cellsCursor:null,detailBusy:false};
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
 const token=++state.loadToken;
 if(!id){state.detail=null;renderDetail();return;}
 state.detail=null;state.detailBusy=true;renderDetail();
 try{
  const detail=await request(`/api/deliveries/${encodeURIComponent(id)}?limit=500`);
  if(token!==state.loadToken)return;
  state.detail=detail;state.page=0;
 }finally{if(token===state.loadToken){state.detailBusy=false;renderDetail();}}
}
function renderDetail(preserveMap=false){
 const detail=state.detail,summary=detail?.summary,rows=detail?.measurements??[];
 set('selected-delivery',detail?.deliveryId??state.selectedId??'配送データがありません');
 set('delivery-subtitle',rows.length?`${datetime(rows[0].measuredAt)} – ${time(rows.at(-1).measuredAt)} JST / ${number(rows.length,0)}件を取得`:state.selectedId?'計測データを読み込み中、または未取得です。':'左の配送一覧から選択してください。');
 const versions=[...new Set(rows.map(row=>row.algorithmVersion))];set('algorithm',versions.length?versions.join(' / '):'解析バージョン未受領');
 set('avg-score',number(summary?.avgScore,1));$('score-meter').style.width=`${Math.max(0,Math.min(100,summary?.avgScore??0))}%`;
 set('impact-count',number(summary?.impactCount,0));set('impact-subtitle',summary?'配送全体の集計値':'集計データ未受領');
 set('max-tilt',number(summary?.maxTilt,1));set('sample-count',number(summary?.sampleCount,0));set('available-count',`表示可能な計測：${number(rows.length,0)}件`);
 set('visible-impacts',`${rows.filter(row=>row.isImpact).length}回`);
 const vibrations=rows.map(row=>row.vibration).filter(finite);set('visible-vibration',vibrations.length?number(vibrations.reduce((max,value)=>Math.max(max,value),-Infinity),2):'—');
 const positions=rows.filter(row=>finite(row.latitude)&&finite(row.longitude));set('gps-count',`${positions.length} / ${rows.length}件`);set('low-gps-count',`${positions.filter(row=>finite(row.accuracyMeters)&&row.accuracyMeters>50).length}件`);set('updated-at',datetime(summary?.updatedAt));
 const total=summary?.sampleCount??detail?.total;
 let note=detail?`集計${number(total,0)}件 / 計測${rows.length}件を読み込み済み。グラフ・軌跡は読み込み済みの範囲を表示します。`:'配送を選択してください。';
 set('loaded-info',`計測${rows.length}件を読み込み済み${detail?.nextToken?'・続きがあります':''}`);$('more-measurements').hidden=!detail?.nextToken;$('more-measurements').disabled=state.detailBusy;
 if(modeLabel()==='取り込み＋架空データ')note+=' 取り込みデータと架空サンプルが混在しています。';
 set('coverage-note',note);renderChart('vibration-chart',rows,'vibration','#348e74');renderChart('tilt-chart',rows,'tiltDegrees','#7897a3');renderRecords();renderMap(preserveMap);
}
function renderChart(id,rows,key,color){
 const area=$(id);area.replaceChildren();if(!rows.length||!rows.some(row=>finite(row[key]))){area.innerHTML='<div class="empty-state">表示できる計測がありません。</div>';return;}
 const stride=Math.max(1,Math.ceil(rows.length/800));const displayed=rows.filter((row,i)=>i%stride===0||row.isImpact||i===rows.length-1);
 const values=displayed.map(row=>row[key]).filter(finite),max=Math.max(1,...values)*1.12,min=Math.min(0,...values),range=max-min||1;
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
function popup(title,lines){const container=document.createElement('div');container.className='map-popup';const heading=document.createElement('strong');heading.textContent=title;container.append(heading);for(const line of lines){const p=document.createElement('p');p.textContent=line;container.append(p);}return container;}
function initializeMap(){
 map=L.map('map',{zoomControl:true,attributionControl:true}).setView([35.5556,139.657],16);map.attributionControl.setPrefix('Leaflet');
 const Grid=L.GridLayer.extend({createTile(coords){const tile=document.createElement('div');tile.className='coordinate-grid coordinate-tile';const latLng=map.unproject(L.point(coords.x*256,coords.y*256),coords.z);tile.textContent=`${latLng.lat.toFixed(4)}, ${latLng.lng.toFixed(4)}`;return tile;}});
 grid=new Grid({tileSize:256,attribution:'座標プレビュー / 背景地図なし'}).addTo(map);overlay=L.layerGroup().addTo(map);
 $('fit-map').addEventListener('click',()=>{map.invalidateSize();if(fitBounds?.isValid())map.fitBounds(fitBounds,{padding:[30,30],maxZoom:17});});
 $('basemap').addEventListener('change',()=>{
  if($('basemap').checked){
   tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'});
   let warned=false;tiles.on('tileerror',()=>{if(!warned){warned=true;toast('背景地図を取得できません。チェックを外すと座標プレビューに戻れます。');}});
   grid.remove();tiles.addTo(map);set('map-note','背景地図はOpenStreetMapから取得します。架空の軌跡は実際の道路や路面状態を示しません。');
  }else{tiles?.remove();grid.addTo(map);set('map-note','座標プレビュー：背景地図なしでも操作できます。区画は中心点で表示します。');}
 });
}
function renderMap(preserveView=false){
 if(!map)return;overlay.clearLayers();recordMarkers=new Map();selectedMarker=null;fitBounds=L.latLngBounds([]);
 const rows=state.detail?.measurements??[];let segment=[];const finish=()=>{if(segment.length>1)L.polyline(segment,{color:'#238267',weight:3.5,opacity:.85}).addTo(overlay);segment=[];};
 for(const row of rows){if(!finite(row.latitude)||!finite(row.longitude)){finish();continue;}const point=[row.latitude,row.longitude];segment.push(point);fitBounds.extend(point);}
 finish();
 const displayedCells=state.cells.slice(0,500);
 for(const cell of displayedCells){const marker=L.circleMarker([cell.centerLat,cell.centerLon],{radius:Math.min(15,5+Math.sqrt(cell.sampleCount)),color:cell.evalStatus==='evaluated'?'#5b9294':'#99a39b',weight:1.4,fillColor:cell.evalStatus==='evaluated'?'#83b0ad':'#d9ddd5',fillOpacity:.28,dashArray:cell.evalStatus==='evaluated'?undefined:'4 3'}).bindPopup(popup(cell.cellId,[`平均振動：${number(cell.avgVibration,2)}m/s²`,`測定 ${cell.sampleCount}件 / 衝撃 ${cell.impactCount}回`,`状態：${cellState(cell.evalStatus)}`,`全配送の集計 / ${datetime(cell.updatedAt)} JST`])).addTo(overlay);if(!rows.some(row=>finite(row.latitude)))fitBounds.extend(marker.getLatLng());}
 const usable=rows.filter(row=>finite(row.latitude)&&finite(row.longitude));
 const stride=Math.max(1,Math.ceil(usable.length/800));
 usable.forEach((row,i)=>{if(i%stride!==0&&!row.isImpact&&i!==usable.length-1)return;const marker=L.circleMarker([row.latitude,row.longitude],{radius:row.isImpact?6:2.5,color:row.isImpact?'#c5644c':'#348a70',weight:row.isImpact?2:1,fillColor:row.isImpact?'#dd765e':'#348a70',fillOpacity:finite(row.accuracyMeters)&&row.accuracyMeters>50?.25:.9}).bindPopup(popup(row.measurementId,[`${time(row.measuredAt)} JST / ${row.isImpact?'衝撃あり':'衝撃なし'}`,`スコア ${number(row.qualityScore,1)} / 振動 ${number(row.vibration,2)}`,`傾斜 ${number(row.tiltDegrees,1)}° / GPS精度 ${number(row.accuracyMeters,1)}m`])).addTo(overlay);recordMarkers.set(row.measurementId,marker);});
 if(usable.length){L.marker([usable[0].latitude,usable[0].longitude],{icon:L.divIcon({className:'map-start',html:'S',iconSize:[21,21]})}).bindPopup('受領した軌跡の先頭').addTo(overlay);}
 if(!preserveView){if(fitBounds.isValid())map.fitBounds(fitBounds,{padding:[32,32],maxZoom:17});else map.setView([35.5556,139.657],16);}
 if(state.cells.length>500)set('map-note',`地図は読み込み済みの先頭500区画を表示。区画一覧は読み込み済み${state.cells.length}件を表示します。`);
}
function renderRecords(){
 $('records-body').replaceChildren();const rows=(state.detail?.measurements??[]).filter(row=>!state.eventsOnly||row.isImpact),size=15,totalPages=Math.max(1,Math.ceil(rows.length/size));state.page=Math.min(state.page,totalPages-1);
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
 for(const cell of state.cells){const tr=document.createElement('tr');for(const value of [cell.cellId,cell.sampleCount,number(cell.avgVibration,2),number(cell.maxVibration,2),cell.impactCount,cellState(cell.evalStatus),datetime(cell.updatedAt)]){const td=document.createElement('td');td.textContent=value;tr.append(td);}const td=document.createElement('td'),button=document.createElement('button');button.className='button compact';button.textContent='地図で見る';button.addEventListener('click',()=>{switchView('monitor');setTimeout(()=>{map.setView([cell.centerLat,cell.centerLon],17);L.popup().setLatLng([cell.centerLat,cell.centerLon]).setContent(popup(cell.cellId,[`平均振動 ${number(cell.avgVibration,2)} / ${cell.sampleCount}件`,`状態：${cellState(cell.evalStatus)}`])).openOn(map);},50);});td.append(button);tr.append(td);$('cells-body').append(tr);}
 if(!state.cells.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=8;td.className='empty-row';td.textContent='GPS区画の集計データがありません。';tr.append(td);$('cells-body').append(tr);}
}
function openImport(){$('import-error').hidden=true;$('import-dialog').showModal();}
async function reset(mode){if(state.meta?.mode==='imported'&&!window.confirm('このPCに取り込んだデータを置き換えます。必要なら先にJSONを書き出してください。続けますか？'))return;try{await post('/api/local/reset',{mode});await reload();toast(mode==='empty'?'データを空にしました。3種類を順に取り込めます。':'データセットを切り替えました。');}catch(error){alert(error.message);}}
$('search').addEventListener('input',renderList);$('reload').addEventListener('click',reload);
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
function refreshIsCurrent(snapshot){return !$('reload').disabled&&!state.detailBusy&&!$('more-deliveries').disabled&&!$('more-cells').disabled&&snapshot.reloadToken===state.reloadToken&&snapshot.loadToken===state.loadToken&&snapshot.deliveries===state.deliveries&&snapshot.cells===state.cells&&snapshot.detail===state.detail&&snapshot.detailCursor===state.detail?.nextToken;}
async function refreshDashboard(){
 if(refreshing||document.hidden||$('reload').disabled||state.detailBusy||$('more-deliveries').disabled||$('more-cells').disabled)return;
 refreshing=true;
 const snapshot={...state,detailCursor:state.detail?.nextToken};
 try{
  const [list,cells]=await Promise.all([
   refreshPages('/api/deliveries',50,'items',state.deliveries.length),
   refreshPages('/api/cells',100,'items',state.cells.length)
  ]);
  let id=snapshot.selectedId??list.items[0]?.deliveryId??null,detail=null;
  if(id){
   try{detail=await refreshPages(`/api/deliveries/${encodeURIComponent(id)}`,500,'measurements',snapshot.detail?.measurements.length??500,!!snapshot.detail&&!snapshot.detail.nextToken);}
   catch(error){
    if(error.status!==404)throw error;
    id=list.items.find(row=>row.deliveryId!==id)?.deliveryId??null;
    if(id)detail=await request(`/api/deliveries/${encodeURIComponent(id)}?limit=500`);
   }
  }
  if(!refreshIsCurrent(snapshot))return;
  ++state.reloadToken;++state.loadToken;
  state.deliveries=list.items;state.listCursor=list.nextToken??null;state.meta=list.meta;
  state.cells=cells.items;state.cellsCursor=cells.nextToken??null;state.detail=detail;state.selectedId=id;
  if(id!==snapshot.selectedId)state.page=0;
  set('connection',cloudMode?'AWS参照APIに接続':base?'参照APIに接続':'ローカルAPIに接続');
  set('mode-badge',modeLabel());set('dataset-label',state.meta.label);alert('');
  renderList();renderCells();renderDetail(id===snapshot.selectedId);
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
