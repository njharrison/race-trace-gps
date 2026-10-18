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

/* Align timing and GPS using the original F1 session clock when recorded.
 * Legacy recordings without session timestamps retain wall-clock fallback.
 */
(function(root){
'use strict';
function crossings(recording){
 if(recording?.schema_version!==1||!Array.isArray(recording.samples))throw Error('Invalid timing recording');
 const previous=new Map(),events=[];
 for(const sample of recording.samples){
  const clock=recording.samples.every(s=>Number.isFinite(s.session_timestamp))?sample.session_timestamp:sample.timestamp;
  if(!Number.isFinite(clock))continue;
  for(const driver of sample.drivers||[]){
   const id=String(driver.id??'');
   const lap=driver.completed_laps;
   if(!id||!Number.isInteger(lap))continue;
   const prior=previous.get(id);
   if(prior!==undefined&&lap>prior&&lap-prior===1)
    events.push([id,lap,clock]);
   previous.set(id,lap);
  }
 }
 return events;
}
function gpsFrames(recording,sourceClock=false){
 if(recording?.schema_version!==1||!Array.isArray(recording.samples))throw Error('Invalid GPS recording');
 return recording.samples.filter(s=>Number.isFinite(sourceClock?s.timestamp:s.recorded_at)).map(s=>({
  t:sourceClock?s.timestamp:s.recorded_at,
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
 const diagnostics={aligned:[],missing:[],provisional:[]};
 // Anchor on multiple genuine lap crossings, not the initial lap counter.
 // GPS may already contain one or more formation/pre-race circuits.
 for(const [id,points] of tracks){
  const events=official.filter(e=>String(e[0])===String(id)&&e[1]>=2&&Number.isFinite(e[2]))
   .sort((a,b)=>a[2]-b[2]);
  const candidates=[];
  for(const [driver,lap,time] of events){
   for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i];
    if(a[2]>time||b[2]<time||b[2]<=a[2])continue;
    const interval=b[2]-a[2];
    if(interval>windowSeconds*2)break;
    const value=a[1]+(time-a[2])/interval*(b[1]-a[1]);
    candidates.push({lap,shift:lap-value,interval});
    break;
   }
  }
  if(!candidates.length){
   diagnostics.missing.push(String(id));
   diagnostics.provisional.push(String(id));
   continue; // Keep the GPS trajectory visible; do not discard the driver.
  }
  const shifts=candidates.map(v=>v.shift).sort((a,b)=>a-b);
  const median=shifts[Math.floor(shifts.length/2)];
  const consistent=candidates.filter(v=>Math.abs(v.shift-median)<.18);
  // A single crossing is provisional; several agreeing crossings validate it.
  const shift=consistent.length?consistent.reduce((s,v)=>s+v.shift,0)/consistent.length:median;
  for(const point of points)point[1]+=shift;
  diagnostics.aligned.push({driver:String(id),shift,crossings:consistent.length,
   provisional:consistent.length<2,interval:consistent[0]?.interval??null});
  if(consistent.length<2)diagnostics.provisional.push(String(id));
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
  this.busy=false;this.lastRefresh=0;this.timer=null;this.error='';this.hiddenDrivers=new Set();this.referenceMode='learned';this.lastRender=null;this.pitDriver='44';this.pitManual=null;this.vscPitManual=null;this.pitEnabled=true;this.smoothingSeconds=5;this.viewport=null;this.liveView=false;this.referenceLapAdjustment=0;this.fuelEffect=0.03;this.drag=null;this.applyTimingCorrections=false;this.useDriverProfiles=true;this.hoverPoint=null;this.hoverSeries=null;this.gpsProjectionCache=new Map();this.lapProfileCache=new Map();
 }
 setConfig(config){
  this.config={gps_url:'/local/f1-race-trace/gps-recording.json',
   timing_url:'/local/f1-race-trace/live-recording.json',driver_entity:'sensor.f1_drivers_driver_positions',timing_delta_url:null,gps_delta_url:null,formation_lap:false,height:460,...config};
  this.draw();
 }
 set hass(hass){this._hass=hass;}
 connectedCallback(){this.refresh();this.timer=setInterval(()=>this.refresh(),5000);}
 disconnectedCallback(){clearInterval(this.timer);this.timer=null;this.resizeObserver?.disconnect();this.resizeObserver=null;}
 getCardSize(){return 9;}
 static getStubConfig(){return {};}
 async refresh(){
  if(!this.config||this.busy)return;
  this.busy=true;
  try{
   const loadJson=async url=>{
    const response=await fetch(url,{cache:'no-store'});
    if(!response.ok)throw Error(url+': HTTP '+response.status);
    return response.json();
   };
   const loadGps=async()=>{
    const previous=this.gps;
    if(previous){
     const deltaUrl=this.config.gps_delta_url||
      this.config.gps_url.replace(/\.json(?=\?|$)/,'-delta.json');
     if(deltaUrl!==this.config.gps_url)try{
      const delta=await loadJson(deltaUrl);
      const count=previous.samples.length;
      const runMatches=delta.run===previous.run&&
       delta.geometry?.circuit_key===previous.geometry?.circuit_key;
      const firstMatches=delta.first_recorded_at===previous.samples[0]?.recorded_at;
      if(delta.schema_version===1&&runMatches&&firstMatches&&
       Array.isArray(delta.samples)&&
       delta.sample_start<=count&&delta.sample_count>=count&&
       delta.sample_start+delta.samples.length===delta.sample_count){
       if(delta.sample_count===count)return previous;
       return {...previous,samples:previous.samples.concat(
        delta.samples.slice(count-delta.sample_start))};
      }
     }catch(_err){/* Missing, stale or invalid delta: full reload. */}
    }
    return loadJson(this.config.gps_url);
   };
   const loadTiming=async()=>{
    const previous=this.timing;
    if(previous){
     const deltaUrl=this.config.timing_delta_url||
      this.config.timing_url.replace(/\.json(?=\?|$)/,'-delta.json');
     if(deltaUrl!==this.config.timing_url)try{
      const delta=await loadJson(deltaUrl);
      const count=previous.samples.length,events=(previous.race_control||[]).length;
      if(delta.schema_version===1&&delta.run===previous.run&&
       Array.isArray(delta.samples)&&Array.isArray(delta.race_control)&&
       delta.sample_start<=count&&delta.event_start<=events&&
       delta.sample_count>=count&&delta.event_count>=events&&
       delta.sample_start+delta.samples.length===delta.sample_count&&
       delta.event_start+delta.race_control.length===delta.event_count){
       if(delta.sample_count===count&&delta.event_count===events)return previous;
       return {...previous,
        samples:previous.samples.concat(delta.samples.slice(count-delta.sample_start)),
        race_control:(previous.race_control||[]).concat(delta.race_control.slice(events-delta.event_start))};
      }
     }catch(_err){/* Fall back to full archive. */}
    }
    return loadJson(this.config.timing_url);
   };
   const [gps,timing]=await Promise.all([loadGps(),loadTiming()]);
   if(gps.schema_version!==1||timing.schema_version!==1)throw Error('Expected recording schema_version 1');
   if(!Array.isArray(gps.geometry?.points)||!Array.isArray(gps.samples)||!Array.isArray(timing.samples))
    throw Error('Missing GPS geometry or samples');
   // A replay restart can reset timing before GPS (or vice versa).
   // Clear derived traces immediately when EITHER recorder starts a new run.
   const gpsChanged=!!this.gps&&(this.gps.run!==gps.run||
     this.gps.geometry?.circuit_key!==gps.geometry?.circuit_key||
     this.gps.samples?.[0]?.timestamp!==gps.samples?.[0]?.timestamp||
     gps.samples.length<this.gps.samples.length);
   const timingChanged=!!this.timing&&(this.timing.run!==timing.run||
     this.timing.samples?.[0]?.timestamp!==timing.samples?.[0]?.timestamp||
     timing.samples.length<this.timing.samples.length);
   if(gpsChanged||timingChanged){
    this.processed=null;this.processedKey=null;this.lastRender=null;
    this.viewport=null;this.liveView=false;this.hiddenDrivers.clear();this.referenceLapAdjustment=0;this.gpsProjectionCache.clear();this.lapProfileCache.clear();
   }
   this.gps=gps;this.timing=timing;this.error='';this.draw();
  }catch(e){this.error=String(e);this.draw();}
  finally{this.busy=false;}
 }
 draw(){
  if(!this.shadowRoot||!this.config)return;
  if(!this.shadowRoot.querySelector('canvas')){
   this.shadowRoot.innerHTML='<style>:host{display:block}ha-card{display:block;padding:16px;background:var(--ha-card-background,var(--card-background-color,#18202d));color:var(--primary-text-color,#eee)}canvas{width:100%;height:460px;display:block}p{font:12px system-ui;color:var(--secondary-text-color,#aab)}.controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:10px 0}.controls select,.controls button,.controls input{background:#263447;color:#fff;border:1px solid #566578;border-radius:5px;padding:5px;cursor:pointer}.pit{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0;font:12px system-ui}.pit input{width:75px}.smooth input{width:125px;vertical-align:middle}.smooth{font:12px system-ui}.pitlog{font:12px system-ui;margin:5px 0;color:var(--secondary-text-color,#aab)}.legend{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.legend button{font:12px system-ui;border:1px solid #64748b;border-radius:5px;background:#182235;color:white;padding:3px 7px;cursor:pointer} .legend button.off{opacity:.35}.trace-tooltip{position:absolute;pointer-events:none;z-index:5;display:none;background:#101827f2;color:#f8fafc;border:1px solid #64748b;border-radius:7px;padding:8px 10px;font:12px system-ui;box-shadow:0 4px 16px #0008;white-space:nowrap}.trace-tooltip strong{display:block;font-size:13px;margin-bottom:4px}.trace-container{position:relative}</style><ha-card><h3>Race Trace GPS</h3><p id="status"></p><div class="controls"><label>Reference <select id="reference"><option value="learned">Learned clean-lap pace</option><option value="leader">Leader GPS</option></select></label><button id="resetview">Reset view</button><button id="liveview" aria-pressed="false">Live</button><label><input type="checkbox" id="timingcorrections"> Timing anchors</label><label><input type="checkbox" id="driverprofiles" checked> Driver profiles (experimental)</label><span id="refshift"></span><label>Fuel effect <input id="fueleffect" type="number" min="0" max="0.2" step="0.005" value="0.030" style="width:65px"> s/lap/kg</label><label class="smooth">Smoothing <input id="smoothing" type="range" min="0" max="10" step="1" value="5"> <span id="smoothingvalue">5s</span></label></div><div class="pit"><label><input type="checkbox" id="pitshow" checked> Pit projections</label><label>Driver <select id="pitdriver"></select></label><label>Pit loss <input id="pitloss" type="number" min="0" max="180" step="0.1" placeholder="—"> s</label><button id="pitreset" disabled>Calculating…</button><label>VSC pit loss <input id="vscpitloss" type="number" min="0" max="180" step="0.1" value="15"> s</label><button id="vscpitreset">Use estimate 15s</button></div><div class="pitlog" id="pitlog"></div><div class="trace-container"><canvas></canvas><div class="trace-tooltip" id="trace-tooltip"></div></div><div class="legend" id="legend"></div></ha-card>';
  }
  const status=this.shadowRoot.querySelector('#status'),canvas=this.shadowRoot.querySelector('canvas');
  canvas.style.height=Math.max(180,Number(this.config.height)||460)+'px';
  if(!this.resizeObserver&&typeof ResizeObserver!=='undefined'){
   this.resizeObserver=new ResizeObserver(()=>{
    if(this.drag)return;
    const rect=canvas.getBoundingClientRect();
    if(rect.width>0&&rect.height>0)this.draw();
   });
   this.resizeObserver.observe(canvas);
  }
  const rect=canvas.getBoundingClientRect();
  const dpr=Math.max(1,Math.min(3,window.devicePixelRatio||1));
  const cssWidth=Math.max(1,Math.round(rect.width||1100));
  const cssHeight=Math.max(1,Math.round(rect.height||460));
  const pixelWidth=Math.round(cssWidth*dpr),pixelHeight=Math.round(cssHeight*dpr);
  if(canvas.width!==pixelWidth||canvas.height!==pixelHeight){
   canvas.width=pixelWidth;canvas.height=pixelHeight;
  }
  this.canvasScale=dpr;
  this.canvasWidth=cssWidth;this.canvasHeight=cssHeight;

  const fuelInput=this.shadowRoot.querySelector('#fueleffect');
  fuelInput.value=this.fuelEffect.toFixed(3);
  fuelInput.onchange=()=>{
   const value=Number(fuelInput.value);
   if(!Number.isFinite(value)||value<0||value>0.2){fuelInput.value=this.fuelEffect.toFixed(3);return;}
   this.fuelEffect=value;
   this.renderSeriesKey=null;
   this.draw();
  };
  const refSelect=this.shadowRoot.querySelector('#reference');
  refSelect.value=this.referenceMode;
  const timingToggle=this.shadowRoot.querySelector('#timingcorrections');
  timingToggle.checked=this.applyTimingCorrections;
  timingToggle.onchange=()=>{this.applyTimingCorrections=timingToggle.checked;this.draw();};
  const profilesToggle=this.shadowRoot.querySelector('#driverprofiles');
  profilesToggle.checked=this.useDriverProfiles;
  profilesToggle.onchange=()=>{this.useDriverProfiles=profilesToggle.checked;this.draw();};
  const smoothing=this.shadowRoot.querySelector('#smoothing');
  smoothing.value=String(this.smoothingSeconds);
  this.shadowRoot.querySelector('#smoothingvalue').textContent=this.smoothingSeconds+'s';
  smoothing.oninput=()=>{this.smoothingSeconds=Number(smoothing.value);this.draw();};
  refSelect.onchange=()=>{this.referenceMode=refSelect.value;this.draw();};
  canvas.style.height=this.config.height+'px';
  canvas.style.touchAction='none';
  this.shadowRoot.querySelector('#resetview').onclick=()=>{
   this.viewport=null;this.liveView=false;this.referenceLapAdjustment=0;this.draw();
  };
  const liveButton=this.shadowRoot.querySelector('#liveview');
  liveButton.setAttribute('aria-pressed',String(this.liveView));
  liveButton.style.background=this.liveView?'#176b54':'#263447';
  liveButton.onclick=()=>{this.liveView=!this.liveView;this.draw();};
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
   const drag=this.drag;
   if(!drag){
    const tooltip=this.shadowRoot.querySelector('#trace-tooltip');
    if(!tooltip||!this.hoverSeries||!this.viewport){if(tooltip)tooltip.style.display='none';return;}
    const rect=canvas.getBoundingClientRect();
    const mx=(e.clientX-rect.left)*this.canvasWidth/rect.width;
    const my=(e.clientY-rect.top)*this.canvasHeight/rect.height;
    const v=this.viewport,w=this.canvasWidth,h=this.canvasHeight;
    const x=d=>52+(d-v.xMin)/Math.max(.001,v.xMax-v.xMin)*(w-76);
    const y=d=>20+(v.yMax-d)/(v.yMax-v.yMin)*(h-60);
    let closest=null;
    for(const [id,points] of this.hoverSeries.series){
     if(this.hiddenDrivers.has(id))continue;
     for(const lapShift of [0,1,-1]){
      if(lapShift&&!Number.isFinite(this.hoverSeries.lapSeconds))continue;
      for(let j=1;j<points.length;j++){
       const a=points[j-1],b=points[j];
       const shiftSeconds=lapShift===0?0:lapShift*this.hoverSeries.lapSeconds;
       const ax=x(a[0]+lapShift),ay=y(a[1]+shiftSeconds);
       const bx=x(b[0]+lapShift),by=y(b[1]+shiftSeconds);
      if(Math.max(ax,bx)<mx-12||Math.min(ax,bx)>mx+12)continue;
      const dx=bx-ax,dy=by-ay,len=dx*dx+dy*dy;
      const t=len?Math.max(0,Math.min(1,((mx-ax)*dx+(my-ay)*dy)/len)):0;
      const px=ax+t*dx,py=ay+t*dy,dist=Math.hypot(mx-px,my-py);
      if(dist<12&&(!closest||dist<closest.dist))
       closest={id,dist,d:a[0]+t*(b[0]-a[0]),lapShift};
      }
     }
    }
    if(!closest){tooltip.style.display='none';return;}
    const meta=this.hoverSeries.meta.get(closest.id)||{};
    // Find the recorded time at the hovered race distance, then look up
    // historical classification. Binary searches avoid per-mousemove scans.
    const track=this.hoverSeries.historyTracks?.get(closest.id);
    let hoverTime=null;
    if(track?.length){
     let lo=0,hi=track.length-1;
     const distance=closest.d;
     if(distance<=track[0][0])hoverTime=track[0][2];
     else if(distance>=track[hi][0])hoverTime=track[hi][2];
     else{
      while(hi-lo>1){const mid=(lo+hi)>>1;if(track[mid][0]<distance)lo=mid;else hi=mid;}
      const a=track[lo],b=track[hi],span=b[0]-a[0];
      hoverTime=span>1e-8?a[2]+(distance-a[0])/span*(b[2]-a[2]):a[2];
     }
    }
    const history=this.hoverSeries.history?.get(closest.id);
    let historic=null;
    if(history?.length&&Number.isFinite(hoverTime)){
     let lo=0,hi=history.length;
     while(lo<hi){const mid=(lo+hi)>>1;if(history[mid].t<=hoverTime)lo=mid+1;else hi=mid;}
     historic=history[Math.max(0,lo-1)];
     if(historic&&Math.abs(historic.t-hoverTime)>120)historic=null;
    }
    const label=String(meta.tla||meta.abbreviation||meta.name||meta.driver_name||'#'+closest.id);
    const team=meta.team_name||meta.team||meta.constructor_name||'Unknown';
    const tyre=historic?.tyre||'Unknown';
    const pos=historic?.position??'Unknown';
    const lap=historic?.completed_laps??Math.max(1,Math.floor(closest.d)+1);
    tooltip.replaceChildren();
    const heading=document.createElement('strong');
    heading.textContent=label+' #'+closest.id+(closest.lapShift===1?' · LAPPED PROJECTION':closest.lapShift===-1?' · LAP AHEAD PROJECTION':'');
    const detail=document.createElement('div');
    detail.textContent='Position: '+pos+' · Lap: '+lap+(closest.lapShift===1?' · +1 lap overlay':closest.lapShift===-1?' · −1 lap overlay':'');
    const detail2=document.createElement('div');
    detail2.textContent='Tyre: '+tyre+' · Team: '+team;
    tooltip.append(heading,detail,detail2);
    const container=canvas.parentElement;
    const tx=e.clientX-container.getBoundingClientRect().left;
    const ty=e.clientY-container.getBoundingClientRect().top;
    tooltip.style.display='block';
    tooltip.style.left=Math.max(0,Math.min(container.clientWidth-tooltip.offsetWidth,tx+14))+'px';
    tooltip.style.top=Math.max(0,ty-tooltip.offsetHeight-12)+'px';
    return;
   }
   this.shadowRoot.querySelector('#trace-tooltip').style.display='none';
   if(drag.pointer!==e.pointerId||!this.viewport)return;
   drag.dx=e.clientX-drag.x;drag.dy=e.clientY-drag.y;
   const rect=canvas.getBoundingClientRect();
   const sx=this.canvasWidth/rect.width,sy=this.canvasHeight/rect.height;
   const ctx=canvas.getContext('2d');
   ctx.setTransform(this.canvasScale,0,0,this.canvasScale,0,0);
   ctx.fillStyle='#0b1220';ctx.fillRect(0,0,this.canvasWidth,this.canvasHeight);
   ctx.save();ctx.beginPath();ctx.rect(52,15,this.canvasWidth-70,this.canvasHeight-47);ctx.clip();
   const offsetX=drag.zone==='both'?drag.dx*sx:0;
   const offsetY=drag.zone==='reference'?0:drag.dy*sy;
   ctx.drawImage(drag.snapshot,offsetX,offsetY,this.canvasWidth,this.canvasHeight);
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
   if(drag.zone==='both'&&Math.abs(drag.dx)>3)this.liveView=false;
   if(drag.zone==='reference'){
    this.referenceLapAdjustment=drag.reference-Math.round(drag.dy/10)/10;
    // Reference changes alter the one-lap scale. Recompute Y limits
    // immediately while retaining the user's horizontal viewport.
    // Preserve any Y pan performed with the left-hand drag. Only change
    // the half-range around the user's existing vertical centre.
    const oldHalf=(this.viewport.yMax-this.viewport.yMin)/2;
    const centre=(this.viewport.yMax+this.viewport.yMin)/2;
    const newHalf=Math.max(5,((Number.isFinite(this.lastReferenceBase)?this.lastReferenceBase:100)+this.referenceLapAdjustment)/2+5);
    this.viewport={...this.viewport,yMin:centre-newHalf,yMax:centre+newHalf};
   }else{
    const v=drag.start||this.viewport,xr=v.xMax-v.xMin,yr=v.yMax-v.yMin;
    this.viewport={...v,xMin:v.xMin-(drag.zone==='both'?dx*xr:0),
     xMax:v.xMax-(drag.zone==='both'?dx*xr:0),
     yMin:v.yMin+dy*yr,yMax:v.yMax+dy*yr};
   }
   this.draw();
  };
  canvas.onpointerup=endDrag;canvas.onpointercancel=endDrag;
  canvas.onpointerleave=()=>{const tip=this.shadowRoot.querySelector('#trace-tooltip');if(tip)tip.style.display='none';};
  canvas.onwheel=e=>{
   e.preventDefault();
   this.liveView=false;
   if(!this.viewport)return;
   const rect=canvas.getBoundingClientRect();
   const fx=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));
   const fy=Math.max(0,Math.min(1,(e.clientY-rect.top)/rect.height));
   const factor=e.deltaY>0?1.2:1/1.2;
   const v=this.viewport;
   const cx=v.xMin+fx*(v.xMax-v.xMin),cy=v.yMax-fy*(v.yMax-v.yMin);
   const xr=Math.max(.15,Math.min(100,(v.xMax-v.xMin)*factor));
   const yr=Math.max(1,Math.min(2000,(v.yMax-v.yMin)*factor));
   this.viewport={xMin:cx-fx*xr,xMax:cx+(1-fx)*xr,
    yMin:cy-(1-fy)*yr,yMax:cy+fy*yr};
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
   const sourceClock=this.timing.samples.length>0&&this.timing.samples.every(s=>Number.isFinite(s.session_timestamp));
   const frames=RaceTraceRecordingSync.gpsFrames(this.gps,sourceClock);
   const events=RaceTraceRecordingSync.crossings(this.timing).filter(e=>e[1]>=2);
   let calibration=null,provisional=true;
   if(events.length){
    try{const official=RaceTraceCalibration.calibrate(geometry,frames,events);
     if(official.confidence){calibration=official;provisional=false;}
    }catch(_e){/* Await official crossing data. */}
   }
   if(!calibration){
    const first=frames.find(f=>f.d.length);
    if(!first)throw Error('Waiting for GPS positions');
    const leaderSample=this.timing.samples.find(s=>s.drivers?.some(d=>String(d.position)==='1'));
    const leader=leaderSample?.drivers?.find(d=>String(d.position)==='1');
    const position=first.d.find(d=>d[0]===String(leader?.id))||first.d[0];
    calibration={distance:RaceTraceCircuit.project(geometry,position[1],position[2]).distance,confidence:false};
   }
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
   // Project each GPS sample using the local travel direction. Intersect
   // the perpendicular through the car with the circuit centreline.
   const observations=new Map();
   for(const frame of frames)for(const [id,x,y] of frame.d){
    if(!observations.has(id))observations.set(id,[]);
    observations.get(id).push({x,y,t:frame.t});
   }
   const projectionStats={intersection:0,fallback:0,rejected:0};
   const last=new Map();
   for(const [id,positions] of observations){
    const track=[];
    for(let i=0;i<positions.length;i++){
     const p=positions[i],before=positions[Math.max(0,i-1)],
      after=positions[Math.min(positions.length-1,i+1)];
     const tx=after.x-before.x,ty=after.y-before.y;
     const norm=Math.hypot(tx,ty);
     // Geometry projection is expensive (scans every circuit segment).
     // Cache stable points across 5-second polls. Include both neighbours
     // because the perpendicular depends on the car's travel direction.
     const cacheKey=id+':'+p.t+':'+p.x+':'+p.y+':'+before.x+':'+before.y+':'+after.x+':'+after.y;
     let cached=this.gpsProjectionCache.get(cacheKey);
     let distance,usedIntersection=false;
     if(cached){
      distance=cached.distance;usedIntersection=cached.usedIntersection;
     }else{
     const nearest=RaceTraceCircuit.project(geometry,p.x,p.y);
     distance=nearest.distance;
     if(norm>1){
      const nx=-ty/norm,ny=tx/norm;
      let best=null;
      for(const s of geometry.segments){
       const denominator=nx*s.dy-ny*s.dx;
       if(Math.abs(denominator)<1e-8)continue;
       const ax=s.a[0]-p.x,ay=s.a[1]-p.y;
       const u=(ax*s.dy-ay*s.dx)/denominator;
       const v=(ax*ny-ay*nx)/denominator;
       if(v<0||v>1||Math.abs(u)>120)continue;
       const candidate={distance:s.start+v*s.size,error:Math.abs(u)};
       if(!best||candidate.error<best.error)best=candidate;
      }
      if(best){
       const circular=Math.abs(best.distance-nearest.distance);
       if(Math.min(circular,geometry.length-circular)<geometry.length*.08){
        distance=best.distance;usedIntersection=true;
       }
      }
     }
     this.gpsProjectionCache.set(cacheKey,{distance,usedIntersection});
     }
     if(usedIntersection)projectionStats.intersection++;
     else projectionStats.fallback++;
     const phase=((distance-calibration.distance)*direction%geometry.length+
      geometry.length)%geometry.length/geometry.length;
     const prev=last.get(id);
     let unwrapped=phase,accepted=true;
     if(prev){
      let step=phase-prev.phase;
      if(step>.5)step-=1;
      if(step<-.5)step+=1;
      if(step<-.03||step>=.2){
       unwrapped=prev.value;accepted=false;projectionStats.rejected++;
      }else unwrapped=prev.value+step;
     }
     track.push([0,unwrapped,p.t]);
     last.set(id,{phase:accepted?phase:prev.phase,value:unwrapped});
    }
    traces.set(id,track);
   }
   const aligned=RaceTraceOfficialAlignment.align(traces,events);
   // A stationary car remains visible for up to five seconds. If it is
   // officially retired, replace the stationary tail with an X at the last
   // moving point. Use actual GPS movement (metres), not centreline phase:
   // pit-lane projection can move while the car itself is stationary.
   const retirementAt=new Map();
   const retiredStatus=value=>/^(RETIRED|RET|DNF|OUT)$/i.test(String(value??'').trim());
   for(const sample of this.timing.samples){
    const sampleClock=Number.isFinite(sample.session_timestamp)?sample.session_timestamp:sample.timestamp;
    for(const d of sample.drivers||[]){
     const id=String(d.id??d.racing_number??'');
     if(!id||retirementAt.has(id))continue;
     if(d.retired===true||[d.status,d.driver_status,d.race_status,d.gap,d.gap_to_leader].some(retiredStatus))
      retirementAt.set(id,Number(sampleClock));
    }
   }
   // Finish-line clipping is per driver, not at the leader's flag time.
   // First use explicit finished status; otherwise wait for a recorded
   // chequered flag and that driver's next official completed-lap crossing.
   const finishAt=new Map();
   const finishStatus=v=>/^(FINISHED|FINISH|CLASSIFIED|CHEQUERED|CHECKERED)$/i.test(String(v??'').trim());
   for(const sample of this.timing.samples){
    const sampleClock=Number.isFinite(sample.session_timestamp)?sample.session_timestamp:sample.timestamp;
    if(!Number.isFinite(sampleClock))continue;
    for(const d of sample.drivers||[]){
     const id=String(d.id??d.racing_number??'');
     if(!id||finishAt.has(id)||retirementAt.has(id))continue;
     if(d.finished===true||d.is_finished===true||
        [d.status,d.driver_status,d.race_status].some(finishStatus))
      finishAt.set(id,{time:sampleClock,source:'status'});
    }
   }
   const flagTimes=[];
   const isFlagMessage=v=>/CHE(?:QU|CK)ERED FLAG|CHE(?:QU|CK)ERED|RACE FINISHED|END OF RACE/i.test(String(v??''));
   for(const e of (sourceClock?[]:this.timing.race_control||[])){
    if(isFlagMessage(e.message??e.text??e.description??'')||
       /CHE(?:QU|CK)ERED/i.test(String(e.flag??e.flag_type??''))){
     const t=Number(e.observed_at??e.timestamp??e.time??(e.utc?Date.parse(e.utc)/1000:NaN));
     if(Number.isFinite(t))flagTimes.push(t);
    }
   }
   for(const sample of this.timing.samples){
    const sampleClock=Number.isFinite(sample.session_timestamp)?sample.session_timestamp:sample.timestamp;
    const text=[sample.race_control_message,sample.message,
     ...(Array.isArray(sample.race_control_messages)?sample.race_control_messages.map(e=>
      typeof e==='string'?e:e.message??e.text??''):[])].join(' ');
    if(isFlagMessage(text)&&Number.isFinite(sample.timestamp))
     flagTimes.push(sampleClock);
   }
   // Some recorder versions expose the end-of-session state instead of
   // a race-control message. Accept explicit finished/chequered status,
   // but never infer the flag from an ordinary green-track sample.
   for(const sample of this.timing.samples){
    if(!Number.isFinite(sample.timestamp))continue;
    if([sample.session_status,sample.session_state,sample.race_status,
         sample.sessionStatus,sample.raceStatus].some(v=>
       /^(FINISHED|FINISH|ENDED|COMPLETE|COMPLETED|CHEQUERED|CHECKERED)$/i.test(String(v??''))))
      flagTimes.push(sampleClock);
   }
   if(flagTimes.length){
    const flagTime=Math.min(...flagTimes);
    // Each driver finishes at their OWN first S/F crossing after the
    // chequered flag, regardless of how many laps behind they are.
    // Replace status-only estimates with exact official crossings.
    const crossings=[...events].sort((a,b)=>a[2]-b[2]);
    const crossed=new Set();
    for(const [id,lap,t] of crossings){
     if(retirementAt.has(id)||crossed.has(id)||t<flagTime-2)continue;
     crossed.add(id);
     finishAt.set(id,{time:t,lap,source:'flag crossing'});
    }
   }
   // GPS finish fallback: official completed-lap transitions can stop
   // updating at the flag. Find each car's first S/F distance crossing
   // at or just after the chequered flag, using its own GPS trajectory.
   if(flagTimes.length){
    const flagTime=Math.min(...flagTimes);
    for(const [id,track] of traces){
     if(retirementAt.has(id)||track.length<2)continue;
     // A crossing just before the race-control event is still the finish
     // for the winner: flag publication may lag the physical line.
     let crossing=null;
     for(let i=1;i<track.length;i++){
      const a=track[i-1],b=track[i];
      if(b[1]<=a[1]||b[2]<=a[2])continue;
      const first=Math.floor(a[1])+1;
      if(first>b[1]||b[1]-a[1]>.25)continue;
      const t=a[2]+(first-a[1])/(b[1]-a[1])*(b[2]-a[2]);
      if(t>=flagTime-5){crossing={time:t,source:'GPS finish crossing'};break;}
     }
     const current=finishAt.get(id);
     if(crossing&&(!current||current.source!=='flag crossing'||
        Math.abs(current.time-crossing.time)>8))
      finishAt.set(id,crossing);
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
    const finish=finishAt.get(id);
    if(finish){
     // Include the actual finish-line crossing, but not the in-lap.
     // Prefer the crossing distance when an official completed-lap
     // transition is known; status-only feeds use the status timestamp.
     // The official lap counter and GPS unwrapped-distance coordinate
     // can differ (formation lap, alignment). Never compare them.
     // Cut at the official crossing's TIMESTAMP instead.
     const end=track.findIndex(p=>p[2]>finish.time+0.5);
     if(end>=0)traces.set(id,track.slice(0,Math.max(1,end)));
    }
    // Ignore post-retirement GPS updates even if the car is transported.
    if(Number.isFinite(retirement)){
     let lastIndex=traces.get(id).findIndex(p=>p[2]>retirement);
     if(lastIndex<0)lastIndex=traces.get(id).length;
     traces.set(id,traces.get(id).slice(0,lastIndex));
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
   // Explicitly opt in for events where the first recorded lap is a
   // formation lap. Keep all GPS data for calibration and diagnostics.
   // Only the race-phase trajectories enter learning and the main chart.
   // Prefer a recorded, explicit official race-start announcement.
   // GREEN alone is not a race start (it also ends SC/VSC periods).
   // Retain manual formation_lap override for feeds without such events.
   const startMessages=[];
   const collectStart=(item,fallback)=>{
    if(!item)return;
    const message=typeof item==='string'?item:
     String(item.message??item.text??item.description??'');
    if(!/\b(?:LIGHTS? OUT|RACE START(?:ED)?|START OF (?:THE )?RACE)\b/i.test(message)||
       /RESTART|FORMATION|ABORT/i.test(message))return;
    const raw=typeof item==='object'?(item.timestamp??item.time??item.date??fallback):fallback;
    const t=typeof raw==='number'?raw:Number(raw);
    if(Number.isFinite(t))startMessages.push(t);
   };
   for(const event of (sourceClock?[]:this.timing.race_control||[]))collectStart(event,null);
   for(const sample of this.timing.samples){
    const sampleClock=Number.isFinite(sample.session_timestamp)?sample.session_timestamp:sample.timestamp;
    for(const field of [sample.race_control_messages,sample.race_control,
      sample.messages,sample.race_control_message,sample.message]){
     if(Array.isArray(field))for(const item of field)collectStart(item,sampleClock);
     else collectStart(field,sampleClock);
    }
   }
   const officialStart=startMessages.length?Math.min(...startMessages):null;
   let raceStartDistance=1; // Racing lap 1 spans distance 1 to 2; official completed lap 2 ends at distance 2.
   // Official start messages are retained for diagnostics. They must not
   // shift the racing-lap axis after per-driver official alignment.
   // Retain partial and provisional drivers; lap one begins at distance zero.
   const eligible=[...traces].map(([id,v])=>[id,
    v.filter(p=>p[1]>=raceStartDistance-1)]).filter(([,v])=>v.length>2);
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
   // Cache completed lap profiles. A lap is immutable after its following
   // crossing is recorded; only new completed laps require 101 interpolations.
   const cleanLaps=[];
   const liveLapKeys=new Set();
   for(const [id,track] of eligible){
    const monotone=track.filter((p,i)=>!i||p[1]>=track[i-1][1]-0.005);
    for(let lap=Math.max(1,Math.ceil(monotone[0][1]));lap<monotone.at(-1)[1];lap++){
     const cacheKey=id+':'+lap;
     liveLapKeys.add(cacheKey);
     let entry=this.lapProfileCache.get(cacheKey);
     if(!entry){
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
      if(bins.length!==101||!bins.every((v,j)=>!j||v>=bins[j-1]-.0001))continue;
      entry={duration,bins};
      this.lapProfileCache.set(cacheKey,entry);
     }
     cleanLaps.push(entry);
    }
   }
   const median=arr=>{const s=arr.slice().sort((a,b)=>a-b);return s[Math.floor(s.length/2)];};
   const typical=cleanLaps.length>=5?median(cleanLaps.map(l=>l.duration)):null;
   const selected=typical===null?[]:cleanLaps.filter(l=>Math.abs(l.duration-typical)<12);
   const learned=selected.length>=5?Array.from({length:101},(_,j)=>
    j===0?0:j===100?1:median(selected.map(l=>l.bins[j]))):null;
   if(learned)for(let j=1;j<101;j++)learned[j]=Math.max(learned[j],learned[j-1]+1e-7);
   // Keep raw GPS for calibration, pit detection and retirement markers.
   // Correct the displayed crossing-time trajectories to official timing at
   // each finish-line crossing, interpolating residuals within each lap.
   const correctedTraces=new Map();
   let correctedAnchors=0,correctedDrivers=0;
   for(const [id,track] of traces){
    const anchors=[];
    for(const [driver,lap,officialTime] of events){
     if(String(driver)!==String(id)||!Number.isFinite(officialTime))continue;
     const distance=lap;
     const gpsTime=crossingAt(track,distance);
     if(!Number.isFinite(gpsTime))continue;
     const residual=officialTime-gpsTime;
     // Ignore gross misidentified crossings rather than deform a full lap.
     if(Math.abs(residual)>5)continue;
     anchors.push({d:distance,offset:residual});
    }
    anchors.sort((a,b)=>a.d-b.d);
    const unique=anchors.filter((p,i)=>!i||p.d>anchors[i-1].d);
    correctedAnchors+=unique.length;
    if(unique.length)correctedDrivers++;
    let cursor=0;
    correctedTraces.set(id,track.map(p=>{
     const d=p[1];
     while(cursor+1<unique.length&&unique[cursor+1].d<d)cursor++;
     let offset=0;
     if(unique.length){
      const a=unique[cursor],b=unique[Math.min(cursor+1,unique.length-1)];
      if(d<=unique[0].d)offset=unique[0].offset;
      else if(d>=unique.at(-1).d)offset=unique.at(-1).offset;
      else offset=a.offset+(b.offset-a.offset)*(d-a.d)/(b.d-a.d);
     }
     return [p[0],p[1],p[2]+offset];
    }));
   }


   // Learn a separate fractional-lap timing shape for each driver.
   // Only use complete, near-normal-pace laps; pit/neutralised laps
   // should not teach the clean-racing profile.
   const driverProfiles=new Map();
   const profileCounts=new Map();
   // Learn each car's distance/time shape independently, as soon as one
   // complete clean racing lap is available. Median multiple laps later.
   for(const [id,track] of eligible){
    const samples=[];
    const first=Math.max(1,Math.ceil(track[0][1]));
    const end=Math.floor(track.at(-1)[1]);
    for(let lap=first;lap<end;lap++){
     const cached=this.lapProfileCache.get(id+':'+lap);
     if(cached){samples.push(cached);continue;}
     const t0=crossingAt(track,lap),t1=crossingAt(track,lap+1);
     if(!Number.isFinite(t0)||!Number.isFinite(t1))continue;
     const duration=t1-t0;
     if(duration<75||duration>180)continue;
     const bins=[];
     for(let j=0;j<=100;j++){
      const t=crossingAt(track,lap+j/100);
      if(!Number.isFinite(t)){bins.length=0;break;}
      bins.push((t-t0)/duration);
     }
     if(bins.length===101&&bins.every((v,j)=>!j||v>=bins[j-1]-.0001))
      samples.push({duration,bins});
    }
    if(!samples.length)continue;
    const durations=samples.map(p=>p.duration);
    const localMedian=median(durations);
    const clean=samples.filter(p=>Math.abs(p.duration-localMedian)<8&&
      (!Number.isFinite(typical)||p.duration<typical+10));
    if(!clean.length)continue;
    const profile=Array.from({length:101},(_,j)=>
      j===0?0:j===100?1:median(clean.map(p=>p.bins[j])));
    for(let j=1;j<100;j++)profile[j]=Math.min(1,Math.max(profile[j-1],profile[j]));
    driverProfiles.set(id,profile);
    profileCounts.set(id,clean.length);
   }
   // Official crossing timestamps define each lap's endpoints. A driver's
   // learned shape fills the time between those endpoints. This preserves
   // the observed lap duration, even during VSC and pit-stop laps.
   const officialByDriver=new Map();
   for(const [id,lap,t] of events){
    if(!Number.isFinite(t))continue;
    const key=String(id);
    if(!officialByDriver.has(key))officialByDriver.set(key,new Map());
    officialByDriver.get(key).set(lap-1,t);
   }
   const profileAt=(profile,f)=>{
    const q=Math.max(0,Math.min(100,f*100));
    const j=Math.min(99,Math.floor(q));
    return profile[j]+(profile[j+1]-profile[j])*(q-j);
   };
   const profiledTraces=new Map();
   let profiledDrivers=0,profiledPoints=0;
   for(const [id,track] of traces){
    const profile=driverProfiles.get(id);
    const crossings=officialByDriver.get(id);
    if(!profile||!crossings){profiledTraces.set(id,track);continue;}
    profiledDrivers++;
    const raw=track;
    const shaped=track.map((p,i)=>{
     const d=p[1],lap=Math.floor(d),fraction=d-lap;
     const t0=crossings.get(lap),t1=crossings.get(lap+1);
     if(!Number.isFinite(t0)||!Number.isFinite(t1)||t1<=t0)return raw[i];
     profiledPoints++;
     return [p[0],d,t0+(t1-t0)*profileAt(profile,fraction)];
    });
    profiledTraces.set(id,shaped);
   }
    return {traces,driverProfiles,correctedTraces,profiledTraces,profiledDrivers,profiledPoints,profileCounts,correctedAnchors,correctedDrivers,projectionStats,events,aligned,referenceId,ref,markers,stopped,
      selected,typical,learned,cleanLaps,provisional,raceStartDistance};
    })();
   }
   // Older cached preprocessing results may predate the driver profile field.
   if(!this.processed.driverProfiles){this.processed=null;this.processedKey=null;return this.draw();}
   const {traces,driverProfiles,correctedTraces,profiledTraces,profiledDrivers,profiledPoints,profileCounts,correctedAnchors,correctedDrivers,projectionStats,events,aligned,referenceId,ref,markers,stopped,
    selected,typical,learned,cleanLaps,provisional,raceStartDistance}=this.processed;
   // Independent validation: compare interpolated GPS crossing times with
   // official lap-transition timestamps at the same finish-line distance.
   // This does not modify the graph or the reference-lap adjustment.
   const crossingChecks=[];
   for(const [id,lap,tOfficial] of events){
    const track=traces.get(String(id));
    if(!track||!Number.isFinite(tOfficial))continue;
    const distance=lap-1;
    const tGps=crossingAt(track,distance);
    if(Number.isFinite(tGps))
     crossingChecks.push({id:String(id),lap,official:tOfficial,gps:tGps,
      error:tGps-tOfficial});
   }
   const crossingErrors=crossingChecks.map(p=>Math.abs(p.error)).sort((a,b)=>a-b);
   const medianCrossingError=crossingErrors.length?
    crossingErrors[Math.floor(crossingErrors.length/2)]:null;
   const crossingOutliers=crossingChecks.filter(p=>Math.abs(p.error)>2);
   const orderingChecks=[];
   const byLap=new Map();
   for(const p of crossingChecks){
    if(!byLap.has(p.lap))byLap.set(p.lap,[]);
    byLap.get(p.lap).push(p);
   }
   for(const [lap,drivers] of byLap){
    for(let i=0;i<drivers.length;i++)for(let j=i+1;j<drivers.length;j++){
     const a=drivers[i],b=drivers[j];
     const officialDelta=a.official-b.official,gpsDelta=a.gps-b.gps;
     if(Math.abs(officialDelta)<.25)continue;
     if(Math.sign(officialDelta)!==Math.sign(gpsDelta))
      orderingChecks.push({lap,a:a.id,b:b.id,officialDelta,gpsDelta});
    }
   }
   const validationSummary=' · GPS vs official: '+crossingChecks.length+
    ' crossings, median '+(medianCrossingError===null?'n/a':medianCrossingError.toFixed(1)+'s')+
    ', >2s '+crossingOutliers.length+
    ', reversed pairs '+orderingChecks.length+
    (orderingChecks.length?' (e.g. L'+orderingChecks[0].lap+' #'+orderingChecks[0].a+
     '/#'+orderingChecks[0].b+')':'');
   const useLearned=this.referenceMode==='learned'&&!!learned;
   const firstCross=events.find(e=>String(e[0])===referenceId&&e[1]===raceStartDistance+1);
   const originTime=firstCross?.[2]??crossingAt(ref,raceStartDistance);
   // Normalised lap-time shape is shared by all drivers. Anchor it to
   // the reference car at its first racing lap crossing.
   const referenceAdjustment=this.referenceLapAdjustment;
   function timeAtDistance(d){
    if(useLearned&&Number.isFinite(originTime)){
     const phase=((d-raceStartDistance)%1+1)%1,lap=Math.floor(d-raceStartDistance);
     const q=phase*100,j=Math.min(99,Math.floor(q)),f=q-j;
     return originTime+(lap+learned[j]*(1-f)+learned[j+1]*f)*(typical+referenceAdjustment);
    }
    if(d<ref[0][1]||d>ref.at(-1)[1])return null;
    let lo=0,hi=ref.length-1;
    while(hi-lo>1){const mid=(lo+hi)>>1;if(ref[mid][1]<d)lo=mid;else hi=mid;}
    const u=ref[hi][1]-ref[lo][1];
    return u>0?ref[lo][2]+(d-ref[lo][1])/u*(ref[hi][2]-ref[lo][2])+(d-1)*referenceAdjustment:null;
   }
   // Original offline prototype: evaluate the driver's own normalised
   // reference at its GPS distance, then subtract the actual GPS timestamp.
   // Keep GPS samples as X coordinates; do not rebuild timestamps from laps.
   const profileEval=(profile,f)=>{
    const n=profile.length-1;
    const u=Math.max(0,Math.min(1,f))*n,i=Math.min(n-1,Math.floor(u));
    const t=u-i,h=1/n,delta=j=>n*(profile[j+1]-profile[j]);
    const tangent=j=>{
     if(j===0)return Math.max(0,(3*delta(0)-delta(1))/2);
     if(j===n)return Math.max(0,(3*delta(n-1)-delta(n-2))/2);
     const p=delta(j-1),q=delta(j);
     return p*q<=0?0:2*p*q/(p+q);
    };
    const m0=tangent(i),m1=tangent(i+1);
    return (2*t*t*t-3*t*t+1)*profile[i]+
     (t*t*t-2*t*t+t)*h*m0+
     (-2*t*t*t+3*t*t)*profile[i+1]+
     (t*t*t-t*t)*h*m1;
   };
   const smoothProfile=values=>{
    const n=values.length-1;
    const result=values.map((v,i)=>{
     if(i===0)return 0;
     if(i===n)return 1;
     let sum=0,weight=0;
     for(let k=-5;k<=5;k++){
      const j=Math.max(0,Math.min(n,i+k));
      const w=Math.exp(-.5*(k/2.1)**2);
      sum+=w*values[j];weight+=w;
     }
     return sum/weight;
    });
    for(let i=1;i<n;i++)result[i]=Math.max(result[i],result[i-1]+1e-7);
    return result[n-1]<1?result:null;
   };
   const sharedProfile=learned?smoothProfile(learned):null;
   const profiles=new Map();
   for(const [id,p] of driverProfiles){
    const smoothed=smoothProfile(p);
    if(smoothed)profiles.set(id,smoothed);
   }
   const series=new Map(),sigma=this.smoothingSeconds/2;
   const origin=Number.isFinite(originTime)?originTime:ref[0][2];
   const referenceSeconds=(Number.isFinite(typical)?typical:100)+referenceAdjustment;
   // Fuel load declines approximately linearly. Integrating the lap-time
   // improvement gives a quadratic correction to the reference clock.
   const meta=this.timing.metadata||this.timing.meta||this.gps.metadata||{};
   const declaredLaps=Number(meta.total_laps??meta.race_laps??meta.laps??meta.number_of_laps??this.timing.total_laps??this.timing.race_laps);
   const raceLaps=Number.isFinite(declaredLaps)&&declaredLaps>0?declaredLaps:Math.max(1,Math.round(ref.at(-1)[1]-raceStartDistance+1));
   const fuelGainPerLap=100*this.fuelEffect/raceLaps;
   const fuelClockCorrection=d=>{
    const elapsed=Math.max(0,d-raceStartDistance+1);
    return -fuelGainPerLap*elapsed*elapsed/2;
   };
   this.lastReferenceBase=Number.isFinite(typical)?typical:100;
   // SC/VSC reference correction. Integrate the leader's observed GPS
   // slowdown relative to the ordinary racing reference, beginning at the
   // neutralisation's first recorded position. The offset is retained after
   // green so there is no discontinuity in the gap chart.
   const neutralPeriods=[];
   let neutral=null;
   const neutralType=value=>{
    const s=String(value??'').trim().toUpperCase();
    if(!s)return undefined;
    if(/^(VSC|VIRTUAL SAFETY CAR|VIRTUAL SAFETY CAR DEPLOYED)$/.test(s))return 'VSC';
    if(/^(SC|SAFETY CAR|SAFETY CAR DEPLOYED)$/.test(s))return 'SC';
    if(/^(1|GREEN|CLEAR|ALL CLEAR|NORMAL)$/.test(s))return null;
    return undefined;
   };
   for(const sample of this.timing.samples){
    const type=neutralType(sample.track_status);
    if(type===undefined||!Number.isFinite(sample.timestamp))continue;
    if(type!==neutral?.type){
     if(neutral){neutral.end=sample.timestamp;neutralPeriods.push(neutral);}
     neutral=type?{type,start:sample.timestamp,end:Infinity}:null;
    }
   }
   if(neutral)neutralPeriods.push(neutral);
   const refTimeAtDistance=d=>{
    if(d<ref[0][1]||d>ref.at(-1)[1])return null;
    let lo=0,hi=ref.length-1;
    while(hi-lo>1){const m=(lo+hi)>>1;if(ref[m][1]<d)lo=m;else hi=m;}
    const span=ref[hi][1]-ref[lo][1];
    return span>0?ref[lo][2]+(d-ref[lo][1])/span*(ref[hi][2]-ref[lo][2]):null;
   };
   const refDistanceAtTimestamp=t=>{
    if(t<=ref[0][2])return ref[0][1];
    if(t>=ref.at(-1)[2])return ref.at(-1)[1];
    let lo=0,hi=ref.length-1;
    while(hi-lo>1){const m=(lo+hi)>>1;if(ref[m][2]<t)lo=m;else hi=m;}
    const span=ref[hi][2]-ref[lo][2];
    return span>0?ref[lo][1]+(t-ref[lo][2])/span*(ref[hi][1]-ref[lo][1]):null;
   };
   const racingRefAt=d=>{
    const lap=Math.floor(d),fraction=d-lap;
    const q=fraction*100,j=Math.min(99,Math.floor(q)),f=q-j;
    const progress=sharedProfile?sharedProfile[j]*(1-f)+sharedProfile[j+1]*f:fraction;
    return origin+(lap+progress-raceStartDistance)*referenceSeconds+fuelClockCorrection(d);
   };
   // Build an independent neutralised-pace clock from several circulating
   // cars at equal distance. Do not use the leader alone: a leader pit stop
   // must remain visible as a time loss, not redefine the reference.
   const neutralSegments=[];
   let cumulative=0;
   const candidateTracks=[...traces].filter(([,track])=>track.length>2).map(([id,track])=>({
    id,track:track.filter((p,i)=>!i||p[1]>track[i-1][1]+1e-7)
   }));
   const neutralPaceStep=(from,to)=>{
    const values=[];
    for(const {track} of candidateTracks){
     if(track.length<2||from<track[0][1]||to>track.at(-1)[1])continue;
     const t0=crossingAt(track,from),t1=crossingAt(track,to);
     if(Number.isFinite(t0)&&Number.isFinite(t1)&&t1>t0)
      values.push(t1-t0);
    }
    if(values.length<3)return null;
    values.sort((a,b)=>a-b);
    // Use the field median, not the fastest half. Under SC/VSC the
    // faster cars bias the reference towards racing pace and make every
    // trace slope downwards. A median is resistant to isolated pit stops
    // without systematically choosing the quickest circulating cars.
    const middle=Math.floor(values.length/2);
    return values.length%2?values[middle]:(values[middle-1]+values[middle])/2;
   };
   for(const p of neutralPeriods){
    if(p.start>ref.at(-1)[2])break;
    const from=refDistanceAtTimestamp(p.start);
    const to=refDistanceAtTimestamp(Math.min(p.end,ref.at(-1)[2]));
    if(to<=from)continue;
    const nodes=[{d:from,offset:cumulative}];
    let cursor=from;
    while(cursor<to-1e-7){
     const next=Math.min(to,Math.floor(cursor*50+1.000001)/50);
     if(next<=cursor+1e-8)break;
     const pace=neutralPaceStep(cursor,next);
     const leader0=refTimeAtDistance(cursor),leader1=refTimeAtDistance(next);
     const fallback=Number.isFinite(leader0)&&Number.isFinite(leader1)?leader1-leader0:null;
     const actual=pace??fallback;
     if(Number.isFinite(actual))
      cumulative+=actual-(racingRefAt(next)-racingRefAt(cursor));
     nodes.push({d:next,offset:cumulative});
     cursor=next;
    }
    if(nodes.length>1)neutralSegments.push({from,to,nodes});
   }
   const neutralOffsetAt=d=>{
    let offset=0;
    for(const seg of neutralSegments){
     if(d<=seg.from)break;
     const nodes=seg.nodes;
     if(d>=seg.to){offset=nodes.at(-1).offset;continue;}
     let lo=0,hi=nodes.length-1;
     while(hi-lo>1){const mid=(lo+hi)>>1;if(nodes[mid].d<d)lo=mid;else hi=mid;}
     const a=nodes[lo],b=nodes[hi];
     return a.offset+(d-a.d)/Math.max(1e-8,b.d-a.d)*(b.offset-a.offset);
    }
    return offset;
   };

   for(const [id,track] of traces){
    if(track.length<2)continue;
    const profile=this.useDriverProfiles?(profiles.get(id)||sharedProfile):sharedProfile;
    const source=this.applyTimingCorrections?correctedTraces.get(id)||track:track;
    const segments=[];let segment=[],prev=null;
    for(const p of source){
     // Official lap N finishes at GPS distance N-1. The first racing
     // lap therefore spans [raceStartDistance-1, raceStartDistance].
     // Do not discard it: the prior threshold hid lap one entirely.
     if(p[1]<raceStartDistance-1)continue;
     if(prev&&(p[2]-prev[2]>8||p[2]<=prev[2]||Math.abs(p[1]-prev[1])>.16)){
      if(segment.length)segments.push(segment);
      segment=[];
     }
     const d=p[1],lap=Math.floor(d),fraction=d-lap;
     const progress=profile?profileEval(profile,fraction):fraction;
     const referenceTime=origin+(lap+progress-raceStartDistance)*referenceSeconds+fuelClockCorrection(d)+neutralOffsetAt(d);
     segment.push({d,t:p[2],raw:referenceTime-p[2]});
     prev=p;
    }
    if(segment.length)segments.push(segment);
    const pts=[];
    for(const seg of segments){
     for(let i=0;i<seg.length;i++){
      const p=seg[i];
      if(!sigma){pts.push([p.d,p.raw]);continue;}
      let sum=0,weight=0;
      for(let k=i;k>=0&&p.t-seg[k].t<=3*sigma;k--){
       const w=Math.exp(-.5*((p.t-seg[k].t)/sigma)**2);
       sum+=seg[k].raw*w;weight+=w;
      }
      for(let k=i+1;k<seg.length&&seg[k].t-p.t<=3*sigma;k++){
       const w=Math.exp(-.5*((seg[k].t-p.t)/sigma)**2);
       sum+=seg[k].raw*w;weight+=w;
      }
      pts.push([p.d,sum/weight]);
     }
    }
    if(pts.length>1)series.set(id,pts);
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
    for(let lap=Math.max(raceStartDistance,Math.ceil(track[0][1]));lap<track.at(-1)[1];lap++){
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
     // A sparse GPS feed can miss a stationary pit-box interval.
     // Retain a slow-lap candidate without claiming it is verified.
     // Exclude stops overlapping official neutralisation periods.
     const neutral=this.timing.samples.some(s=>s.timestamp>=p.t0&&s.timestamp<=p.t1&&
      /^(SC|VSC|SAFETY CAR|VIRTUAL SAFETY CAR)$/i.test(String(s.track_status||'')));
     pitStops.push({id,lap:p.lap,loss:slowdown,neutral,stationary,method:stationary?'GPS stop + lap-excess':'lap-excess only'});
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
    opt.value=id;
    const live=this._hass?.states?.[this.config.driver_entity]?.attributes?.drivers;
    const liveDriver=Array.isArray(live)?live.find(d=>String(d.racing_number??d.id??d.driver_number)===id):null;
    const recorded=this.timing.samples.at(-1)?.drivers?.find(d=>String(d.id)===id);
    opt.textContent=String(liveDriver?.tla||recorded?.tla||recorded?.abbreviation||('#'+id));
    pitDriverSelect.append(opt);
   }
   if(!series.has(this.pitDriver))this.pitDriver=series.keys().next().value;
   pitDriverSelect.value=this.pitDriver;
   pitDriverSelect.onchange=()=>{this.pitDriver=pitDriverSelect.value;this.draw();};
   const pitInput=this.shadowRoot.querySelector('#pitloss');
   const pitReset=this.shadowRoot.querySelector('#pitreset');
   const effectiveLoss=this.pitManual===null?expected:this.pitManual;
   const vscEffectiveLoss=this.vscPitManual===null?15:this.vscPitManual;
   const vscPitInput=this.shadowRoot.querySelector('#vscpitloss');
   if(this.shadowRoot.activeElement!==vscPitInput)vscPitInput.value=vscEffectiveLoss.toFixed(1);
   vscPitInput.onchange=()=>{
    const v=Number(vscPitInput.value);
    if(vscPitInput.value!==''&&Number.isFinite(v)&&v>=0&&v<=180){this.vscPitManual=Math.round(v*10)/10;this.draw();}
   };
   this.shadowRoot.querySelector('#vscpitreset').onclick=()=>{this.vscPitManual=null;this.draw();};
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
    (pitStops.length?pitStops.map(p=>'#'+p.id+' L'+p.lap+' '+p.loss.toFixed(1)+'s'+(p.neutral?' [SC/VSC]':p.stationary?' [GPS stop]':' [unverified]')).join(' · '):'No candidates')+
    ' · '+validStops.length+' plausible · '+validStops.filter(p=>p.stationary).length+' GPS-confirmed · P25 '+(Number.isFinite(expected)?expected.toFixed(1)+'s':'n/a');
   // Display-only decimation: retain full GPS data for calculations and
   // pit detection, but draw older laps at ~10-20 points/lap. Preserve
   // local extrema to avoid hiding pit entries or meaningful gap changes.
   // Cache until a new recording snapshot arrives; panning never resamples.
   if(this.renderSeriesKey!==this.processedKey+':'+this.referenceLapAdjustment+':'+this.fuelEffect+':'+this.referenceMode+':'+this.useDriverProfiles+':'+this.applyTimingCorrections+':'+this.smoothingSeconds||!this.renderSeries){
    const maxDistance=Math.max(...[...series.values()].map(points=>points.at(-1)?.[0]??0));
    const recentFrom=maxDistance-2;
    const decimate=points=>{
     if(points.length<100)return points;
     const out=[];let i=0;
     while(i<points.length){
      const lap=Math.floor(points[i][0]);
      let end=i+1;
      while(end<points.length&&Math.floor(points[end][0])===lap)end++;
      if(lap>=Math.floor(recentFrom)-1||end-i<=24){
       for(let j=i;j<end;j++)out.push(points[j]);
      }else{
       // Eight bins, first/last plus minimum and maximum in each bin.
       // Retains sharp pit-loss changes without drawing every GPS point.
       out.push(points[i]);
       for(let bin=0;bin<8;bin++){
        const from=i+Math.floor((end-i)*bin/8);
        const to=i+Math.floor((end-i)*(bin+1)/8);
        if(to<=from)continue;
        let lo=from,hi=from;
        for(let j=from+1;j<to;j++){
         if(points[j][1]<points[lo][1])lo=j;
         if(points[j][1]>points[hi][1])hi=j;
        }
        for(const j of [...new Set([lo,hi])].sort((a,b)=>a-b))
         if(j>i&&j<end-1)out.push(points[j]);
       }
       out.push(points[end-1]);
      }
      i=end;
     }
     return out;
    };
    this.renderSeries=new Map([...series].map(([id,points])=>[id,decimate(points)]));
    this.renderSeriesKey=this.processedKey+':'+this.referenceLapAdjustment+':'+this.fuelEffect+':'+this.referenceMode+':'+this.useDriverProfiles+':'+this.applyTimingCorrections+':'+this.smoothingSeconds;
   }
   const displaySeries=this.renderSeries;
   let minX=Infinity,maxX=-Infinity,pointCount=0;
   const gapValues=[];
   for(const points of series.values())for(const p of points){
    minX=Math.min(minX,p[0]);
    maxX=Math.max(maxX,p[0]);
    gapValues.push(p[1]);
    pointCount++;
   }
   if(!pointCount)throw Error('No overlapping race distances for gap calculation');
   gapValues.sort((a,b)=>a-b);
   // Default vertical extent is always one reference lap plus 10s:
   // half a lap above and below zero, with 5s padding at each end.
   // Keep manual panning available; reference-lap dragging resets Y.
   const halfRange=Math.max(5,referenceSeconds/2+5);
   const minGap=-halfRange,maxGap=halfRange;
   const ctx=canvas.getContext('2d'),w=this.canvasWidth,h=this.canvasHeight;
   ctx.setTransform(this.canvasScale,0,0,this.canvasScale,0,0);
   ctx.clearRect(0,0,w,h);ctx.fillStyle='#0b1220';ctx.fillRect(0,0,w,h);
   // Initial/reset X covers the declared race distance, not just laps
   // received so far. The official first racing lap starts here.
   if(!this.viewport)this.viewport={
    xMin:raceStartDistance,
    xMax:raceStartDistance+raceLaps,
    yMin:minGap,yMax:maxGap
   };
   if(this.liveView&&this.viewport){
    // Follow the furthest recorded race position with one lap of look-ahead.
    // Only the X extent changes; preserve the current Y range.
    this.viewport={...this.viewport,xMin:raceStartDistance,
     xMax:Math.max(raceStartDistance+1,Math.min(raceStartDistance+raceLaps,maxX+1))};
   }
   const view=this.viewport;
   const x=v=>52+(v-view.xMin)/Math.max(.001,view.xMax-view.xMin)*(w-76);
   const y=v=>20+(view.yMax-v)/Math.max(.001,view.yMax-view.yMin)*(h-60);
   ctx.strokeStyle='#334155';ctx.lineWidth=1;ctx.font='12px system-ui';
   for(let lap=Math.ceil(view.xMin);lap<=view.xMax;lap++){
    ctx.beginPath();ctx.moveTo(x(lap),15);ctx.lineTo(x(lap),h-32);ctx.stroke();
    ctx.fillStyle='#aab';
    // Aligned GPS distance zero is the START of racing lap 1.
    // The formation lap is outside the plotted race distance.
    const axisLabel=String(lap);
    ctx.fillText(axisLabel,x(lap)+3,h-12);
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
   // A sparse timing sample may omit track_status entirely. Missing data
   // is NOT a green flag; only an explicit non-neutral status closes a VSC/SC.
   const classifyStatus=value=>{
    const s=String(value??'').trim().toUpperCase();
    if(!s)return undefined;
    if(/^(VSC|VIRTUAL SAFETY CAR|VIRTUAL SAFETY CAR DEPLOYED)$/.test(s))return 'VSC';
    if(/^(SC|SAFETY CAR|SAFETY CAR DEPLOYED)$/.test(s))return 'SC';
    if(/^(1|GREEN|CLEAR|ALL CLEAR|NORMAL)$/.test(s))return null;
    return undefined;
   };
   for(const sample of this.timing.samples){
    const type=classifyStatus(sample.track_status);
    if(type===undefined)continue;
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
   const lapSeconds=referenceSeconds;
   // Dashed lapped-car overlays use the same geometry as the solid lines,
   // shifted by +1 lap and +1 reference lap time.
   // Tooltip data is assigned later, after driver metadata is assembled.
   ctx.save();ctx.beginPath();ctx.rect(52,15,w-70,h-47);ctx.clip();
   // A time interval maps to diagonal boundaries in gap/distance space.
   for(const p of periods){
    if(!(p.end>p.start))continue;
    // The most recent neutralisation may extend beyond the last leader GPS
    // frame; keep its boundary visible at the end of the recorded trace.
    const start=refDistanceAtTime(Math.max(ref[0][2],Math.min(p.start,ref.at(-1)[2])));
    const end=refDistanceAtTime(Math.max(ref[0][2],Math.min(p.end,ref.at(-1)[2])));
    if(start===null||end===null)continue;
    ctx.fillStyle=p.type==='VSC'?'rgba(234,179,8,.16)':'rgba(251,146,60,.16)';
    ctx.strokeStyle=p.type==='VSC'?'#eab308':'#fb923c';
    ctx.beginPath();
    ctx.moveTo(x(start+view.yMin/lapSeconds),y(view.yMin));
    ctx.lineTo(x(end+view.yMin/lapSeconds),y(view.yMin));
    ctx.lineTo(x(end+view.yMax/lapSeconds),y(view.yMax));
    ctx.lineTo(x(start+view.yMax/lapSeconds),y(view.yMax));
    ctx.closePath();ctx.fill();
    ctx.setLineDash([5,5]);ctx.beginPath();
    ctx.moveTo(x(start+view.yMin/lapSeconds),y(view.yMin));
    ctx.lineTo(x(start+view.yMax/lapSeconds),y(view.yMax));ctx.stroke();ctx.setLineDash([]);
    ctx.font='bold 13px system-ui';ctx.fillText(p.type,x(start)+4,30);
   }
   // Race-control announcements are distinct from the status transition.
   // Only mark an ending announcement if the recorder actually contains it.
   const endingAnnouncements=[];
   for(const sample of this.timing.samples){
    const messages=[
     sample.race_control_messages,sample.race_control,sample.messages,
     sample.race_control_message,sample.message
    ].flatMap(v=>Array.isArray(v)?v:v?[v]:[]);
    for(const message of messages){
     const messageText=typeof message==='string'?message:
      String(message?.message??message?.text??message?.description??'');
     const isVscEnding=/\bVSC\s+ENDING\b|\bVIRTUAL SAFETY CAR\s+ENDING\b/i.test(messageText);
     const isScEnding=/SAFETY CAR (?:IN THIS LAP|ENDING)|\bSC ENDING\b/i.test(messageText)&&!isVscEnding;
     if(!isVscEnding&&!isScEnding)continue;
     const rawTime=typeof message==='object'?
      (message.timestamp??message.time??sample.timestamp):sample.timestamp;
     const t=typeof rawTime==='number'?rawTime:Number(rawTime);
     if(Number.isFinite(t)&&!endingAnnouncements.some(e=>e.text===(isVscEnding?'VSC ENDING':'SC IN THIS LAP')&&Math.abs(e.t-t)<15))
      endingAnnouncements.push({t,text:isVscEnding?'VSC ENDING':'SC IN THIS LAP',vsc:isVscEnding});
    }
   }
   for(const announcement of endingAnnouncements){
    const distance=refDistanceAtTime(announcement.t);
    if(distance===null)continue;
    ctx.save();ctx.strokeStyle=announcement.vsc?'#eab308':'#f97316';ctx.lineWidth=2;
    ctx.setLineDash([3,5]);ctx.beginPath();
    ctx.moveTo(x(distance+minGap/lapSeconds),y(minGap));
    ctx.lineTo(x(distance+maxGap/lapSeconds),y(maxGap));ctx.stroke();
    ctx.setLineDash([]);ctx.font='bold 12px system-ui';
    ctx.fillStyle=announcement.vsc?'#fde047':'#fdba74';ctx.fillText(announcement.text,x(distance)+5,47);
    ctx.restore();
   }
   const colors=['#fb7185','#38bdf8','#a3e635','#fbbf24','#c084fc','#2dd4bf','#f472b6','#93c5fd'];
   let i=0;
   const driverMeta=new Map();
   for(const sample of this.timing.samples)for(const d of sample.drivers||[]){
    const id=String(d.id??'');if(id)driverMeta.set(id,d);
   }
   // The original timing-based card gets authoritative driver/team colours
   // from this live HA sensor, not the reduced recorder JSON.
   const liveState=this._hass?.states?.[this.config.driver_entity];
   const liveDrivers=liveState?.attributes?.drivers;
   if(Array.isArray(liveDrivers))for(const d of liveDrivers){
    const id=String(d.racing_number??d.id??d.driver_number??'');
    if(!id)continue;
    const prior=driverMeta.get(id)||{};
    driverMeta.set(id,{...prior,
     tla:d.tla||prior.tla,
     name:d.name||prior.name,
     team_color:d.team_color||prior.team_color,
     team_name:d.team_name||d.team||prior.team_name,
     tyre_compound:d.tyre_compound||d.compound||d.tyre||prior.tyre_compound,
     position:d.current_position??d.position??prior.position,
     completed_laps:d.completed_laps??prior.completed_laps
    });
   }
   const legend=this.shadowRoot.querySelector('#legend');legend.replaceChildren();
   // Index historical driver states once per recording update. The
   // mousemove handler only does O(log N) lookups for the selected car.
   if(this.historyKey!==this.timing||!this.historyByDriver){
    const history=new Map();
    for(const sample of this.timing.samples||[]){
     if(!Number.isFinite(sample.timestamp))continue;
     for(const d of sample.drivers||[]){
      const id=String(d.id??d.racing_number??'');
      if(!id)continue;
      if(!history.has(id))history.set(id,[]);
      history.get(id).push({
       t:sample.timestamp,
       position:d.position??d.current_position??null,
       completed_laps:Number.isFinite(Number(d.completed_laps))?Number(d.completed_laps):null,
       tyre:d.tyre_compound||d.compound||d.tire_compound||d.tyre||null
      });
     }
    }
    for(const states of history.values())states.sort((a,b)=>a.t-b.t);
    this.historyByDriver=history;
    this.historyKey=this.timing;
   }
   this.hoverSeries={series:displaySeries,meta:driverMeta,lapSeconds,
    history:this.historyByDriver,historyTracks:traces};
   // Stable 2026 team colours, keyed by race number. Prefer live team_color
   // when available, but never use an arbitrary palette for known drivers.
   const teamColours={
    '1':'#FF8000','81':'#FF8000', // McLaren: Norris, Piastri
    '63':'#27F4D2','12':'#27F4D2', // Mercedes: Russell, Antonelli
    '16':'#E80020','44':'#E80020', // Ferrari: Leclerc, Hamilton
    '3':'#3671C6','6':'#3671C6', // Red Bull: Verstappen, Hadjar
    '10':'#FF87BC','43':'#FF87BC', // Alpine: Gasly, Colapinto
    '55':'#64C4FF','23':'#64C4FF', // Williams: Sainz, Albon
    '30':'#6692FF','41':'#6692FF', // Racing Bulls: Lawson, Lindblad
    '31':'#B6BABD','87':'#B6BABD', // Haas: Ocon, Bearman
    '27':'#00E701','5':'#00E701', // Audi: Hulkenberg, Bortoleto
    '14':'#229971','18':'#229971', // Aston Martin: Alonso, Stroll
    '11':'#909090','77':'#909090' // Cadillac: Perez, Bottas
   };
   const colours=new Map();let colourIndex=0;
   for(const [id,points] of displaySeries){
    const meta=driverMeta.get(id)||{};
    const label=String(meta.tla||meta.abbreviation||meta.name||meta.driver_name||('#'+id));
    const explicit=String(meta.team_color||'');
    const color=/^#[0-9a-f]{6}$/i.test(explicit)?explicit:(teamColours[id]||colors[colourIndex%colors.length]);
    colourIndex++;colours.set(id,color);
    const button=document.createElement('button');
    button.textContent=label+' #'+id;
    button.style.borderColor=color;
    if(this.hiddenDrivers.has(id))button.classList.add('off');
    button.onclick=()=>{if(this.hiddenDrivers.has(id))this.hiddenDrivers.delete(id);else this.hiddenDrivers.add(id);this.draw();};
    legend.append(button);
   }
   for(const [id,points] of displaySeries){
    if(this.hiddenDrivers.has(id))continue;
    const color=colours.get(id)||'#fff';i++;
    // A lapped car has a dashed counterpart one lap and one reference
    // lap-time away. Draw separately; never connect the two curves.
    ctx.strokeStyle=color;ctx.lineWidth=1.15;ctx.globalAlpha=.55;ctx.setLineDash([5,7]);
    for(const shift of [-1,1]){
     ctx.beginPath();
     points.forEach((p,j)=>j?ctx.lineTo(x(p[0]+shift),y(p[1]+shift*lapSeconds)):
      ctx.moveTo(x(p[0]+shift),y(p[1]+shift*lapSeconds)));
     ctx.stroke();
    }
    ctx.setLineDash([]);ctx.globalAlpha=1;
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
   // VSC pit projections for the same driver, in neutral grey.
   if(this.pitEnabled&&Number.isFinite(vscEffectiveLoss)&&vscEffectiveLoss>=0){
    const chosen=series.get(this.pitDriver);
    if(chosen?.length){
     for(const sign of [-1,1]){
      ctx.save();ctx.strokeStyle='#94a3b8';ctx.lineWidth=1.8;
      ctx.globalAlpha=.85;ctx.setLineDash([2,5]);ctx.beginPath();
      chosen.forEach((p,j)=>j?ctx.lineTo(x(p[0]),y(p[1]+sign*vscEffectiveLoss)):
       ctx.moveTo(x(p[0]),y(p[1]+sign*vscEffectiveLoss)));
      ctx.stroke();ctx.restore();
     }
    }
   }
   ctx.restore();
   // Render retirement crosses last so other drivers cannot obscure them.
   // Outline in white, then colour the centre for contrast.
   for(const [id,point] of markers){
    if(this.hiddenDrivers.has(id))continue;
    // The marker must use the same profiled, smoothed gap as its trace.
    // The legacy timeAtDistance calculation has a different sign and
    // reference profile, so it can put the X off-screen after the Y flip.
    const pts=series.get(id);
    if(!pts?.length||!point||!Number.isFinite(point[1]))continue;
    // Use the actual retirement distance, not the last rendered point.
    // A trace may continue past that point or be filtered at race start.
    const distance=point[1];
    let lo=0,hi=pts.length-1;
    if(distance<pts[0][0]||distance>pts[hi][0])continue;
    while(hi-lo>1){
     const mid=(lo+hi)>>1;
     if(pts[mid][0]<distance)lo=mid;else hi=mid;
    }
    const a=pts[lo],b=pts[hi],span=b[0]-a[0];
    const gap=span>1e-8?a[1]+(distance-a[0])/span*(b[1]-a[1]):a[1];
    const px=x(distance),py=y(gap);
    // Draw only if the actual retirement point is inside the viewport.
    if(!Number.isFinite(px)||!Number.isFinite(py)||
       px<52||px>w-18||py<15||py>h-32)continue;
    const visibleX=px,visibleY=py;
    const size=6;
    ctx.lineCap='round';ctx.setLineDash([]);
    ctx.beginPath();ctx.moveTo(visibleX-size,visibleY-size);ctx.lineTo(visibleX+size,visibleY+size);
    ctx.moveTo(visibleX-size,visibleY+size);ctx.lineTo(visibleX+size,visibleY-size);
    ctx.strokeStyle='#ffffff';ctx.lineWidth=3.5;ctx.stroke();
    ctx.strokeStyle='#ef4444';ctx.lineWidth=2;ctx.stroke();
    ctx.lineCap='butt';
   }
   status.textContent=series.size+' drivers · '+events.length+' official crossings · '+
    aligned.aligned.length+' aligned · reference car #'+referenceId+
    ' · '+(provisional?'PROVISIONAL S/F (leader at start) · 1:1 leader GPS reference':useLearned?'learned '+selected.length+' clean laps ('+typical.toFixed(1)+'s)':'leader GPS fallback')+
    ' · profiles '+(this.useDriverProfiles?'ON':'OFF')+' ('+profiledDrivers+' drivers / '+profiledPoints+' samples) · '+markers.size+' retired · '+stopped+' stopped · timing corrections '+(this.applyTimingCorrections?'ON':'OFF')+' ('+correctedAnchors+' anchors / '+correctedDrivers+' cars) · gap at equal distance'+validationSummary;
  }catch(e){status.textContent='Experimental diagnostics: '+e.message;}
 }
}
if(!customElements.get('race-trace-gps'))customElements.define('race-trace-gps',RaceTraceGPS);
