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
   // Fixed-distance interpolation already reduces sample-to-sample jitter.
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
