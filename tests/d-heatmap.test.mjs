import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {validateRecords,readQuery} from '../services/query/local-contract.mjs';
import {createDynamoReader} from '../services/query/dynamo-reader.mjs';

const fixture=JSON.parse(await readFile(new URL('../data/samples/d-dashboard/c-shared-example.json',import.meta.url),'utf8'));
const source=await readFile(new URL('../apps/dashboard/app.js',import.meta.url),'utf8');
const cell=fixture.cells[0];
function dashboard(){
 const elements=new Map(),rectangles=[],moves=[],circles=[],lines=[],points=[];
 const element=()=>({children:[],style:{},classList:{toggle(){}},addEventListener(){},setAttribute(){},
  append(...nodes){this.children.push(...nodes);},replaceChildren(){this.children=[];}});
 const document={getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},
  querySelectorAll(){return [];},createElement:element,addEventListener(){}};
 const bounds={extend(point){points.push(point);return this;},isValid(){return true;}};
 const layer=()=>({bindPopup(){return this;},addTo(){return this;}});
 const L={circleMarker(point,style){circles.push({point,style});return layer();},polyline(points){lines.push(points);return layer();},marker:layer,divIcon:()=>({}),latLngBounds:()=>bounds,rectangle(bounds,style){
  const layer={bounds,style,bindPopup(content){this.content=content;return this;},addTo(){rectangles.push(this);return this;},setStyle(style){this.style=style;return this;}};
  return layer;
 }};
 const context=vm.createContext({document,window:{DASHBOARD_CONFIG:{},addEventListener(){}},L,Intl,console,setTimeout,clearTimeout});
 const api=vm.runInContext(`${source.replace('initializeMap();await reload();scheduleRefresh();','')}
 map={fitBounds(){moves.push('fit');},setView(){moves.push('set');}};overlay={clearLayers(){rectangles.length=0;}};
 ({state,renderMap,renderCells,cellBounds,cellScore,cellScoreLabel,cellHeatStyle,updateHeatmapOpacity});`,vm.createContext({...context,moves,rectangles}));
 return {...api,rectangles,elements,moves,circles,lines,points};
}
test('C共有の区画スコアをローカルAPIとDynamoDB APIでそのまま返す',async()=>{
 assert.equal(readQuery(fixture,'/api/cells').items[0].avgScore,68);
 const reader=createDynamoReader({names:{analysis:'analysis',summaries:'summaries',cells:'cells'},
  scan:async()=>({Items:[{...cell,avgScore:{N:'68'}}]})});
 assert.equal((await reader('/api/cells')).items[0].avgScore,68);
});
test('旧形式の未取得値を許容し、不正な区画スコアは拒否する',()=>{
 const {avgScore,...legacy}=cell;
 assert.equal(validateRecords('cells',[legacy])[0].avgScore,undefined);
 assert.equal(validateRecords('cells',[{...cell,avgScore:null}])[0].avgScore,null);
 for(const value of [-1,101,'68',NaN,Infinity])assert.throws(()=>validateRecords('cells',[{...cell,avgScore:value}]),/avgScore/);
});
test('0・50・100点で色が変わり、同じスコアなら測定件数で変わらない',()=>{
 const app=dashboard();
 assert.equal(app.cellHeatStyle({...cell,avgScore:0}).fillColor,'#c6423a');
 assert.equal(app.cellHeatStyle({...cell,avgScore:50}).fillColor,'#f1c14b');
 assert.equal(app.cellHeatStyle({...cell,avgScore:100}).fillColor,'#17898f');
 assert.deepEqual(app.cellHeatStyle({...cell,sampleCount:3}),app.cellHeatStyle({...cell,sampleCount:10000}));
 assert.equal(app.cellHeatStyle(cell).fillOpacity,.35);
 assert.equal(app.cellHeatStyle(cell).pane,'cell-heatmap');
});
test('0点と未取得は異なる表示で、参考値は破線にする',()=>{
 const app=dashboard();assert.equal(app.cellScoreLabel({...cell,avgScore:0}),'0 / 100');
 assert.equal(app.cellScoreLabel({...cell,avgScore:null}),'未取得');
 assert.equal(app.cellHeatStyle({...cell,avgScore:null}).fillColor,'#737b80');
 assert.equal(app.cellHeatStyle({...cell,evalStatus:'reference'}).dashArray,'4 3');
 assert.equal(app.cellHeatStyle(cell).dashArray,undefined);
});
test('円ではなくCの区画幅の面を描画し、501区画目も表示する',()=>{
 const app=dashboard();app.state.cells=Array.from({length:501},(_,i)=>({...cell,cellId:String(i)}));
 app.renderMap(true);assert.equal(app.rectangles.length,501);assert.equal(app.moves.length,0);
 const rectangle=app.rectangles[0];
 assert(Math.abs(rectangle.bounds[1][0]-rectangle.bounds[0][0]-.0005)<1e-10);
 assert(Math.abs(rectangle.bounds[1][1]-rectangle.bounds[0][1]-.0005)<1e-10);
 assert.equal(rectangle.content.children[1].textContent,'区画平均スコア：68 / 100');
});
test('不透明度を変更し、自動再描画でも保持し、0%では枠も非表示にする',()=>{
 const app=dashboard();app.state.cells=[cell];app.renderMap(true);
 app.updateHeatmapOpacity(60);assert.equal(app.rectangles[0].style.fillOpacity,.6);
 assert.equal(app.elements.get('heatmap-opacity-value').textContent,'60%');
 app.renderMap(true);assert.equal(app.rectangles[0].style.fillOpacity,.6);
 app.updateHeatmapOpacity(0);assert.equal(app.rectangles[0].style.fillOpacity,0);assert.equal(app.rectangles[0].style.opacity,0);
});
test('路面区画の一覧にも平均スコアと未取得を表示する',()=>{
 const app=dashboard();app.state.cells=[cell,{...cell,cellId:'legacy',avgScore:null}];app.renderCells();
 const rows=app.elements.get('cells-body').children;
 assert.equal(rows[0].children[2].textContent,'68 / 100');assert.equal(rows[1].children[2].textContent,'未取得');
});

test('軌跡に含まれない衝撃も全件描画し、重複・座標なしを除いて範囲に含める',()=>{
 const app=dashboard();
 const base={isImpact:false,latitude:35,longitude:139};
 app.state.detail={deliveryId:'A',measurements:[{...base,measurementId:'start'},{...base,measurementId:'shared',isImpact:true}],impacts:[{...base,measurementId:'shared',isImpact:true},{...base,measurementId:'hidden',isImpact:true,latitude:36,longitude:140},{...base,measurementId:'no-gps',isImpact:true,latitude:null,longitude:null}]};
 app.state.selectedId='A';app.renderMap(true);
 assert.equal(app.circles.filter(circle=>circle.style.radius===6).length,2);
 assert.equal(app.circles.length,3);assert(app.points.some(([lat,lon])=>lat===36&&lon===140));
 assert.equal(app.lines[0].length,2); // 衝撃の補完点を軌跡に結んで形を変えない。
 app.state.mapMode='all';app.state.allMapDetails=[app.state.detail];app.renderMap(true);
 assert.equal(app.circles.filter(circle=>circle.style.radius===6).length,4);
});
