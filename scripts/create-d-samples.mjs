import {writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const dir=fileURLToPath(new URL('../data/samples/d-dashboard/',import.meta.url));
await mkdir(dir,{recursive:true});
const c={
  mode:'c-example',label:'C共有例（3種類・各1件）',sources:{analysis:'C共有例',summaries:'C共有例',cells:'C共有例'},
  analysis:[{measurementId:'sample-measurement-0001',deliveryId:'sample-delivery-001',measuredAt:'2026-10-05T00:00:00.000Z',qualityScore:95.0,vibration:0.0,isImpact:false,tiltDegrees:2.5,latitude:35.0,longitude:139.0,accuracyMeters:5.0,speedMetersPerSecond:3.0,algorithmVersion:'prototype-0.3'}],
  summaries:[{deliveryId:'sample-delivery-001',sampleCount:100,impactCount:3,avgScore:92.5,maxVibration:4.2,maxTilt:12.0,updatedAt:'2026-10-05T01:00:00.000Z'}],
  cells:[{cellId:'70000_278000',centerLat:35.0,centerLon:139.0,sampleCount:12,avgVibration:1.25,maxVibration:3.8,impactCount:2,evalStatus:'evaluated',updatedAt:'2026-10-05T01:00:00.000Z'}]
};
let seed=413;function random(){seed=(1664525*seed+1013904223)>>>0;return seed/2**32;}
const round=x=>Math.round(x*100)/100;
const demo={mode:'demo',label:'操作用デモ（架空の3配送）',sources:{analysis:'架空デモ',summaries:'架空デモ',cells:'架空デモ'},analysis:[],summaries:[],cells:[]};
const totals=new Map();
for(let trip=0;trip<3;trip++){
 const deliveryId=`demo-delivery-00${trip+1}`,count=[120,144,96][trip];
 const start=Date.parse(`2026-10-12T0${trip}:00:00.000Z`);
 const rows=[];
 for(let i=0;i<count;i++){
  const t=i/(count-1),angle=t*1.4*Math.PI;
  const latitude=35.5556+0.0015*Math.sin(angle)+trip*0.00008;
  const longitude=139.6558+0.003*t+0.0004*Math.sin(angle*2)+trip*0.00008;
  const isImpact=([44,78,105].includes(i)&&trip===0)||([23,51,79,106,130].includes(i)&&trip===1)||(i===46&&trip===2);
  const vibration=round(isImpact?3.3+random()*1.8:0.18+random()*0.7+trip*0.12);
  const tiltDegrees=i===62?null:round(2+random()*8+(isImpact?random()*10:0));
  const row={measurementId:`${deliveryId}-m-${String(i+1).padStart(4,'0')}`,deliveryId,measuredAt:new Date(start+i*2000).toISOString(),qualityScore:round(99-vibration*7-(tiltDegrees??0)*0.3),vibration,isImpact,tiltDegrees,latitude:i===61||i===62?null:latitude,longitude:i===61||i===62?null:longitude,accuracyMeters:i%29===0?65:round(3+random()*8),speedMetersPerSecond:round(2.5+random()*1.5),algorithmVersion:'demo-fixture-only'};
  rows.push(row);
  if(row.latitude!==null){
   // デモ専用の区画化。CのcellId規則を推測・再現しない。
   const gx=Math.floor((longitude-139.655)/0.0005),gy=Math.floor((latitude-35.554)/0.0005),cellId=`demo-cell-${gx}-${gy}`;
   if(!totals.has(cellId))totals.set(cellId,{cellId,centerLat:35.554+(gy+0.5)*0.0005,centerLon:139.655+(gx+0.5)*0.0005,sampleCount:0,sum:0,maxVibration:0,impactCount:0,updatedAt:row.measuredAt});
   const cell=totals.get(cellId);cell.sampleCount++;cell.sum+=vibration;cell.maxVibration=Math.max(cell.maxVibration,vibration);cell.impactCount+=Number(isImpact);cell.updatedAt=row.measuredAt;
  }
 }
 demo.analysis.push(...rows);
 demo.summaries.push({deliveryId,sampleCount:count,impactCount:rows.filter(r=>r.isImpact).length,avgScore:round(rows.reduce((s,r)=>s+r.qualityScore,0)/count),maxVibration:Math.max(...rows.map(r=>r.vibration)),maxTilt:Math.max(...rows.map(r=>r.tiltDegrees??0)),updatedAt:rows.at(-1).measuredAt});
}
demo.cells=[...totals.values()].map(({sum,...cell})=>({...cell,avgVibration:round(sum/cell.sampleCount),evalStatus:cell.sampleCount<5?'demo_insufficient':'evaluated'}));
await writeFile(`${dir}/c-shared-example.json`,JSON.stringify(c,null,2)+'\n');
await writeFile(`${dir}/demo.json`,JSON.stringify(demo,null,2)+'\n');
for(const type of ['analysis','summaries','cells'])await writeFile(`${dir}/c-${type}.json`,JSON.stringify(c[type],null,2)+'\n');
console.log(`D用サンプル：C共有例3件、架空デモ${demo.analysis.length}件・${demo.cells.length}区画`);
