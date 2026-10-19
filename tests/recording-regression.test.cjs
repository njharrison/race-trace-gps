const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const gpsPath=process.env.RACE_TRACE_GPS_FIXTURE;
const timingPath=process.env.RACE_TRACE_TIMING_FIXTURE;
const both=Boolean(gpsPath&&timingPath);
const gps=both?JSON.parse(fs.readFileSync(gpsPath,'utf8')):null;
const timing=both?JSON.parse(fs.readFileSync(timingPath,'utf8')):null;
function atOrBefore(items,time){let lo=0,hi=items.length;while(lo<hi){const m=(lo+hi)>>1;if(items[m].t<=time)lo=m+1;else hi=m;}return lo?items[lo-1]:null;}
function lowerBound(items,value,key=x=>x){let lo=0,hi=items.length;while(lo<hi){const m=(lo+hi)>>1;if(key(items[m])<value)lo=m+1;else hi=m;}return lo;}
function hoverSegments(points,min,max){const first=Math.max(1,lowerBound(points,min,p=>p[0]));let lo=0,hi=points.length;while(lo<hi){const m=(lo+hi)>>1;if(points[m][0]<=max)lo=m+1;else hi=m;}return [first,Math.min(points.length-1,lo)];}
test('pit-window binary search matches naive filtering',()=>{
 const arr=Array.from({length:10000},(_,i)=>i*.73);
 for(let i=0;i<500;i++){const start=i*14.4,end=start+12.7;const from=lowerBound(arr,start),to=lowerBound(arr,end+1e-7);assert.deepEqual(arr.slice(from,to),arr.filter(x=>x>=start&&x<=end));}
});
test('hover window includes all intersecting sorted segments',()=>{
 const pts=Array.from({length:15000},(_,i)=>[i/1000,Math.sin(i/200)]);
 for(let k=0;k<100;k++){const min=k*.14,max=min+.09;const [first,last]=hoverSegments(pts,min,max);for(let j=1;j<pts.length;j++){if(pts[j][0]>=min&&pts[j-1][0]<=max)assert.ok(j>=first&&j<=last,`missing segment ${j}`);}}
});
test('historical lookup never returns future state',()=>{
 const history=[{t:100,tyre:'MEDIUM'},{t:200,tyre:'HARD'},{t:300,tyre:'SOFT'}];
 assert.equal(atOrBefore(history,199.999).tyre,'MEDIUM');assert.equal(atOrBefore(history,200).tyre,'HARD');assert.equal(atOrBefore(history,250).tyre,'HARD');assert.equal(atOrBefore(history,99),null);
});
test('real recordings share original session clock', {skip:!both},()=>{
 assert.equal(gps.schema_version,1);assert.equal(timing.schema_version,1);
 const a=gps.samples.map(s=>s.timestamp),b=timing.samples.map(s=>s.session_timestamp);
 assert.ok(a.length>1000&&b.length>100);
 assert.ok(Math.max(a[0],b[0])<=Math.min(a.at(-1),b.at(-1)));
 assert.ok(gps.samples.every(s=>Number.isFinite(s.timestamp)));
 assert.ok(timing.samples.every(s=>Number.isFinite(s.session_timestamp)));
});
test('Norris real recorded MEDIUM to HARD transition', {skip:!both},()=>{
 const states=timing.samples.map(s=>({t:s.session_timestamp,d:s.drivers.find(d=>String(d.id)==='1')})).filter(s=>s.d);
 const change=states.findIndex((s,i)=>i>0&&s.d.tyre_compound==='HARD'&&states[i-1].d.tyre_compound==='MEDIUM');
 assert.ok(change>0);
 assert.equal(atOrBefore(states,states[change-1].t).d.tyre_compound,'MEDIUM');
 assert.equal(atOrBefore(states,states[change].t).d.tyre_compound,'HARD');
 assert.ok(Number.isInteger(states[change].d.completed_laps));
});
test('Leclerc real recorded HARD to SOFT transition', {skip:!both},()=>{
 const states=timing.samples.map(s=>({t:s.session_timestamp,d:s.drivers.find(d=>String(d.id)==='16')})).filter(s=>s.d);
 const change=states.findIndex((s,i)=>i>0&&s.d.tyre_compound==='SOFT'&&states[i-1].d.tyre_compound==='HARD');
 assert.ok(change>0);
 assert.equal(atOrBefore(states,states[change-1].t).d.tyre_compound,'HARD');
 assert.equal(atOrBefore(states,states[change].t).d.tyre_compound,'SOFT');
});
test('recorded replay contains pause without equivalent source-clock jump', {skip:!both},()=>{
 const samples=gps.samples;
 const pauses=samples.filter((s,i)=>i>0&&s.recorded_at-samples[i-1].recorded_at>5&&(s.timestamp-samples[i-1].timestamp)<3);
 assert.ok(pauses.length>0);
});

test('timestamp-indexed calibration chooses same nearest GPS sample as full scan',()=>{
 const frames=Array.from({length:20000},(_,i)=>({t:i*.4,d:i%7?[['1',i,1]]:[['2',i,2]]}));
 const original=(time,windowSeconds,driver)=>{
  let best=null;
  for(const frame of frames){const difference=Math.abs(frame.t-time);
   if(difference>windowSeconds||best&&difference>=best.difference)continue;
   const position=frame.d.find(d=>String(d[0])===String(driver));
   if(position)best={difference,position};
  }return best;
 };
 const indexed=(time,windowSeconds,driver)=>{
  let best=null,lo=0,hi=frames.length;
  const earliest=time-windowSeconds;
  while(lo<hi){const mid=(lo+hi)>>1;if(frames[mid].t<earliest)lo=mid+1;else hi=mid;}
  for(let i=lo;i<frames.length&&frames[i].t<=time+windowSeconds;i++){
   const frame=frames[i],difference=Math.abs(frame.t-time);
   if(best&&difference>=best.difference)continue;
   const position=frame.d.find(d=>String(d[0])===String(driver));
   if(position)best={difference,position};
  }return best;
 };
 for(let k=0;k<2000;k++){const t=k*3.97;assert.deepEqual(indexed(t,3,'1'),original(t,3,'1'));}
});

test('official Piastri lap 57 crossing is after the chequered flag', {skip:!both},()=>{
 const flag=timing.race_control.find(e=>/CHEQUERED FLAG/i.test(e.message||''));
 assert.ok(flag);
 const flagTime=Date.parse(flag.utc)/1000;
 const crossing=timing.samples.find(s=>s.session_timestamp>=flagTime&&
  s.drivers.some(d=>String(d.id)==='81'&&Number(d.completed_laps)>=57));
 assert.ok(crossing,'Piastri must complete lap 57 after the flag');
 assert.ok(gps.samples.some(s=>s.timestamp>crossing.session_timestamp&&
  s.drivers.some(d=>String(d.id)==='81')),'GPS must continue after Piastri finish');
});
test('official finish crossing takes precedence over GPS fallback',()=>{
 const src=fs.readFileSync(require('node:path').join(__dirname,'..','race-trace-gps.js'),'utf8');
 assert.match(src,/if\(crossing&&\(!current\|\|current\.source!=='flag crossing'\)\)/);
 assert.doesNotMatch(src,/Math\.abs\(current\.time-crossing\.time\)>8/);
});
