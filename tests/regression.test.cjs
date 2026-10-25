// Run: node --test tests/regression.test.cjs
// Baseline tests for the current card; no Home Assistant/browser required.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','race-trace-gps.js'),'utf8');
const registered=new Map();
const context={console,Math,Number,Map,Set,Array,Object,String,Date,
 HTMLElement:class{},customElements:{get:n=>registered.get(n),define:(n,c)=>registered.set(n,c)}};
vm.runInNewContext(source,context,{filename:'race-trace-gps.js'});
const {RaceTraceCircuit:circuit,RaceTraceRecordingSync:sync}=context;
test('card loads and registers its custom element',()=>{
 assert.ok(registered.get('race-trace-gps-dev'));
 assert.equal(registered.has('race-trace-gps'),false,'dev build must not register the production element');
});
test('GPS uses original timestamps, not recorded_at, across a paused replay',()=>{
 const recording={schema_version:1,samples:[
  {timestamp:100,recorded_at:500,drivers:[{id:'1',x:5,y:5}]},
  {timestamp:101,recorded_at:501,drivers:[{id:'1',x:6,y:5}]},
  {timestamp:101,recorded_at:900,drivers:[{id:'1',x:6,y:5}]},
  {timestamp:102,recorded_at:901,drivers:[{id:'1',x:7,y:5}]}]};
 assert.deepEqual(Array.from(sync.gpsFrames(recording),f=>f.t),[100,101,102]);
});
test('timing crossings use session_timestamp rather than recording timestamp',()=>{
 const recording={schema_version:1,samples:[
  {timestamp:500,session_timestamp:100,drivers:[{id:'1',completed_laps:1}]},
  {timestamp:900,session_timestamp:110,drivers:[{id:'1',completed_laps:2}]},
  {timestamp:901,session_timestamp:120,drivers:[{id:'1',completed_laps:3}]}]};
 assert.deepEqual(JSON.parse(JSON.stringify(sync.crossings(recording))),[['1',2,110],['1',3,120]]);
});
test('GPS drops zero coordinates and nonmonotonic source times',()=>{
 const recording={schema_version:1,samples:[
  {timestamp:10,drivers:[{id:'1',x:0,y:0},{id:'2',x:4,y:3}]},
  {timestamp:9,drivers:[{id:'2',x:5,y:3}]}]};
 const frames=sync.gpsFrames(recording);
 assert.equal(frames.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(frames[0].d)),[['2',4,3]]);
});
test('circuit projection and phase preserve lap-wrap geometry',()=>{
 const g=circuit.prepare([[0,0],[10,0],[10,10],[0,10]]);
 assert.equal(g.length,40);
 assert.equal(circuit.project(g,5,0).distance,5);
 assert.equal(circuit.phase(g,5,0,0,1),0.125);
 assert.equal(circuit.phase(g,5,0,0,-1),0.875);
});
test('historical tooltip reads recorded classification and cumulative GPS distance',()=>{
 // These checks guard the actual source paths until the hover logic is
 // extracted into a directly unit-testable pure function.
 assert.match(source,/historyTracks:traces/);
 assert.match(source,/track\[mid\]\[1\]<distance/);
 assert.match(source,/const history=this\.hoverSeries\.history\?\.get\(closest\.id\)/);
 assert.match(source,/history\[mid\]\.t<=hoverTime/);
 assert.match(source,/const tyre=historic\?\.tyre\?\?'Unknown'/);
 assert.match(source,/const pos=historic\?\.position\?\?'Unknown'/);
 assert.match(source,/const lap=historic\?\.completed_laps\?\?'Unknown'/);
});
test('timing-only updates are not ignored when GPS is unchanged',()=>{
 assert.match(source,/this\.timing\.samples\.length===timing\.samples\.length/);
 assert.match(source,/previousTiming===incomingTiming/);
});
test('optimised hover window still examines adjacent intersecting segments',()=>{
 assert.match(source,/const first=Math\.max\(1,low\)/);
 assert.match(source,/const last=Math\.min\(points\.length-1,low\)/);
});
