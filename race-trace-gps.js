/* Self-contained experimental Home Assistant card; generated from src modules. */
/* Circuit-independent geometry helpers. */
(function(root){
'use strict';
function prepare(points){
 if(!Array.isArray(points)||points.length<3)throw Error('Missing centreline');
 const segments=[];let length=0;
 for(let i=0;i<points.length;i++){
  const a=points[i],b=points[(i+1)%points.length];
  const dx=b[0]-a[0],dy=b[1]-a[1],size=Math.hypot(dx,dy);
  if(size>0){segments.push({a,dx,dy,size,start:length});length+=size;}
 }
 if(!length)throw Error('Empty centreline');
 return {segments,length};
}
function project(geometry,x,y){
 let best={distance:0,error:Infinity};
 for(const s of geometry.segments){
  const u=Math.max(0,Math.min(1,((x-s.a[0])*s.dx+(y-s.a[1])*s.dy)/(s.size*s.size)));
  const error=Math.hypot(x-s.a[0]-u*s.dx,y-s.a[1]-u*s.dy);
  if(error<best.error)best={distance:s.start+u*s.size,error};
 }
 return best;
}
function phase(geometry,x,y,finishDistance,direction){
 if(!Number.isFinite(finishDistance)||![1,-1].includes(direction))throw Error('Missing start/finish calibration');
 const distance=project(geometry,x,y).distance;
 return ((distance-finishDistance)*direction%geometry.length+geometry.length)%geometry.length/geometry.length;
}
root.RaceTraceCircuit=Object.freeze({prepare,project,phase});
if(typeof module!=='undefined'&&module.exports)module.exports=root.RaceTraceCircuit;
})(typeof globalThis!=='undefined'?globalThis:this);

/* Convert the HA timing recorder's completed-lap counters into
 * lap-crossing events in the same wall-clock domain as GPS recorded_at.
 * Do not confuse GPS timestamp (race replay clock) with recorded_at.
 */
(function(root){
'use strict';
function crossings(recording){
 if(recording?.schema_version!==1||!Array.isArray(recording.samples))throw Error('Invalid timing recording');
 const previous=new Map(),events=[];
 for(const sample of recording.samples){
  if(!Number.isFinite(sample.timestamp))continue;
  for(const driver of sample.drivers||[]){
   const id=String(driver.id??'');
   const lap=driver.completed_laps;
   if(!id||!Number.isInteger(lap))continue;
   const prior=previous.get(id);
   if(prior!==undefined&&lap>prior&&lap-prior===1)
    events.push([id,lap,sample.timestamp]);
   previous.set(id,lap);
  }
 }
 return events;
}
function gpsFrames(recording){
 if(recording?.schema_version!==1||!Array.isArray(recording.samples))throw Error('Invalid GPS recording');
 return recording.samples.filter(s=>Number.isFinite(s.recorded_at)).map(s=>({
  t:s.recorded_at,
  d:(s.drivers||[]).filter(d=>d&&Number.isFinite(d.x)&&Number.isFinite(d.y)&&!(d.x===0&&d.y===0))
    .map(d=>[String(d.id),d.x,d.y])
 }));
}
root.RaceTraceRecordingSync=Object.freeze({crossings,gpsFrames});
if(typeof module!=='undefined'&&module.exports)module.exports=root.RaceTraceRecordingSync;
})(typeof globalThis!=='undefined'?globalThis:this);

/* Derive circuit start/finish from official lap transitions and GPS positions.
 * Inputs are timestamps in the same clock domain, not HA recording wall time.
 */
(function(root){
'use strict';
function calibrate(geometry,frames,lapCrossings,{windowSeconds=3}={}){
 if(!Array.isArray(lapCrossings)||!lapCrossings.length)throw Error('Missing lap transitions');
 const candidates=[];
 for(const [driver,completed,time] of lapCrossings){
  if(completed<2||!Number.isFinite(time))continue;
  let best=null;
  for(const frame of frames){
   const difference=Math.abs(frame.t-time);
   if(difference>windowSeconds||best&&difference>=best.difference)continue;
   const position=frame.d.find(d=>String(d[0])===String(driver));
   if(position)best={difference,position};
  }
  if(best){
   const p=root.RaceTraceCircuit.project(geometry,best.position[1],best.position[2]);
   candidates.push({driver:String(driver),distance:p.distance,error:p.error,difference:best.difference});
  }
 }
 if(!candidates.length)throw Error('No matching GPS observations near lap transitions');
 // Circular mean handles the start/finish position near the geometry seam.
 let sin=0,cos=0;
 for(const c of candidates){
  const angle=2*Math.PI*c.distance/geometry.length;
  sin+=Math.sin(angle);cos+=Math.cos(angle);
 }
 const concentration=Math.hypot(sin,cos)/candidates.length;
 const initial=(Math.atan2(sin,cos)+2*Math.PI)%(2*Math.PI)*geometry.length/(2*Math.PI);
 const circularDelta=(a,b)=>((a-b+geometry.length*1.5)%geometry.length)-geometry.length/2;
 const offsets=candidates.map(c=>circularDelta(c.distance,initial)).sort((a,b)=>a-b);
 const median=offsets[Math.floor(offsets.length/2)];
 const centre=((initial+median)%geometry.length+geometry.length)%geometry.length;
 const deviations=candidates.map(c=>Math.abs(circularDelta(c.distance,centre))).sort((a,b)=>a-b);
 const medianDeviation=deviations[Math.floor(deviations.length/2)];
 const cutoff=Math.max(medianDeviation*3,geometry.length*0.002);
 const accepted=candidates.filter(c=>Math.abs(circularDelta(c.distance,centre))<=cutoff);
 const acceptedDrivers=new Set(accepted.map(c=>c.driver)).size;
 const acceptedConcentration=Math.hypot(...[accepted.reduce((n,c)=>n+Math.sin(2*Math.PI*c.distance/geometry.length),0),accepted.reduce((n,c)=>n+Math.cos(2*Math.PI*c.distance/geometry.length),0)])/accepted.length;
 const confidence=acceptedDrivers>=3&&accepted.length>=6&&acceptedConcentration>=0.98&&
   medianDeviation<=geometry.length*0.02;
 return {distance:centre,concentration,count:candidates.length,
   acceptedCount:accepted.length,driverCount:acceptedDrivers,
   medianDeviation,acceptedConcentration,confidence,candidates};
}
root.RaceTraceCalibration=Object.freeze({calibrate});
if(typeof module!=='undefined'&&module.exports)module.exports=root.RaceTraceCalibration;
})(typeof globalThis!=='undefined'?globalThis:this);

/* Experimental timing-led alignment of already-unwrapped driver tracks.
 * A track point is [frameIndex, unwrappedLapDistance, raceTime].
 * Never infer lap count from a pit-lane shortcut alone.
 */
(function(root){
'use strict';
function align(tracks,official,{windowSeconds=45}={}){
 const diagnostics={aligned:[],missing:[]};
 for(const [id,points] of tracks){
  const events=official.filter(e=>String(e[0])===String(id)&&e[1]>=2)
    .sort((a,b)=>a[2]-b[2]);
  const first=events[0];
  if(!first||points.length<2){diagnostics.missing.push(String(id));continue;}
  const time=first[2];
  let closest=null;
  for(let i=1;i<points.length;i++){
   const a=points[i-1],b=points[i];
   if(a[2]>time||b[2]<time||b[2]===a[2])continue;
   const fraction=(time-a[2])/(b[2]-a[2]);
   const value=a[1]+fraction*(b[1]-a[1]);
   const proximity=Math.min(time-a[2],b[2]-time);
   if(!closest||proximity<closest.proximity)
    closest={value,proximity,interval:b[2]-a[2]};
  }
  if(!closest||closest.interval>windowSeconds*2){
   diagnostics.missing.push(String(id));continue;
  }
  // Lap 1 is the first racing lap. Official 1->2 occurs at its end.
  const shift=1-closest.value;
  for(const point of points)point[1]+=shift;
  diagnostics.aligned.push({driver:String(id),shift,interval:closest.interval});
 }
 return diagnostics;
}
root.RaceTraceOfficialAlignment=Object.freeze({align});
if(typeof module!=='undefined'&&module.exports)module.exports=root.RaceTraceOfficialAlignment;
})(typeof globalThis!=='undefined'?globalThis:this);

/* F1 Race Trace experimental Home Assistant card.
 * Separate custom element/resource; production card remains untouched.
 * Consumes GPS and timing recording schema_version 1.
 */
class RaceTraceGPS extends HTMLElement {
 constructor(){
  super();this.attachShadow({mode:'open'});this.gps=null;this.timing=null;
  this.busy=false;this.lastRefresh=0;this.timer=null;this.error='';this.hiddenDrivers=new Set();this.referenceMode='learned';this.lastRender=null;
 }
 setConfig(config){
  this.config={gps_url:'/local/f1-race-trace/gps-recording.json',
   timing_url:'/local/f1-race-trace/live-recording.json',height:460,...config};
  this.draw();
 }
 set hass(hass){this._hass=hass;}
 connectedCallback(){this.refresh();this.timer=setInterval(()=>this.refresh(),5000);}
 disconnectedCallback(){clearInterval(this.timer);this.timer=null;}
 getCardSize(){return 9;}
 static getStubConfig(){return {};}
 async refresh(){
  if(!this.config||this.busy)return;
  this.busy=true;
  try{
   const [gps,timing]=await Promise.all([this.config.gps_url,this.config.timing_url]
    .map(async url=>{const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw Error(url+': HTTP '+r.status);return r.json();}));
   if(gps.schema_version!==1||timing.schema_version!==1)throw Error('Expected recording schema_version 1');
   if(!Array.isArray(gps.geometry?.points)||!Array.isArray(gps.samples)||!Array.isArray(timing.samples))
    throw Error('Missing GPS geometry or samples');
   this.gps=gps;this.timing=timing;this.error='';this.draw();
  }catch(e){this.error=String(e);this.draw();}
  finally{this.busy=false;}
 }
 draw(){
  if(!this.shadowRoot||!this.config)return;
  if(!this.shadowRoot.querySelector('canvas')){
   this.shadowRoot.innerHTML='<style>:host{display:block}ha-card{display:block;padding:16px;background:var(--ha-card-background,var(--card-background-color,#18202d));color:var(--primary-text-color,#eee)}canvas{width:100%;height:auto;display:block}p{font:12px system-ui;color:var(--secondary-text-color,#aab)}.controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:10px 0}.controls select,.controls button{background:#263447;color:#fff;border:1px solid #566578;border-radius:5px;padding:5px;cursor:pointer}.legend{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.legend button{font:12px system-ui;border:1px solid #64748b;border-radius:5px;background:#182235;color:white;padding:3px 7px;cursor:pointer}.legend button.off{opacity:.35}</style><ha-card><h3>Race Trace GPS</h3><p id="status"></p><div class="controls"><label>Reference <select id="reference"><option value="learned">Learned clean-lap pace</option><option value="leader">Leader GPS</option></select></label><button id="showall">Show all drivers</button></div><canvas width="1100" height="460"></canvas><div class="legend" id="legend"></div></ha-card>';
  }
  const status=this.shadowRoot.querySelector('#status'),canvas=this.shadowRoot.querySelector('canvas');
  const refSelect=this.shadowRoot.querySelector('#reference');
  refSelect.value=this.referenceMode;
  refSelect.onchange=()=>{this.referenceMode=refSelect.value;this.draw();};
  this.shadowRoot.querySelector('#showall').onclick=()=>{this.hiddenDrivers.clear();this.draw();};
  canvas.style.height=this.config.height+'px';
  if(!this.gps||!this.timing){status.textContent=this.error||'Waiting for GPS and timing recordings';return;}
  try{
   const points=this.gps.geometry.points.map(p=>Array.isArray(p)?p:[p.x,p.y]);
   const geometry=RaceTraceCircuit.prepare(points);
   const frames=RaceTraceRecordingSync.gpsFrames(this.gps);
   const events=RaceTraceRecordingSync.crossings(this.timing).filter(e=>e[1]>=2);
   const calibration=RaceTraceCalibration.calibrate(geometry,frames,events);
   if(!calibration.confidence)throw Error('Start/finish calibration confidence insufficient');
   const traces=new Map(),previous=new Map();
   // Direction from robust signed centreline displacement across nearby samples.
   const changes=[];
   for(const frame of frames.slice(0,Math.min(frames.length,250))){
    for(const [id,x,y] of frame.d){
     const d=RaceTraceCircuit.project(geometry,x,y).distance,prev=previous.get(id);
     if(prev){let delta=d-prev.d;if(delta>geometry.length/2)delta-=geometry.length;if(delta< -geometry.length/2)delta+=geometry.length;
      if(frame.t-prev.t>0&&frame.t-prev.t<8&&Math.abs(delta)>20&&Math.abs(delta)<geometry.length*.08)changes.push(delta);}
     previous.set(id,{d,t:frame.t});
    }
   }
   changes.sort((a,b)=>a-b);
   const direction=(changes[Math.floor(changes.length/2)]||1)<0?-1:1;
   const last=new Map();
   for(const frame of frames)for(const [id,x,y] of frame.d){
    const phase=RaceTraceCircuit.phase(geometry,x,y,calibration.distance,direction);
    const prev=last.get(id);
    if(!traces.has(id))traces.set(id,[]);
    let unwrapped=phase;
    if(prev){
     let step=phase-prev.phase;if(step>0.5)step-=1;if(step< -0.5)step+=1;
     unwrapped=prev.value+(step>=-.03&&step<.2?step:0);
    }
    traces.get(id).push([0,unwrapped,frame.t]);
    last.set(id,{phase,value:unwrapped});
   }
   const aligned=RaceTraceOfficialAlignment.align(traces,events);
   // A stationary car remains visible for up to five seconds. If it is
   // officially retired, replace the stationary tail with an X at the last
   // moving point. Use actual GPS movement (metres), not centreline phase:
   // pit-lane projection can move while the car itself is stationary.
   const retirementAt=new Map();
   const retiredStatus=value=>/^(RETIRED|RET|DNF|OUT)$/i.test(String(value??'').trim());
   for(const sample of this.timing.samples){
    for(const d of sample.drivers||[]){
     const id=String(d.id??d.racing_number??'');
     if(!id||retirementAt.has(id))continue;
     if(d.retired===true||[d.status,d.driver_status,d.race_status].some(retiredStatus))
      retirementAt.set(id,Number(sample.timestamp));
    }
   }
   const markers=new Map();
   let stopped=0;
   const gpsByDriver=new Map();
   for(const frame of frames)for(const [id,x,y] of frame.d){
    if(!gpsByDriver.has(id))gpsByDriver.set(id,[]);
    gpsByDriver.get(id).push({t:frame.t,x,y});
   }
   for(const [id,track] of traces){
    if(track.length<2)continue;
    const gps=gpsByDriver.get(id)||[];
    const retirement=retirementAt.get(id);
    // Ignore post-retirement GPS updates even if the car is transported.
    if(Number.isFinite(retirement)){
     let lastIndex=track.findIndex(p=>p[2]>retirement);
     if(lastIndex<0)lastIndex=track.length;
     traces.set(id,track.slice(0,lastIndex));
    }
    const bounded=traces.get(id);
    if(!bounded.length)continue;
    const endTime=bounded.at(-1)[2];
    let moving=0;
    // Latest GPS sample that changed physical position by at least 1 metre.
    // The last moving point is the sample immediately before the stop.
    for(let i=1;i<gps.length;i++){
     if(gps[i].t>endTime)break;
     if(Math.hypot(gps[i].x-gps[i-1].x,gps[i].y-gps[i-1].y)>=1)
      moving=i;
    }
    const stationaryStart=gps[moving]?.t;
    if(!Number.isFinite(stationaryStart))continue;
    const stationaryFor=endTime-stationaryStart;
    if(Number.isFinite(retirement)){
     // Do not manufacture a retirement location when GPS is still moving.
     const markerIndex=bounded.findLastIndex(p=>p[2]<=stationaryStart);
     if(markerIndex>=0){
      const lastMoving=bounded[markerIndex];
      traces.set(id,bounded.slice(0,markerIndex+1));
      markers.set(id,lastMoving);
      stopped++;
     }
    }else if(stationaryFor>=5){
     // Show at most 5 seconds of stationary GPS observations, as a
     // vertical trace, then freeze. On a later restart the line resumes.
     const cutoff=stationaryStart+5;
     traces.set(id,bounded.filter(p=>p[2]<=cutoff));
     stopped++;
    }
   }
   // Learn a race-wide pace curve from clean, complete laps across drivers.
   // Each sample's fractional lap position is associated with elapsed time
   // from its preceding lap boundary. Median across laps at 1% bins, then
   // enforce monotonicity. This avoids importing Singapore-specific profiles.
   const eligible=[...traces].filter(([,v])=>v.length>2);
   if(!eligible.length)throw Error('No usable driver trajectories');
   eligible.sort((a,b)=>b[1].at(-1)[1]-a[1].at(-1)[1]);
   const [referenceId,reference]=eligible[0];
   const ref=reference.filter((p,i)=>!i||p[1]>reference[i-1][1]+1e-7);
   function crossingAt(track,d){
    for(let i=1;i<track.length;i++){
     const a=track[i-1],b=track[i],dx=b[1]-a[1];
     if(dx>1e-7&&a[1]<=d&&b[1]>=d)
      return a[2]+(d-a[1])/dx*(b[2]-a[2]);
    }
    return null;
   }
   const cleanLaps=[];
   for(const [,track] of eligible){
    const monotone=track.filter((p,i)=>!i||p[1]>=track[i-1][1]-0.005);
    for(let lap=Math.max(1,Math.ceil(monotone[0][1]));lap<monotone.at(-1)[1];lap++){
     const t0=crossingAt(monotone,lap),t1=crossingAt(monotone,lap+1);
     if(t0===null||t1===null)continue;
     const duration=t1-t0;
     if(duration<75||duration>180)continue;
     const bins=[];
     for(let j=0;j<=100;j++){
      const t=crossingAt(monotone,lap+j/100);
      if(t===null)break;
      bins.push((t-t0)/duration);
     }
     if(bins.length===101&&bins.every((v,j)=>!j||v>=bins[j-1]-.0001))
      cleanLaps.push({duration,bins});
    }
   }
   const median=arr=>{const s=arr.slice().sort((a,b)=>a-b);return s[Math.floor(s.length/2)];};
   const typical=cleanLaps.length>=5?median(cleanLaps.map(l=>l.duration)):null;
   const selected=typical===null?[]:cleanLaps.filter(l=>Math.abs(l.duration-typical)<12);
   const learned=selected.length>=5?Array.from({length:101},(_,j)=>
    j===0?0:j===100?1:median(selected.map(l=>l.bins[j]))):null;
   if(learned)for(let j=1;j<101;j++)learned[j]=Math.max(learned[j],learned[j-1]+1e-7);
   const useLearned=this.referenceMode==='learned'&&learned!==null;
   const firstCross=events.filter(e=>String(e[0])===referenceId&&e[1]===2)[0];
   const originTime=firstCross?.[2]??crossingAt(ref,1);
   // Normalised lap-time shape is shared by all drivers. Anchor it to
   // the reference car at its first racing lap crossing.
   function timeAtDistance(d){
    if(useLearned&&Number.isFinite(originTime)){
     const phase=((d-1)%1+1)%1,lap=Math.floor(d-1);
     const q=phase*100,j=Math.min(99,Math.floor(q)),f=q-j;
     return originTime+(lap+learned[j]*(1-f)+learned[j+1]*f)*typical;
    }
    if(d<ref[0][1]||d>ref.at(-1)[1])return null;
    let lo=0,hi=ref.length-1;
    while(hi-lo>1){const mid=(lo+hi)>>1;if(ref[mid][1]<d)lo=mid;else hi=mid;}
    const u=ref[hi][1]-ref[lo][1];
    return u>0?ref[lo][2]+(d-ref[lo][1])/u*(ref[hi][2]-ref[lo][2]):null;
   }
   const series=new Map();
   for(const [id,track] of traces){
    const pts=[];
    for(const p of track){
     const t=timeAtDistance(p[1]);
     if(t!==null&&Number.isFinite(t))pts.push([p[1],p[2]-t]);
    }
    if(pts.length>1)series.set(id,pts);
   }
   // Only plot racing laps; keep pre-race observations available for calibration.
   for(const [id,pts] of series){
    const filtered=pts.filter(p=>p[0]>=1);
    if(filtered.length<2)series.delete(id);else series.set(id,filtered);
   }
   const all=[...series.values()].flat();
   if(!all.length)throw Error('No overlapping race distances for gap calculation');
   const minX=Math.min(...all.map(p=>p[0])),maxX=Math.max(...all.map(p=>p[0]));
   const gapValues=all.map(p=>p[1]).sort((a,b)=>a-b);
   // Clip extremes so an anomalous projection cannot flatten the entire plot.
   let minGap=Math.min(-2,gapValues[Math.floor(gapValues.length*.01)]-2);
   let maxGap=Math.max(2,gapValues[Math.floor(gapValues.length*.99)]+2);
   if(maxGap-minGap<5){minGap-=2;maxGap+=2;}
   const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
   ctx.clearRect(0,0,w,h);ctx.fillStyle='#0b1220';ctx.fillRect(0,0,w,h);
   const x=v=>52+(v-minX)/Math.max(.001,maxX-minX)*(w-76);
   const y=v=>20+(v-minGap)/(maxGap-minGap)*(h-60);
   ctx.strokeStyle='#334155';ctx.lineWidth=1;ctx.font='12px system-ui';
   for(let lap=Math.ceil(minX);lap<=maxX;lap++){
    ctx.beginPath();ctx.moveTo(x(lap),15);ctx.lineTo(x(lap),h-32);ctx.stroke();
    ctx.fillStyle='#aab';ctx.fillText('Lap '+lap,x(lap)+3,h-12);
   }
   const gapStep=Math.max(1,Math.ceil((maxGap-minGap)/8));
   for(let g=Math.ceil(minGap/gapStep)*gapStep;g<=maxGap;g+=gapStep){
    ctx.beginPath();ctx.moveTo(50,y(g));ctx.lineTo(w-18,y(g));ctx.stroke();
    ctx.fillStyle='#aab';ctx.fillText(g+'s',4,y(g)+4);
   }
   // Neutralisation periods from recorded track status; status changes are
   // authoritative and must not be inferred from a driver's speed alone.
   const periods=[];
   let active=null;
   for(const sample of this.timing.samples){
    const value=String(sample.track_status||'').toUpperCase();
    const type=/^(VSC|VIRTUAL SAFETY CAR)$/.test(value)?'VSC':
      /^(SC|SAFETY CAR)$/.test(value)?'SC':null;
    if(type!==active?.type){
     if(active){active.end=sample.timestamp;periods.push(active);}
     active=type?{type,start:sample.timestamp}:null;
    }
   }
   if(active){active.end=this.timing.samples.at(-1).timestamp;periods.push(active);}
   const refDistanceAtTime=t=>{
    if(t<ref[0][2]||t>ref.at(-1)[2])return null;
    let lo=0,hi=ref.length-1;
    while(hi-lo>1){const mid=(lo+hi)>>1;if(ref[mid][2]<t)lo=mid;else hi=mid;}
    const dt=ref[hi][2]-ref[lo][2];
    return dt>0?ref[lo][1]+(t-ref[lo][2])/dt*(ref[hi][1]-ref[lo][1]):null;
   };
   const lapDurations=[];
   for(let lap=Math.ceil(ref[0][1]);lap<ref.at(-1)[1];lap++){
    const start=timeAtDistance(lap),end=timeAtDistance(lap+1);
    if(start!==null&&end!==null&&end>start&&end-start<240)lapDurations.push(end-start);
   }
   lapDurations.sort((a,b)=>a-b);
   const lapSeconds=useLearned?typical:(lapDurations[Math.floor(lapDurations.length/2)]||100);
   ctx.save();ctx.beginPath();ctx.rect(52,15,w-70,h-47);ctx.clip();
   // A time interval maps to diagonal boundaries in gap/distance space.
   for(const p of periods){
    if(!(p.end>p.start))continue;
    const start=refDistanceAtTime(p.start),end=refDistanceAtTime(p.end);
    if(start===null||end===null)continue;
    ctx.fillStyle=p.type==='VSC'?'rgba(234,179,8,.16)':'rgba(251,146,60,.16)';
    ctx.strokeStyle=p.type==='VSC'?'#eab308':'#fb923c';
    ctx.beginPath();
    ctx.moveTo(x(start+minGap/lapSeconds),y(minGap));
    ctx.lineTo(x(end+minGap/lapSeconds),y(minGap));
    ctx.lineTo(x(end+maxGap/lapSeconds),y(maxGap));
    ctx.lineTo(x(start+maxGap/lapSeconds),y(maxGap));
    ctx.closePath();ctx.fill();
    ctx.setLineDash([5,5]);ctx.beginPath();
    ctx.moveTo(x(start+minGap/lapSeconds),y(minGap));
    ctx.lineTo(x(start+maxGap/lapSeconds),y(maxGap));ctx.stroke();ctx.setLineDash([]);
    ctx.font='bold 13px system-ui';ctx.fillText(p.type,x(start)+4,30);
   }
   const colors=['#fb7185','#38bdf8','#a3e635','#fbbf24','#c084fc','#2dd4bf','#f472b6','#93c5fd'];
   let i=0;
   const driverMeta=new Map();
   for(const sample of this.timing.samples)for(const d of sample.drivers||[]){
    const id=String(d.id??'');if(id)driverMeta.set(id,d);
   }
   const legend=this.shadowRoot.querySelector('#legend');legend.replaceChildren();
   const colours=new Map();let colourIndex=0;
   for(const [id,points] of series){
    const meta=driverMeta.get(id)||{};
    const label=String(meta.tla||meta.abbreviation||meta.name||meta.driver_name||('#'+id));
    const explicit=String(meta.team_color||'');
    const color=/^#[0-9a-f]{6}$/i.test(explicit)?explicit:colors[colourIndex%colors.length];
    colourIndex++;colours.set(id,color);
    const button=document.createElement('button');
    button.textContent=label+' #'+id;
    button.style.borderColor=color;
    if(this.hiddenDrivers.has(id))button.classList.add('off');
    button.onclick=()=>{if(this.hiddenDrivers.has(id))this.hiddenDrivers.delete(id);else this.hiddenDrivers.add(id);this.draw();};
    legend.append(button);
   }
   for(const [id,points] of series){
    if(this.hiddenDrivers.has(id))continue;
    const color=colours.get(id)||'#fff';i++;
    // A lapped car has a dashed counterpart one lap and one reference
    // lap-time away. Draw separately; never connect the two curves.
    ctx.strokeStyle=color;ctx.lineWidth=1.15;ctx.globalAlpha=.55;ctx.setLineDash([5,7]);
    ctx.beginPath();
    points.forEach((p,j)=>j?ctx.lineTo(x(p[0]+1),y(p[1]+lapSeconds)):ctx.moveTo(x(p[0]+1),y(p[1]+lapSeconds)));
    ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;
    ctx.lineWidth=id===referenceId&&!useLearned?2.5:1.5;ctx.beginPath();
    points.forEach((p,j)=>j?ctx.lineTo(x(p[0]),y(p[1])):ctx.moveTo(x(p[0]),y(p[1])));
    ctx.stroke();
    if(markers.has(id)){
     const point=markers.get(id);
     const t=timeAtDistance(point[1]);
     if(t!==null&&point[1]>=minX&&point[1]<=maxX){
      const px=x(point[1]),py=y(point[2]-t),size=8;
      ctx.strokeStyle=color;ctx.lineWidth=3.5;ctx.setLineDash([]);
      ctx.beginPath();ctx.moveTo(px-size,py-size);ctx.lineTo(px+size,py+size);
      ctx.moveTo(px-size,py+size);ctx.lineTo(px+size,py-size);ctx.stroke();
     }
    }
   }
   ctx.restore();
   status.textContent=series.size+' drivers · '+events.length+' official crossings · '+
    aligned.aligned.length+' aligned · reference car #'+referenceId+
    ' · '+(useLearned?'learned '+selected.length+' clean laps ('+typical.toFixed(1)+'s)':'leader GPS fallback')+
    ' · '+stopped+' stationary traces terminated · gap at equal distance';
  }catch(e){status.textContent='Experimental diagnostics: '+e.message;}
 }
}
if(!customElements.get('race-trace-gps'))customElements.define('race-trace-gps',RaceTraceGPS);
