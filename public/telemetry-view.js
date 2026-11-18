// First-party WASP dashboard. This document deliberately has NO audio element.
// Only index.html owns the player and any playback queue.
const root=document.getElementById('telemetryRoot');
const safe=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=v=>Number(v||0).toLocaleString();
const clip=s=>String(s||'').slice(0,190);
const state={mode:'top',sub:'telemetry',items:[],query:'',scope:'hive',period:'year',year:new Date().getFullYear(),month:new Date().getMonth()+1,start:new Date().toISOString().slice(0,10),request:0};
const names={top:'Most listened',hearts:'Most hearted',likes:'Most liked',dislikes:'Most disliked'};
const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const tagColors=['#c8f169','#49d8be','#7ba7ff','#a88bff','#ffba67','#ec86b6','#62bfed','#89b8a0'];
const tooltip=document.createElement('div');tooltip.className='telemetry-tooltip';tooltip.hidden=true;
document.body.appendChild(tooltip);
function showTooltip(e,content){
  if(!content){tooltip.hidden=true;return;}
  tooltip.textContent=content;tooltip.hidden=false;
  const width=tooltip.offsetWidth,height=tooltip.offsetHeight;
  const x=Math.max(8,Math.min(innerWidth-width-8,e.clientX+14));
  const y=e.clientY+17+height>innerHeight?e.clientY-height-10:e.clientY+17;
  tooltip.style.left=x+'px';tooltip.style.top=Math.max(6,y)+'px';
}

function tell(type,extra={}){if(window.parent!==window)window.parent.postMessage({type,...extra},location.origin);}
const int=(v,min,max)=>Math.max(min,Math.min(max,Number(v)||min));
const cover=(src,alt,origin='')=>src?`<img loading="lazy" class="cover telemetry-art" src="${safe(src)}" data-art="${safe(src)}" data-origin="${safe(origin)}" alt="${safe(alt)}">`:'<span class="cover empty">♫</span>';
function artUrl(r,type){
  if(type==='artists')return '/art/artist?name='+encodeURIComponent(r.name||'');
  return '/art/album?artist='+encodeURIComponent(r.artist||'')+'&album='+encodeURIComponent(r.album||r.name||'');
}
let artPeersPromise=null,artOrigins=[];
function getArtPeers(){return artPeersPromise||(artPeersPromise=fetch('/api/network/peers',{cache:'no-store'}).then(r=>r.ok?r.json():[]).then(rows=>Array.isArray(rows)?rows:[]).catch(()=>[]));}
root.addEventListener('error',async e=>{const img=e.target;if(!img.classList?.contains('telemetry-art'))return;
 if(img.dataset.busy==='1')return;img.dataset.busy='1';const peers=await getArtPeers();if(!img.isConnected)return;
 const source=artOrigins.find(x=>x.node_id===img.dataset.origin)?.url;
 const sorted=[...peers].filter(p=>p.online!==false&&p.url).sort((a,b)=>Number(b.url===source)-Number(a.url===source));
 const i=Number(img.dataset.attempt)||0;const bases=sorted.map(p=>p.relay_base||p.url).filter(b=>b&&(/^\/_peer\/[\w-]+$/.test(b)||/^https:\/\//.test(b)));const base=bases[i];
 img.dataset.attempt=String(i+1);img.dataset.busy='0';if(base&&i<3){img.src=base.replace(/\/$/,'')+img.dataset.art;}else {const placeholder=document.createElement('span');placeholder.className='cover empty';placeholder.textContent='♫';img.replaceWith(placeholder);}
},true);
function rankList(rows,type){
  const noun=type==='artists'?'artist':type==='albums'?'album':'track';
  return `<div class="ranking-card"><h3>Top ${safe(type)}</h3>${rows?.length?rows.map((r,i)=>{
    const target=type==='artists'?'#artist/'+encodeURIComponent(r.name):
      type==='albums'?'#album/'+encodeURIComponent(r.artist||'')+'/'+encodeURIComponent(r.name):'';
    return `<button class="rank-row" type="button" ${target?`data-href="${safe(target)}"`:'data-noaction="true"'}>
      <span class="position">${i+1}</span>${cover(artUrl(r,type),r.name,r.origin_id)}<span class="song-info"><b>${safe(r.name)}</b><small>${safe(type==='artists'?'Artist':r.artist||noun)}</small></span>
      <span class="count">${n(r.plays)}</span></button>`;
  }).join(''):'<p class="message">No confirmed listens yet.</p>'}</div>`;
}
function bars(rows,weekly=false){
  const values=weekly?Array.from({length:7},(_,i)=>({label:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][i],plays:Number(rows.find(x=>Number(x.weekday)===i)?.plays)||0})):
    rows.map(x=>({label:x.label,plays:Number(x.plays)||0}));
  const max=Math.max(1,...values.map(x=>x.plays));
  return `<div class="chart" role="img" aria-label="Listening activity bars">${values.length?values.map(v=>`<div class="bar-slot" tabindex="0" data-tip="${safe(v.label)}: ${n(v.plays)} confirmed plays"><i class="bar" style="height:${Math.max(1,100*v.plays/max)}%"></i><small>${safe(v.label.slice(-5))}</small></div>`).join(''):'<p class="message">No recorded activity for this period.</p>'}</div>`;
}
function anglePoint(cx,cy,r,angle){const q=angle*Math.PI/180;return [cx+r*Math.cos(q),cy+r*Math.sin(q)];}
function annularPath(cx,cy,inside,outside,start,end){
  const a=anglePoint(cx,cy,outside,start),b=anglePoint(cx,cy,outside,end),
    c=anglePoint(cx,cy,inside,end),d=anglePoint(cx,cy,inside,start);
  return `M${a.join(',')} A${outside},${outside} 0 0 1 ${b.join(',')} L${c.join(',')} A${inside},${inside} 0 0 0 ${d.join(',')} Z`;
}
function hourChart(rows){
  const counts=Array.from({length:24},(_,i)=>Number(rows.find(x=>Number(x.hour)===i)?.plays)||0);
  const max=Math.max(1,...counts),total=counts.reduce((a,b)=>a+b,0);
  const busiest=counts.indexOf(Math.max(...counts));
  const parts=counts.map((v,i)=>{
    const degree=-90+i*15,depth=v>0?32*(.3+.7*v/max):0;
    const path=annularPath(160,150,78,78+depth,degree+1,degree+14);
    return `<path class="clock-sector ${v?'has-plays':'no-plays'}" tabindex="0" role="img" aria-label="${i}:00: ${v} plays" data-tip="${String(i).padStart(2,'0')}:00–${String((i+1)%24).padStart(2,'0')}:00: ${n(v)} confirmed plays${total?' · '+(100*v/total).toFixed(1)+'% of this period':''}" d="${path}" style="--intensity:${v/max}"></path>`;
  }).join('');
  const ticks=[0,6,12,18].map(i=>{
    const [x,y]=anglePoint(160,150,132,-90+i*15);
    return `<text x="${x}" y="${y+4}" text-anchor="middle" class="clock-tick">${String(i).padStart(2,'0')}</text>`;
  }).join('');
  return `<div class="clock-wrap"><svg viewBox="0 0 320 305" role="group" aria-label="24-hour listening clock">
    <circle cx="160" cy="150" r="94" fill="none" stroke="#383734" stroke-width="33"/>
    ${parts}${ticks}<text x="160" y="141" text-anchor="middle" class="clock-center-small">BUSIEST HOUR</text>
    <text x="160" y="166" text-anchor="middle" class="clock-center-big">${total?String(busiest).padStart(2,'0')+':00':'—'}</text>
    <text x="160" y="186" text-anchor="middle" class="clock-center-small">${n(counts[busiest])} plays</text>
    </svg><div class="clock-caption"><b>${total?n(counts[busiest]):'0'}</b> confirmed plays at the busiest hour<br>
    <small>Each segment is one hour in your selected timezone.</small></div></div>`;
}
function tagStream(tags,series){
  if(!tags?.length)return `<p class="message">Genre information is not yet available for the songs in this period. Artist tags are used only when confirmed by WASP metadata.</p>`;
  const labels=[...new Set((series||[]).map(r=>r.label))];
  if(!labels.length)for(const r of tags[0]?.periods||[])labels.push(r.label);
  const W=640,H=200,margin=18;
  const rows=tags.slice(0,8).map((t,i)=>({
    ...t,color:tagColors[i],values:labels.map(k=>Number(t.periods?.find(r=>r.label===k)?.plays)||0)}));
  const sum=labels.map((_,i)=>rows.reduce((a,r)=>a+r.values[i],0));
  const max=Math.max(1,...sum),scale=145/max;
  const xpos=i=>margin+(labels.length<2?W/2:(W-2*margin)*i/(labels.length-1));
  const baseline=sum.map(total=>H/2+total*scale/2);
  const layers=rows.map((t,j)=>{
    const lower=t.values.map((_,i)=>baseline[i]-rows.slice(0,j).reduce((s,r)=>s+r.values[i],0)*scale);
    const upper=t.values.map((v,i)=>lower[i]-v*scale);
    const points=upper.map((y,i)=>[xpos(i),y]).concat(lower.map((y,i)=>[xpos(i),y]).reverse());
    const d=points.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')+' Z';
    const peak=t.periods?.reduce((a,b)=>Number(b.plays)>Number(a?.plays||0)?b:a,null);
    const tip=`${t.name}: ${n(t.plays)} tagged plays${peak?' · Peak '+peak.label+': '+n(peak.plays):''}`;
    return `<path class="genre-layer" tabindex="0" role="img" data-genre="${safe(t.name)}" data-tip="${safe(tip)}" d="${d}" fill="${t.color}" />`;
  }).join('');
  const ticks=labels.filter((_,i)=>i%Math.max(1,Math.ceil(labels.length/8))===0);
  const tickLabels=ticks.map(label=>{const i=labels.indexOf(label);return `<text x="${xpos(i)}" y="216" text-anchor="middle" fill="#aaa299" font-size="11">${safe(label.slice(-7))}</text>`;}).join('');
  return `<div class="stream-wrap"><svg class="genre-chart" viewBox="0 0 640 230" aria-label="Genre listening activity over time" role="group">
     <line x1="18" y1="100" x2="622" y2="100" stroke="#55534d" stroke-dasharray="2,4" opacity=".45" />
     ${layers}${tickLabels}</svg><div class="tag-legend">${rows.map(t=>`<button type="button" class="tag-key" data-genre="${safe(t.name)}" data-tip="${safe(t.name)}: ${n(t.plays)} tagged plays"><i style="background:${t.color}"></i><span>${safe(t.name)}</span><b>${n(t.plays)}</b></button>`).join('')}</div>
     <p class="note">Tags can overlap: a play may count toward more than one genre. Labels come from available artist or track metadata.</p></div>`;
}
function decadesChart(rows,total,yearMetadataPlays){
  const raw=rows||[];
  if(!raw.length)return `<p class="message">No verified release-year metadata yet. Enable metadata enrichment in Admin → Network → Telemetry. Unknown years are never estimated.</p>`;
  const early=raw.filter(r=>Number(r.decade)<1960);const decades=[{decade:1950,plays:early.reduce((n,r)=>n+Number(r.plays||0),0),topAlbum:early.sort((a,b)=>b.plays-a.plays)[0]?.topAlbum||'',topArtist:early[0]?.topArtist||''},...Array.from({length:Math.max(7,Math.floor(new Date().getFullYear()/10)-196)},(_,i)=>raw.find(r=>Number(r.decade)===1960+i*10)||{decade:1960+i*10,plays:0})];
  const max=Math.max(1,...decades.map(r=>Number(r.plays)||0));
  const bars=decades.map(r=>{
    const d=Number(r.decade),label=d<1960?'Pre-1960':`${d}s`,plays=Number(r.plays)||0;
    const pct=total?100*plays/total:0;
    const details=[`${label}: ${n(plays)} plays (${pct.toFixed(1)}%)`,`${n(r.artists)} artists, ${n(r.albums)} albums, ${n(r.tracks)} tracks`,r.topAlbum?`Top album: ${r.topAlbum} · ${r.topArtist}`:''].filter(Boolean).join(' · ');
    return `<div class="decade-row" tabindex="0" data-tip="${safe(details)}"><span>${safe(label)}</span><div class="decade-track"><div class="decade-fill${plays===max?' best':''}" style="width:${Math.max(0,100*plays/max)}%"></div></div><b>${n(plays)}</b><small>${pct.toFixed(1)}%</small></div>`;
  }).join('');
  const best=[...decades].sort((a,b)=>Number(b.plays)-Number(a.plays))[0];
  return `<div class="decades-chart">${bars}<div class="decade-summary"><b>${best.decade<1960?'Pre-1960':Number(best.decade)+'s'} · Most played era</b>${best.topAlbum?cover(artUrl({name:best.topAlbum,artist:best.topArtist},'albums'),best.topAlbum):''}<small>${best.topAlbum?`Top album: ${safe(best.topAlbum)} · ${safe(best.topArtist)}`:'Decade with the most confirmed plays'}</small></div>
  <p class="note">${n(yearMetadataPlays)} of ${n(total)} plays have verified release-year metadata. Unknown years are excluded.</p></div>`;
}
let worldPromise=null;
async function mountWorldMap(request,countries,unknown){
  const target=root.querySelector('#worldMap');if(!target)return;
  try{
    if(!worldPromise)worldPromise=fetch('/telemetry-world.json?v=17.0.1').then(r=>{if(!r.ok)throw Error('Map unavailable');return r.json();});
    const countriesMap=new Map((countries||[]).map(r=>[r.code,r]));
    const shapes=await worldPromise;
    if(request!==state.request||!target.isConnected)return;
    if(!Array.isArray(shapes))throw Error('Map is unavailable');
    const max=Math.max(1,...[...countriesMap.values()].map(x=>Number(x.plays)||0));
    const paths=shapes.map(c=>{
      const row=countriesMap.get(c.code),plays=Number(row?.plays)||0;
      const strength=plays>0?.2+.8*Math.sqrt(plays/max):0;
      const fill=plays>0?`rgba(200,241,105,${strength.toFixed(3)})`:'#343735';
      return `<path class="map-country${plays?' active':''}" tabindex="0" data-tip="${safe(c.name+': '+n(plays)+' confirmed plays'+(row?' · '+n(row.artists)+' artists':''))}" aria-label="${safe(c.name+': '+n(plays)+' plays')}" d="${safe(c.d)}" fill="${fill}"/>`;
    }).join('');
    target.innerHTML=`<svg viewBox="0 0 900 435" role="group" aria-label="Listening activity by verified artist origin country">${paths}</svg>`;
    resized();
  }catch {if(target.isConnected)target.textContent='Map data unavailable.';}
}
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
    artOrigins=Array.isArray(data.artworkOrigins)?data.artworkOrigins:[];
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
      <div class="section"><div class="panel"><div class="chart-head"><h2>Top tags · genre trends</h2><small>Hover to highlight a genre</small></div>${tagStream(data.topTags||[],data.series||[])}</div></div>
      <div class="two-col section"><div class="panel"><div class="chart-head"><h2>Artist origin heat map</h2><small>Verified country metadata only</small></div>
        <div id="worldMap" class="world-map"><p class="message">Preparing country map…</p></div>
        <div class="world-legend"><span>Lower activity</span><i></i><strong>Higher activity</strong></div>
        <p class="note">${n(data.unknownCountryPlays)} plays have unknown artist origin. Artist geography is not inferred from IP addresses or user locations.</p>
      </div><div class="panel"><div class="chart-head"><h2>Music by decade</h2><small>Album / track release years</small></div>
        ${decadesChart(data.decades||[],Number(data.plays)||0,Number(data.yearMetadataPlays)||0)}</div></div>
      <div class="info-card section"><h3>Listening privacy</h3><p>The HIVE view shows aggregate activity. Personal listening profiles and named-user leaderboards are not shared with peers.</p></div>
      <p class="history-note">${safe(data.historicalCoverage)} Figures represent confirmed WASP play events, not audio bytes transferred or the length of entire songs. Metadata sources: <a href="https://musicbrainz.org" target="_blank" rel="noopener">MusicBrainz</a> and <a href="https://www.last.fm" target="_blank" rel="noopener">Last.fm</a>.</p>`;
    void mountWorldMap(request,data.countries||[],data.unknownCountryPlays||0);
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
function updateTagFocus(el){
  const tag=el?.closest?.('[data-genre]')?.dataset.genre;
  root.querySelectorAll('[data-genre]').forEach(node=>node.classList.toggle('dimmed',Boolean(tag)&&node.dataset.genre!==tag));
  root.querySelectorAll('[data-genre]').forEach(node=>node.classList.toggle('highlighted',Boolean(tag)&&node.dataset.genre===tag));
}
root.addEventListener('pointermove',e=>{
  const active=e.target.closest?.('[data-tip]');
  updateTagFocus(active);
  showTooltip(e,active?.dataset.tip||'');
});
root.addEventListener('pointerleave',()=>{showTooltip(null,'');updateTagFocus(null);});
root.addEventListener('focusin',e=>{
  const active=e.target.closest?.('[data-tip]');updateTagFocus(active);
  if(active){const r=active.getBoundingClientRect();showTooltip({clientX:r.left+r.width/2,clientY:r.top},active.dataset.tip);}
});
root.addEventListener('focusout',()=>{showTooltip(null,'');updateTagFocus(null);});
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
