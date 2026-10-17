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
  this.busy=false;this.lastRefresh=0;this.timer=null;this.error='';
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
   this.shadowRoot.innerHTML='<style>:host{display:block}ha-card{display:block;padding:16px;background:var(--ha-card-background,var(--card-background-color,#18202d));color:var(--primary-text-color,#eee)}canvas{width:100%;height:auto;display:block}p{font:12px system-ui;color:var(--secondary-text-color,#aab)}</style><ha-card><h3>Race Trace GPS</h3><p id="status"></p><canvas width="1100" height="460"></canvas></ha-card>';
  }
  const status=this.shadowRoot.querySelector('#status'),canvas=this.shadowRoot.querySelector('canvas');
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
   const all=[...traces.values()].flat(),minT=Math.min(...all.map(p=>p[2])),maxT=Math.max(...all.map(p=>p[2]));
   const minX=Math.min(...all.map(p=>p[1])),maxX=Math.max(...all.map(p=>p[1]));
   const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
   ctx.clearRect(0,0,w,h);ctx.fillStyle='#0b1220';ctx.fillRect(0,0,w,h);
   const x=v=>45+(v-minX)/Math.max(.001,maxX-minX)*(w-65);
   const y=t=>h-30-(t-minT)/Math.max(1,maxT-minT)*(h-55);
   ctx.strokeStyle='#334155';ctx.lineWidth=1;
   for(let lap=Math.ceil(minX);lap<=maxX;lap++){ctx.beginPath();ctx.moveTo(x(lap),15);ctx.lineTo(x(lap),h-30);ctx.stroke();ctx.fillStyle='#aab';ctx.fillText('Lap '+lap,x(lap)+3,h-12);}
   const colors=['#fb7185','#38bdf8','#a3e635','#fbbf24','#c084fc','#2dd4bf','#f472b6','#93c5fd'];
   let i=0;
   for(const [id,trace] of traces){
    ctx.strokeStyle=colors[i++%colors.length];ctx.lineWidth=1.5;ctx.beginPath();
    trace.forEach((p,j)=>j?ctx.lineTo(x(p[1]),y(p[2])):ctx.moveTo(x(p[1]),y(p[2])));
    ctx.stroke();
   }
   status.textContent=traces.size+' drivers · '+events.length+' official crossings · '+aligned.aligned.length+' aligned · '+(direction===1?'forward':'reverse')+' direction'+(this.error?' · '+this.error:'');
  }catch(e){status.textContent='Experimental diagnostics: '+e.message;}
 }
}
if(!customElements.get('race-trace-gps'))customElements.define('race-trace-gps',RaceTraceGPS);
