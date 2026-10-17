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
  this.busy=false;this.lastRefresh=0;this.timer=null;this.error='';this.hiddenDrivers=new Set();this.referenceMode='learned';this.lastRender=null;this.pitDriver='44';this.pitManual=null;this.pitEnabled=true;this.smoothingSeconds=0;this.viewport=null;this.referenceLapAdjustment=0;this.drag=null;
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
   this.shadowRoot.innerHTML='<style>:host{display:block}ha-card{display:block;padding:16px;background:var(--ha-card-background,var(--card-background-color,#18202d));color:var(--primary-text-color,#eee)}canvas{width:100%;height:auto;display:block}p{font:12px system-ui;color:var(--secondary-text-color,#aab)}.controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:10px 0}.controls select,.controls button,.controls input{background:#263447;color:#fff;border:1px solid #566578;border-radius:5px;padding:5px;cursor:pointer}.pit{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0;font:12px system-ui}.pit input{width:75px}.smooth input{width:125px;vertical-align:middle}.smooth{font:12px system-ui}.pitlog{font:12px system-ui;margin:5px 0;color:var(--secondary-text-color,#aab)}.legend{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.legend button{font:12px system-ui;border:1px solid #64748b;border-radius:5px;background:#182235;color:white;padding:3px 7px;cursor:pointer}.legend button.off{opacity:.35}</style><ha-card><h3>Race Trace GPS</h3><p id="status"></p><div class="controls"><label>Reference <select id="reference"><option value="learned">Learned clean-lap pace</option><option value="leader">Leader GPS</option></select></label><button id="showall">Show all drivers</button><button id="resetview">Reset view</button><span id="refshift"></span><label class="smooth">Smoothing <input id="smoothing" type="range" min="0" max="10" step="1" value="0"> <span id="smoothingvalue">0s</span></label></div><div class="pit"><label><input type="checkbox" id="pitshow" checked> Pit projections</label><label>Driver <select id="pitdriver"></select></label><label>Pit loss <input id="pitloss" type="number" min="0" max="180" step="0.1" placeholder="—"> s</label><button id="pitreset" disabled>Calculating…</button></div><div class="pitlog" id="pitlog"></div><canvas width="1100" height="460"></canvas><div class="legend" id="legend"></div></ha-card>';
  }
  const status=this.shadowRoot.querySelector('#status'),canvas=this.shadowRoot.querySelector('canvas');
  const refSelect=this.shadowRoot.querySelector('#reference');
  refSelect.value=this.referenceMode;
  const smoothing=this.shadowRoot.querySelector('#smoothing');
  smoothing.value=String(this.smoothingSeconds);
  this.shadowRoot.querySelector('#smoothingvalue').textContent=this.smoothingSeconds+'s';
  smoothing.oninput=()=>{this.smoothingSeconds=Number(smoothing.value);this.draw();};
  refSelect.onchange=()=>{this.referenceMode=refSelect.value;this.draw();};
  this.shadowRoot.querySelector('#showall').onclick=()=>{this.hiddenDrivers.clear();this.draw();};
  canvas.style.height=this.config.height+'px';
  canvas.style.touchAction='none';
  this.shadowRoot.querySelector('#resetview').onclick=()=>{
   this.viewport=null;this.referenceLapAdjustment=0;this.draw();
  };
  this.shadowRoot.querySelector('#refshift').textContent=
   this.referenceLapAdjustment?'Reference lap adjustment '+(this.referenceLapAdjustment>0?'+':'')+this.referenceLapAdjustment.toFixed(1)+'s/lap':'';
  // Drag preview stays INSIDE the canvas: never transform the DOM element.
  canvas.onpointerdown=e=>{
   const rect=canvas.getBoundingClientRect();
   const px=(e.clientX-rect.left)/rect.width;
   const snapshot=document.createElement('canvas');
   snapshot.width=canvas.width;snapshot.height=canvas.height;
   snapshot.getContext('2d').drawImage(canvas,0,0);
   this.drag={pointer:e.pointerId,x:e.clientX,y:e.clientY,
    zone:px<.25?'y':px>.75?'reference':'both',
    start:this.viewport?{...this.viewport}:null,
    reference:this.referenceLapAdjustment,dx:0,dy:0,snapshot};
   canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove=e=>{
   const drag=this.drag;if(!drag||drag.pointer!==e.pointerId||!this.viewport)return;
   drag.dx=e.clientX-drag.x;drag.dy=e.clientY-drag.y;
   const rect=canvas.getBoundingClientRect();
   const sx=canvas.width/rect.width,sy=canvas.height/rect.height;
   const ctx=canvas.getContext('2d');
   ctx.fillStyle='#0b1220';ctx.fillRect(0,0,canvas.width,canvas.height);
   ctx.save();ctx.beginPath();ctx.rect(52,15,canvas.width-70,canvas.height-47);ctx.clip();
   const offsetX=drag.zone==='both'?drag.dx*sx:0;
   const offsetY=drag.zone==='reference'?0:drag.dy*sy;
   ctx.drawImage(drag.snapshot,offsetX,offsetY);
   ctx.restore();
   if(drag.zone==='reference'){
    const adjustment=drag.reference-Math.round(drag.dy/10)/10;
    this.shadowRoot.querySelector('#refshift').textContent=
     'Reference '+(adjustment>0?'+':'')+adjustment.toFixed(1)+'s/lap';
   }
  };
  const endDrag=e=>{
   const drag=this.drag;if(!drag||drag.pointer!==e.pointerId)return;
   this.drag=null;
   if(!this.viewport)return;
   const rect=canvas.getBoundingClientRect();
   const dx=drag.dx/rect.width,dy=drag.dy/rect.height;
   if(drag.zone==='reference'){
    this.referenceLapAdjustment=drag.reference-Math.round(drag.dy/10)/10;
   }else{
    const v=drag.start||this.viewport,xr=v.xMax-v.xMin,yr=v.yMax-v.yMin;
    this.viewport={...v,xMin:v.xMin-(drag.zone==='both'?dx*xr:0),
     xMax:v.xMax-(drag.zone==='both'?dx*xr:0),
     yMin:v.yMin-dy*yr,yMax:v.yMax-dy*yr};
   }
   this.draw();
  };
  canvas.onpointerup=endDrag;canvas.onpointercancel=endDrag;
  canvas.onwheel=e=>{
   e.preventDefault();
   if(!this.viewport)return;
   const rect=canvas.getBoundingClientRect();
   const fx=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));
   const fy=Math.max(0,Math.min(1,(e.clientY-rect.top)/rect.height));
   const factor=e.deltaY>0?1.2:1/1.2;
   const v=this.viewport;
   const cx=v.xMin+fx*(v.xMax-v.xMin),cy=v.yMin+fy*(v.yMax-v.yMin);
   const xr=Math.max(.15,Math.min(100,(v.xMax-v.xMin)*factor));
   const yr=Math.max(1,Math.min(2000,(v.yMax-v.yMin)*factor));
   this.viewport={xMin:cx-fx*xr,xMax:cx+(1-fx)*xr,
    yMin:cy-fy*yr,yMax:cy+(1-fy)*yr};
   this.draw();
  };
  if(!this.gps||!this.timing){status.textContent=this.error||'Waiting for GPS and timing recordings';return;}
  try{
   function crossingAt(track,d){
    for(let i=1;i<track.length;i++){
     const a=track[i-1],b=track[i],dx=b[1]-a[1];
     if(dx>1e-7&&a[1]<=d&&b[1]>=d)
      return a[2]+(d-a[1])/dx*(b[2]-a[2]);
    }
    return null;
   }
   // Heavy GPS projection, alignment and clean-lap learning are cached.
   // Viewport, reference-time adjustment and smoothing must not invalidate it.
   const key=[this.gps.samples.length,this.gps.samples.at(-1)?.recorded_at,
    this.timing.samples.length,this.timing.samples.at(-1)?.timestamp].join(':');
   if(!this.processed||this.processedKey!==key){
    this.processedKey=key;
    this.processed=(()=>{
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
     if(d.retired===true||[d.status,d.driver_status,d.race_status,d.gap,d.gap_to_leader].some(retiredStatus))
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
    // Locate a sustained stop BEFORE retirement. GPS may resume moving
    // when a retired car is recovered/towed; that later motion is not racing.
    // Search for the earliest 30-second stationary spell in the last ten
    // minutes before the official OUT transition.
    let stopIndex=-1;
    if(Number.isFinite(retirement)){
     for(let i=1;i<gps.length;i++){
      if(gps[i].t>retirement)break;
      if(gps[i].t<retirement-600)continue;
      const j=gps.findIndex((p,k)=>k>i&&p.t>=gps[i].t+30);
      if(j<0||gps[j].t>retirement)continue;
      let stable=true;
      for(let k=i;k<=j;k++){
       if(Math.hypot(gps[k].x-gps[i].x,gps[k].y-gps[i].y)>5){stable=false;break;}
      }
      if(stable){
       const idx=bounded.findLastIndex(p=>p[2]<=gps[i].t);
       if(idx>=0&&bounded[idx][1]>=1){stopIndex=i;break;}
      }
     }
    }
    if(stopIndex>=0){
     const markerIndex=bounded.findLastIndex(p=>p[2]<=gps[stopIndex].t);
     if(markerIndex>=0){
      const lastMoving=bounded[markerIndex];
      traces.set(id,bounded.slice(0,markerIndex+1));
      markers.set(id,lastMoving);
      stopped++;
     }
    }else{
     // For a non-retired driver retain at most five seconds of the
     // current stationary spell, allowing small GPS coordinate jitter.
     const endGPS=gps.findLastIndex(p=>p.t<=endTime);
     if(endGPS<1)continue;
     const finalPosition=gps[endGPS];
     let currentStop=endGPS;
     while(currentStop>0&&
      Math.hypot(gps[currentStop-1].x-finalPosition.x,
                 gps[currentStop-1].y-finalPosition.y)<=5)
      currentStop--;
     const stationaryStart=gps[currentStop].t;
     if(endTime-stationaryStart>=5){
      traces.set(id,bounded.filter(p=>p[2]<=stationaryStart+5));
      stopped++;
     }
     if(Number.isFinite(retirement)){
      // No confident stop detected: do not invent a retirement location.
      traces.set(id,bounded);
     }
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

    return {traces,events,aligned,referenceId,ref,markers,stopped,
      selected,typical,learned,cleanLaps};
    })();
   }
   const {traces,events,aligned,referenceId,ref,markers,stopped,
    selected,typical,learned,cleanLaps}=this.processed;
   const firstCross=events.filter(e=>String(e[0])===referenceId&&e[1]===2)[0];
   const originTime=firstCross?.[2]??crossingAt(ref,1);
   // Normalised lap-time shape is shared by all drivers. Anchor it to
   // the reference car at its first racing lap crossing.
   const referenceAdjustment=this.referenceLapAdjustment;
   function timeAtDistance(d){
    if(useLearned&&Number.isFinite(originTime)){
     const phase=((d-1)%1+1)%1,lap=Math.floor(d-1);
     const q=phase*100,j=Math.min(99,Math.floor(q)),f=q-j;
     return originTime+(lap+learned[j]*(1-f)+learned[j+1]*f)*(typical+referenceAdjustment);
    }
    if(d<ref[0][1]||d>ref.at(-1)[1])return null;
    let lo=0,hi=ref.length-1;
    while(hi-lo>1){const mid=(lo+hi)>>1;if(ref[mid][1]<d)lo=mid;else hi=mid;}
    const u=ref[hi][1]-ref[lo][1];
    return u>0?ref[lo][2]+(d-ref[lo][1])/u*(ref[hi][2]-ref[lo][2])+(d-1)*referenceAdjustment:null;
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
   // Provisional pit detection from GPS lap-time excess. Compare each driver's
   // complete laps against their own clean-lap median; use two-lap windows
   // to capture entry and exit across the timing line. A lap is a candidate
   // only when GPS shows a sustained stop or a pronounced slowdown.
   if(!this.pitCache||this.pitCacheKey!==this.processedKey){
    this.pitCacheKey=this.processedKey;
    this.pitCache=(()=>{
   const pitStops=[];
   const gpsByDriver=new Map();
   const frames=RaceTraceRecordingSync.gpsFrames(this.gps);
   for(const frame of frames)for(const [id,x,y] of frame.d){
    if(!gpsByDriver.has(id))gpsByDriver.set(id,[]);
    gpsByDriver.get(id).push({t:frame.t,x,y});
   }
   for(const [id,track] of traces){
    const completed=[];
    for(let lap=Math.max(1,Math.ceil(track[0][1]));lap<track.at(-1)[1];lap++){
     const t0=crossingAt(track,lap),t1=crossingAt(track,lap+1);
     if(Number.isFinite(t0)&&Number.isFinite(t1)&&t1>t0)
      completed.push({lap,t0,t1,duration:t1-t0});
    }
    const normal=completed.map(p=>p.duration).filter(v=>v>75&&v<180).sort((a,b)=>a-b);
    if(normal.length<4)continue;
    // Lower-half median resists long pit laps, safety cars and traffic.
    const base=normal[Math.floor(normal.length*.35)];
    const gps=gpsByDriver.get(id)||[];
    for(const p of completed){
     const slowdown=p.duration-base;
     if(slowdown<9||p.duration>base+110)continue;
     const inWindow=gps.filter(g=>g.t>=p.t0-5&&g.t<=p.t1+5);
     let stationary=false;
     for(let j=0;j+3<inWindow.length;j++){
      const a=inWindow[j];
      for(let k=j+3;k<inWindow.length&&inWindow[k].t-a.t<=45;k++){
       if(inWindow[k].t-a.t>=3&&Math.hypot(inWindow[k].x-a.x,inWindow[k].y-a.y)<5){
        stationary=true;break;
       }
      }
      if(stationary)break;
     }
     if(!stationary)continue;
     // Exclude stops overlapping official neutralisation periods.
     const neutral=this.timing.samples.some(s=>s.timestamp>=p.t0&&s.timestamp<=p.t1&&
      /^(SC|VSC|SAFETY CAR|VIRTUAL SAFETY CAR)$/i.test(String(s.track_status||'')));
     pitStops.push({id,lap:p.lap,loss:slowdown,neutral,method:'lap-excess'});
    }
   }

     return pitStops;
    })();
   }
   const pitStops=this.pitCache;
   const validStops=pitStops.filter(p=>!p.neutral&&p.loss>=9&&p.loss<=60)
    .sort((a,b)=>a.loss-b.loss);
   const quantile=(values,q)=>{
    if(!values.length)return null;
    const index=(values.length-1)*q,lo=Math.floor(index),f=index-lo;
    return values[lo].loss*(1-f)+values[Math.min(lo+1,values.length-1)].loss*f;
   };
   const expected=quantile(validStops,.25);
   const pitDriverSelect=this.shadowRoot.querySelector('#pitdriver');
   pitDriverSelect.replaceChildren();
   for(const id of series.keys()){
    const opt=document.createElement('option');
    opt.value=id;opt.textContent='#'+id;pitDriverSelect.append(opt);
   }
   if(!series.has(this.pitDriver))this.pitDriver=series.keys().next().value;
   pitDriverSelect.value=this.pitDriver;
   pitDriverSelect.onchange=()=>{this.pitDriver=pitDriverSelect.value;this.draw();};
   const pitInput=this.shadowRoot.querySelector('#pitloss');
   const pitReset=this.shadowRoot.querySelector('#pitreset');
   const effectiveLoss=this.pitManual===null?expected:this.pitManual;
   if(this.shadowRoot.activeElement!==pitInput)pitInput.value=Number.isFinite(effectiveLoss)?effectiveLoss.toFixed(1):'';
   pitInput.onchange=()=>{
    const v=Number(pitInput.value);
    if(pitInput.value!==''&&Number.isFinite(v)&&v>=0&&v<=180){
     this.pitManual=Math.round(v*10)/10;this.draw();
    }
   };
   pitReset.textContent=Number.isFinite(expected)?'Use '+expected.toFixed(1)+'s':'No estimate yet';
   pitReset.disabled=!Number.isFinite(expected);
   pitReset.onclick=()=>{this.pitManual=null;this.draw();};
   const pitShow=this.shadowRoot.querySelector('#pitshow');
   pitShow.checked=this.pitEnabled;
   pitShow.onchange=()=>{this.pitEnabled=pitShow.checked;this.draw();};
   this.shadowRoot.querySelector('#pitlog').textContent=
    'Pit-loss log (provisional lap-excess method): '+
    (pitStops.length?pitStops.map(p=>'#'+p.id+' L'+p.lap+' '+p.loss.toFixed(1)+'s'+(p.neutral?' [SC/VSC]':'')).join(' · '):'No verified candidates')+
    ' · '+validStops.length+' eligible · P25 '+(Number.isFinite(expected)?expected.toFixed(1)+'s':'n/a');
   // Centred, time-weighted smoothing of gap (seconds), not distance.
   // Work on displayed trajectories only: raw GPS remains untouched for
   // calibration, pit detection and retirement positioning.
   if(this.smoothingSeconds>0){
    const half=this.smoothingSeconds/2;
    for(const [id,pts] of series){
     const rawTrack=traces.get(id)||[];
     const samples=rawTrack.map(p=>{
      const t=timeAtDistance(p[1]);
      return {d:p[1],time:p[2],gap:Number.isFinite(t)?p[2]-t:null};
     }).filter(p=>p.d>=1&&Number.isFinite(p.gap));
     if(samples.length!==pts.length)continue;
     const smoothed=samples.map((p,i)=>{
      let sum=0,weight=0;
      for(let j=i;j>=0&&p.time-samples[j].time<=half;j--){
       const w=Math.max(.001,1-Math.abs(samples[j].time-p.time)/(half+.001));
       sum+=samples[j].gap*w;weight+=w;
      }
      for(let j=i+1;j<samples.length&&samples[j].time-p.time<=half;j++){
       const w=Math.max(.001,1-Math.abs(samples[j].time-p.time)/(half+.001));
       sum+=samples[j].gap*w;weight+=w;
      }
      return [p.d,sum/weight];
     });
     series.set(id,smoothed);
    }
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
   if(!this.viewport)this.viewport={xMin:minX,xMax:maxX,yMin:minGap,yMax:maxGap};
   const view=this.viewport;
   const x=v=>52+(v-view.xMin)/Math.max(.001,view.xMax-view.xMin)*(w-76);
   const y=v=>20+(v-view.yMin)/Math.max(.001,view.yMax-view.yMin)*(h-60);
   ctx.strokeStyle='#334155';ctx.lineWidth=1;ctx.font='12px system-ui';
   for(let lap=Math.ceil(view.xMin);lap<=view.xMax;lap++){
    ctx.beginPath();ctx.moveTo(x(lap),15);ctx.lineTo(x(lap),h-32);ctx.stroke();
    ctx.fillStyle='#aab';ctx.fillText('Lap '+lap,x(lap)+3,h-12);
   }
   const gapStep=Math.max(1,Math.ceil((view.yMax-view.yMin)/8));
   for(let g=Math.ceil(view.yMin/gapStep)*gapStep;g<=view.yMax;g+=gapStep){
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
    ctx.moveTo(x(start-minGap/lapSeconds),y(minGap));
    ctx.lineTo(x(end-minGap/lapSeconds),y(minGap));
    ctx.lineTo(x(end-maxGap/lapSeconds),y(maxGap));
    ctx.lineTo(x(start-maxGap/lapSeconds),y(maxGap));
    ctx.closePath();ctx.fill();
    ctx.setLineDash([5,5]);ctx.beginPath();
    ctx.moveTo(x(start-minGap/lapSeconds),y(minGap));
    ctx.lineTo(x(start-maxGap/lapSeconds),y(maxGap));ctx.stroke();ctx.setLineDash([]);
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

   }
   // Both projections are time shifts at the same race distance:
   // +loss: where the selected driver emerges after stopping;
   // -loss: the symmetric boundary for a rival stopping behind them.
   if(this.pitEnabled&&Number.isFinite(effectiveLoss)&&effectiveLoss>=0){
    const chosen=series.get(this.pitDriver);
    if(chosen?.length){
     for(const sign of [-1,1]){
      ctx.save();ctx.strokeStyle='#ffffff';
      ctx.lineWidth=1.8;ctx.globalAlpha=.9;ctx.setLineDash([2,5]);
      ctx.beginPath();
      chosen.forEach((p,j)=>j?ctx.lineTo(x(p[0]),y(p[1]+sign*effectiveLoss)):
       ctx.moveTo(x(p[0]),y(p[1]+sign*effectiveLoss)));
      ctx.stroke();ctx.restore();
     }
    }
   }
   ctx.restore();
   // Render retirement crosses last so other drivers cannot obscure them.
   // Outline in white, then colour the centre for contrast.
   for(const [id,point] of markers){
    if(this.hiddenDrivers.has(id))continue;
    const referenceTime=timeAtDistance(point[1]);
    if(!Number.isFinite(referenceTime))continue;
    const px=x(point[1]),py=y(point[2]-referenceTime);
    // Keep an off-scale retirement visible at the plot edge instead of
    // silently discarding it under percentile gap-axis clipping.
    if(!Number.isFinite(px)||!Number.isFinite(py))continue;
    const offscale=py<15||py>h-32;
    const visibleX=Math.max(63,Math.min(w-29,px));
    const visibleY=Math.max(27,Math.min(h-45,py));
    const size=6;
    ctx.lineCap='round';ctx.setLineDash([]);
    ctx.beginPath();ctx.moveTo(visibleX-size,visibleY-size);ctx.lineTo(visibleX+size,visibleY+size);
    ctx.moveTo(visibleX-size,visibleY+size);ctx.lineTo(visibleX+size,visibleY-size);
    ctx.strokeStyle='#ffffff';ctx.lineWidth=3.5;ctx.stroke();
    ctx.strokeStyle='#ef4444';ctx.lineWidth=2;ctx.stroke();
    ctx.lineCap='butt';
   }
   const retirementDebug=[...markers].map(([id,p])=>{
    const t=timeAtDistance(p[1]),g=Number.isFinite(t)?p[2]-t:null;
    return '#'+id+' lap '+p[1].toFixed(2)+' gap '+(g===null?'n/a':g.toFixed(1)+'s')+
     (g!==null&&(g<minGap||g>maxGap)?' OFF-SCALE':'');
   }).join('; ');
   status.textContent=series.size+' drivers · '+events.length+' official crossings · '+
    aligned.aligned.length+' aligned · reference car #'+referenceId+
    ' · '+(useLearned?'learned '+selected.length+' clean laps ('+typical.toFixed(1)+'s)':'leader GPS fallback')+
    ' · '+markers.size+' retired (X) · '+stopped+' stopped · gap at equal distance'+(retirementDebug?' · X: '+retirementDebug:'');
  }catch(e){status.textContent='Experimental diagnostics: '+e.message;}
 }
}
if(!customElements.get('race-trace-gps'))customElements.define('race-trace-gps',RaceTraceGPS);
