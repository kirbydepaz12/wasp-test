// First-party WASP dashboard. This document deliberately has NO audio element.
// Only index.html owns the player and any playback queue.
const root=document.getElementById('telemetryRoot');
const safe=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=v=>Number(v||0).toLocaleString();
const clip=s=>String(s||'').slice(0,190);
const state={mode:'top',sub:'telemetry',items:[],query:'',scope:'hive',period:'year',year:new Date().getFullYear(),month:new Date().getMonth()+1,start:new Date().toISOString().slice(0,10),request:0};
const names={top:'Most listened',hearts:'Most hearted',likes:'Most liked',dislikes:'Most disliked'};
const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function tell(type,extra={}){if(window.parent!==window)window.parent.postMessage({type,...extra},location.origin);}
const int=(v,min,max)=>Math.max(min,Math.min(max,Number(v)||min));
const cover=(src,alt)=>src?`<img loading="lazy" class="cover" src="${safe(src)}" alt="${safe(alt)}" onerror="this.style.display='none'">`:'<span class="cover empty">♫</span>';
function artUrl(r,type){
  if(type==='artists')return '/art/artist?name='+encodeURIComponent(r.name||'');
  return '/art/album?artist='+encodeURIComponent(r.artist||'')+'&album='+encodeURIComponent(r.album||r.name||'');
}
function rankList(rows,type){
  const noun=type==='artists'?'artist':type==='albums'?'album':'track';
  return `<div class="ranking-card"><h3>Top ${safe(type)}</h3>${rows?.length?rows.map((r,i)=>{
    const target=type==='artists'?'#artist/'+encodeURIComponent(r.name):
      type==='albums'?'#album/'+encodeURIComponent(r.artist||'')+'/'+encodeURIComponent(r.name):'';
    return `<button class="rank-row" type="button" ${target?`data-href="${safe(target)}"`:'data-noaction="true"'}>
      <span class="position">${i+1}</span>${cover(artUrl(r,type),r.name)}<span class="song-info"><b>${safe(r.name)}</b><small>${safe(type==='artists'?'Artist':r.artist||noun)}</small></span>
      <span class="count">${n(r.plays)}</span></button>`;
  }).join(''):'<p class="message">No confirmed listens yet.</p>'}</div>`;
}
function bars(rows,weekly=false){
  const values=weekly?Array.from({length:7},(_,i)=>({label:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][i],plays:Number(rows.find(x=>Number(x.weekday)===i)?.plays)||0})):
    rows.map(x=>({label:x.label,plays:Number(x.plays)||0}));
  const max=Math.max(1,...values.map(x=>x.plays));
  return `<div class="chart" role="img" aria-label="Listening activity bars">${values.length?values.map(v=>`<div class="bar-slot" title="${safe(v.label)}: ${n(v.plays)} confirmed plays"><i class="bar" style="height:${Math.max(1,100*v.plays/max)}%"></i><small>${safe(v.label.slice(-5))}</small></div>`).join(''):'<p class="message">No recorded activity for this period.</p>'}</div>`;
}
function hourChart(rows){const max=Math.max(1,...rows.map(x=>Number(x.plays)||0));return `<div class="hour-chart" role="img" aria-label="Listening by time of day">
  ${Array.from({length:24},(_,i)=>{const value=Number(rows.find(x=>Number(x.hour)===i)?.plays)||0;return `<div class="hour" title="${i}:00 — ${n(value)} confirmed plays"><i style="height:${Math.max(2,90*value/max)}%"></i><small>${i%3===0?String(i).padStart(2,'0'):''}</small></div>`;}).join('')}</div>`;}
function fingerprint(data){
  const values=[Number(data.consistency)||0,1-(Number(data.concentration)||0),Number(data.repeatRate)||0,Number(data.artists||0)/Math.max(1,Number(data.plays)||1),Number(data.activeDays||0)/Math.max(1,Number(data.plays)||1)];
  const labels=['Consistency','Diversity','Repeat rate','Artist variety','Activity spread'];
  const point=(i,r)=>{const angle=-Math.PI/2+i*2*Math.PI/5;return (150+Math.cos(angle)*r).toFixed(1)+','+(112+Math.sin(angle)*r).toFixed(1);};
  const axis=labels.map((label,i)=>{const a=-Math.PI/2+i*2*Math.PI/5;
    return `<line x1="150" y1="112" x2="${150+Math.cos(a)*85}" y2="${112+Math.sin(a)*85}" stroke="#524e45"/><text x="${150+Math.cos(a)*108}" y="${116+Math.sin(a)*100}" text-anchor="middle" fill="#aaa299" font-size="10">${label}</text>`;}).join('');
  const poly=values.map((v,i)=>point(i,Math.max(0,Math.min(1,v))*82)).join(' ');
  return `<svg viewBox="0 0 300 228" width="100%" role="img" aria-label="Five-axis listening fingerprint">${[30,55,82].map(r=>`<polygon points="${labels.map((_,i)=>point(i,r)).join(' ')}" fill="none" stroke="#524e45"/>`).join('')}${axis}<polygon points="${poly}" fill="rgba(200,241,105,.27)" stroke="#c8f169" stroke-width="2"/></svg>`;
}
function metric(label,value,extra=''){return `<div class="metric"><span class="lab">${safe(label)}</span><strong>${n(value)}</strong><small>${safe(extra||'This period')}</small></div>`;}
function controls(){return `<div class="controls" role="group" aria-label="Telemetry date filters">
  <div class="switches">${[['week','Week'],['month','Month'],['year','Year'],['all','All time']].map(([v,l])=>`<button type="button" data-period="${v}" class="chip${state.period===v?' active':''}" aria-pressed="${state.period===v}">${l}</button>`).join('')}</div>
  <label class="control">Year<select id="year">${Array.from({length:12},(_,i)=>new Date().getFullYear()-i).map(y=>`<option value="${y}" ${state.year===y?'selected':''}>${y}</option>`).join('')}</select></label>
  ${state.period==='month'?`<label class="control">Month<select id="month">${months.map((v,i)=>`<option value="${i+1}" ${state.month===i+1?'selected':''}>${v}</option>`).join('')}</select></label>`:''}
  <label class="control">Listening scope<select id="scope"><option value="hive" ${state.scope==='hive'?'selected':''}>Entire HIVE</option><option value="local" ${state.scope==='local'?'selected':''}>This server</option></select></label>
  <div class="period-nav"><button type="button" data-step="-1" title="Previous period" aria-label="Previous period">‹</button><button type="button" data-step="1" title="Next period" aria-label="Next period">›</button></div>
  </div>`;}
function syncLabel(data){return data.lastSynced?'Synced '+new Date(data.lastSynced).toLocaleString():'Local cache · peer sync pending';}
async function showHive(){
  const request=++state.request;
  root.innerHTML=`<div class="heading"><div><span class="eyebrow">WASP · NETWORK LISTENING</span><h1>HIVE Telemetry</h1><p>ONE HIVE. EVERY BEAT.</p></div><span class="status">Loading historical data…</span></div>${controls()}<p class="loading">Reading cached telemetry…</p>`;
  resized();
  const params=new URLSearchParams({scope:state.scope,period:state.period,year:String(state.year),month:String(state.month),offset:String(-new Date().getTimezoneOffset())});
  if(state.period==='week')params.set('start',state.start);
  try{
    const response=await fetch('/api/telemetry?'+params,{cache:'no-store'});
    const data=await response.json();
    if(request!==state.request)return;
    if(!response.ok)throw Error(data.error||'Statistics are temporarily unavailable');
    const growth=data.previousPlays>0?`${Math.round((data.plays-data.previousPlays)*100/data.previousPlays)}% vs previous period`:'No comparable previous period';
    root.innerHTML=`<div class="heading"><div><span class="eyebrow">WASP · NETWORK LISTENING</span><h1>HIVE Telemetry</h1><p>ONE HIVE. EVERY BEAT.</p></div><span class="status">${safe(syncLabel(data))}</span></div>
      ${controls()}
      <div class="metric-grid">${metric('Confirmed plays',data.plays,growth)}${metric('Unique artists',data.artists)}${metric('Unique albums',data.albums)}${metric('Unique tracks',data.tracks)}</div>
      <div class="two-col section"><div class="panel"><div class="chart-head"><h2>Listening history</h2><small>${safe(state.period==='year'?'By month':'By day')}</small></div>${bars(data.series||[])}</div>
      <div class="panel"><div class="chart-head"><h2>Listening clock</h2><small>By hour · your timezone</small></div>${hourChart(data.hours||[])}</div></div>
      <div class="section"><h2>Most played music</h2><div class="three-col">${rankList(data.topArtists,'artists')}${rankList(data.topAlbums,'albums')}${rankList(data.topTracks,'tracks')}</div></div>
      <div class="two-col section"><div class="panel"><h2>Days of the week</h2>${bars(data.weekdays||[],true)}</div>
      <div class="info-card"><h3>Across the HIVE</h3><p><b>${n(data.nodes)}</b> contributing origin servers in this period.</p>
      <p><b>${n(data.connectedCaches)}</b> peer cursors synchronized to this server.</p><p>Each server keeps its own cached copy. Events carry unique origin identifiers so relayed plays can be counted once.</p></div></div>
      <div class="section"><h2>Listening fingerprint & quick facts</h2><div class="two-col">
        <div class="panel"><div class="chart-head"><h2>Music fingerprint</h2><small>Recorded activity, not personal profiling</small></div>
          <div class="fingerprint">${fingerprint(data)}</div>
          <p class="note">Repeat rate: replayed tracks / total plays. Concentration: top artist's share. Consistency: active days / days in range.</p></div>
        <div class="panel"><div class="fact-grid">
          <div><span>Longest recorded streak</span><b>${n(data.longestStreak)} days</b></div>
          <div><span>Most active day</span><b>${safe(data.mostActiveDay||'—')}</b><small>${n(data.mostActiveDayPlays)} plays</small></div>
          <div><span>Busiest listening hour</span><b>${data.busiestHour==null?'—':String(data.busiestHour).padStart(2,'0')+':00'}</b><small>${n(data.busiestHourPlays)} plays</small></div>
          <div><span>Active days in selected period</span><b>${n(data.activeDays)}</b></div>
        </div></div></div></div>
      <div class="two-col section"><div class="info-card"><h3>Genres & discovery</h3><p>Additional breakdowns appear when verified genre and release-year metadata becomes available. WASP won't invent missing tags or artist geography.</p></div>
      <div class="info-card"><h3>Listening privacy</h3><p>The HIVE view shows aggregate activity. Personal listening profiles and named-user leaderboards are not shared with peers.</p></div></div>
      <p class="history-note">${safe(data.historicalCoverage)} Figures represent confirmed WASP play events, not audio bytes transferred or the length of entire songs.</p>`;
  }catch(e){if(request===state.request)root.innerHTML=`<div class="heading"><div><span class="eyebrow">WASP HIVE</span><h1>Telemetry</h1></div></div>${controls()}<p class="message">${safe(e.message)}</p>`;}
  resized();
}
function showRanking(){++state.request;const rows=state.items;const header=(state.mode==='top'?names.top:names[state.mode]||'Rankings')+(state.mode==='top'?'':` · ${state.sub}`);
  root.innerHTML=`<div class="heading"><div><span class="eyebrow">WASP · MUSIC RANKINGS</span><h1>${safe(header)}</h1><p>${state.mode==='top'?'Most listened tracks available on this server and its connected peers.':'Reactions recorded for local and available peer music.'}</p></div></div>
    ${rows.length?`<div class="browse-grid">${rows.map((r,i)=>`<button type="button" class="browse-tile" data-kind="${safe(r.kind)}" data-id="${safe(r.id)}"><span class="picture">${r.cover?`<img loading="lazy" src="${safe(r.cover)}" alt="" onerror="this.style.display='none'">`:''}</span><b>${safe(r.title)}</b><small>${safe(r.subtitle||'')}</small><small>${n(r.score)} ${safe(r.scoreLabel||'votes')}</small></button>`).join('')}</div>`:
      '<p class="message">Nothing here yet. Results appear when songs are played or rated.</p>'}`;
  resized();
}
function resized(){requestAnimationFrame(()=>tell('wasp:telemetry-height',{height:Math.ceil(document.body.scrollHeight)}));}
function movePeriod(delta){
  if(state.period==='month'){state.month+=delta;if(state.month<1){state.month=12;state.year--;}if(state.month>12){state.month=1;state.year++;}}
  else if(state.period==='week'){const d=new Date(state.start+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+delta*7);state.start=d.toISOString().slice(0,10);}
  else state.year+=delta;
  state.year=int(state.year,2000,2100);
}
root.addEventListener('change',e=>{
  if(e.target.id==='year')state.year=int(e.target.value,2000,2100);
  else if(e.target.id==='month')state.month=int(e.target.value,1,12);
  else if(e.target.id==='scope')state.scope=e.target.value==='local'?'local':'hive';
  else return;
  if(state.mode==='top'&&state.sub==='telemetry')void showHive();
});
root.addEventListener('click',e=>{
  const period=e.target.closest('[data-period]');if(period){state.period=period.dataset.period;void showHive();return;}
  const step=e.target.closest('[data-step]');if(step){movePeriod(Number(step.dataset.step));void showHive();return;}
  const link=e.target.closest('[data-href]');if(link){tell('wasp:telemetry-navigate',{href:link.dataset.href});return;}
  const row=e.target.closest('[data-kind][data-id]');if(!row)return;
  const id=row.dataset.id;
  if(row.dataset.kind==='song')tell('wasp:telemetry-play',{id});
  else if(row.dataset.kind==='artist')tell('wasp:telemetry-navigate',{href:'#artist/'+encodeURIComponent(id)});
  else if(row.dataset.kind==='playlist')tell('wasp:telemetry-navigate',{href:'#playlist/'+encodeURIComponent(id)});
});
window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==window.parent||event.data?.type!=='wasp:telemetry-data')return;
  const data=event.data;
  state.mode=['top','hearts','likes','dislikes'].includes(data.mode)?data.mode:'top';
  state.sub=typeof data.sub==='string'?data.sub:'ranked';
  state.items=Array.isArray(data.items)?data.items.slice(0,100):[];
  state.query=String(data.query||'');
  if(state.mode==='top'&&state.sub==='telemetry')void showHive();else showRanking();
});
const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(resized):null;
if(observer)observer.observe(root);
window.addEventListener('load',()=>{tell('wasp:telemetry-ready');resized();});
window.addEventListener('pageshow',()=>{tell('wasp:telemetry-ready');resized();});
