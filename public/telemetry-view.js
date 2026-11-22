// First-party WASP dashboard. This document deliberately has NO audio element.
// Only index.html owns the player and any playback queue.
const root=document.getElementById('telemetryRoot');
const safe=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=v=>Number(v||0).toLocaleString();
const clip=s=>String(s||'').slice(0,190);
function localToday(){const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);}
const state={mode:'top',sub:'telemetry',items:[],query:'',scope:'hive',period:'week',year:new Date().getFullYear(),month:new Date().getMonth()+1,start:localToday(),request:0,rankingSort:'most'};
const names={top:'Most listened',hearts:'Most hearted',stars:'Most starred',likes:'Most liked',dislikes:'Most disliked'};
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
  return `<div class="ranking-card" data-tile-card="${safe(type)}"><div class="chart-head"><h3>Top ${safe(type)}</h3>${tileControls(type)}</div>${rows?.length?rows.map((r,i)=>{
    const target=type==='artists'?'#artist/'+encodeURIComponent(r.name):
      type==='albums'?'#album/'+encodeURIComponent(r.artist||'')+'/'+encodeURIComponent(r.name):'';
    return `<button class="rank-row" type="button" ${target?`data-href="${safe(target)}"`:'data-noaction="true"'}>
      <span class="position">${i+1}</span>${cover(artUrl(r,type),r.name,r.origin_id)}<span class="song-info"><b>${safe(r.name)}</b><small>${safe(type==='artists'?'Artist':r.artist||noun)}</small></span>
      <span class="count">${n(r.plays)}</span></button>`;
  }).join(''):'<p class="message">No confirmed listens yet.</p>'}</div>`;
}
function dateLabel(v){return /^\d{4}-\d{2}$/.test(v)?v.slice(5)+'/'+v.slice(2,4):v.slice(-5);}
function bars(rows,weekly=false){
  const values=weekly?Array.from({length:7},(_,i)=>({label:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][i],plays:Number(rows.find(x=>Number(x.weekday)===i)?.plays)||0})):
    rows.map(x=>({label:x.label,plays:Number(x.plays)||0}));
  const max=Math.max(1,...values.map(x=>x.plays));
  return `<div class="chart" role="img" aria-label="Listening activity bars">${values.length?values.map(v=>`<div class="bar-slot" tabindex="0" data-tip="${safe(v.label)}: ${n(v.plays)} confirmed plays"><i class="bar" style="height:${100*v.plays/max}%"></i><small>${safe(dateLabel(v.label))}</small></div>`).join(''):'<p class="message">No recorded activity for this period.</p>'}</div>`;
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
    const points=labels.length===1?[[W/2-28,upper[0]],[W/2+28,upper[0]],[W/2+28,lower[0]],[W/2-28,lower[0]]]:upper.map((y,i)=>[xpos(i),y]).concat(lower.map((y,i)=>[xpos(i),y]).reverse());
    const d=points.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')+' Z';
    const peak=t.periods?.reduce((a,b)=>Number(b.plays)>Number(a?.plays||0)?b:a,null);
    const tip=`${t.name}: ${n(t.plays)} tagged plays${peak?' · Peak '+peak.label+': '+n(peak.plays):''}`;
    return `<path class="genre-layer" tabindex="0" role="img" data-genre="${safe(t.name)}" data-tip="${safe(tip)}" d="${d}" fill="${t.color}" />`;
  }).join('');
  const ticks=labels.filter((_,i)=>i===labels.length-1||i%Math.max(1,Math.ceil(labels.length/12))===0);
  const tickLabels=ticks.map(label=>{const i=labels.indexOf(label);return `<text x="${xpos(i)}" y="216" text-anchor="middle" fill="#aaa299" font-size="11">${safe(dateLabel(label))}</text>`;}).join('');
  return `<div class="stream-wrap"><svg class="genre-chart" viewBox="0 0 640 230" aria-label="Genre listening activity over time" role="group">
     <line x1="18" y1="100" x2="622" y2="100" stroke="#55534d" stroke-dasharray="2,4" opacity=".45" />
     ${layers}${tickLabels}</svg><div class="tag-legend">${rows.map(t=>`<button type="button" class="tag-key" data-genre="${safe(t.name)}" data-tip="${safe(t.name)}: ${n(t.plays)} tagged plays"><i style="background:${t.color}"></i><span>${safe(t.name)}</span><b>${n(t.plays)}</b></button>`).join('')}</div>
     <p class="note">Tags can overlap: a play may count toward more than one genre. Labels come from available artist or track metadata.</p></div>`;
}
function chartAlbum(row,label){
  return `<div class="chart-detail-label">${safe(label)}</div>${row?.topAlbum?`<button type="button" class="chart-detail-item" data-href="#album/${safe(encodeURIComponent(row.topArtist||''))}/${safe(encodeURIComponent(row.topAlbum))}">${cover(artUrl({name:row.topAlbum,artist:row.topArtist},'albums'),row.topAlbum,row.topAlbumOrigin)}<span><b>${safe(row.topAlbum)}</b><small>${safe(row.topArtist||'Unknown artist')}${row.topAlbumPlays?' · '+n(row.topAlbumPlays)+' plays':''}</small></span></button>`:'<p class="muted">No confirmed album for this selection.</p>'}`;
}
function countryDetail(row,name){
  if(!row?.topArtist)return `<div class="chart-detail-label">${safe(name)}</div><p class="muted">No confirmed artist data for this country.</p>`;
  return `<div class="chart-detail-label">Top artist · ${safe(name)}</div><button type="button" class="chart-detail-item" data-href="#artist/${safe(encodeURIComponent(row.topArtist))}">${cover(artUrl({name:row.topArtist},'artists'),row.topArtist,row.topArtistOrigin)}<span><b>${safe(row.topArtist)}</b><small>${n(row.topArtistPlays)} plays</small></span></button>${chartAlbum(row,'Top album by this artist')}`;
}
let decadeSelections=new Map(),countrySelections=new Map(),selectedDecade="",selectedCountry="";
function setChartSelection(kind,key){
  const choices=kind==='decade'?decadeSelections:countrySelections,entry=choices.get(String(key));if(!entry)return;
  if(kind==='decade')selectedDecade=String(key);else selectedCountry=String(key);
  const target=root.querySelector(kind==='decade'?'#decadeDetail':'#countryDetail');if(!target)return;
  root.querySelectorAll(`[data-chart-${kind}]`).forEach(el=>{const active=el.getAttribute('data-chart-'+kind)===String(key);el.classList.toggle('selected',active);el.setAttribute('aria-pressed',String(active));});
  target.innerHTML=kind==='decade'?chartAlbum(entry.row,'Top album · '+entry.label):countryDetail(entry.row,entry.label);
  resized();
}
function decadesChart(rows,total,yearMetadataPlays){
  const raw=rows||[];decadeSelections=new Map();
  if(!raw.length)return `<p class="message">No verified release-year metadata yet. Enable metadata enrichment in Admin → Network → Telemetry. Unknown years are never estimated.</p>`;
  const early=raw.filter(r=>Number(r.decade)<1960),earlyTop=[...early].sort((a,b)=>Number(b.topAlbumPlays||b.plays)-Number(a.topAlbumPlays||a.plays))[0];
  const decades=[{...earlyTop,decade:1950,plays:early.reduce((n,r)=>n+Number(r.plays||0),0)},...Array.from({length:Math.max(7,Math.floor(new Date().getFullYear()/10)-195)},(_,i)=>raw.find(r=>Number(r.decade)===1960+i*10)||{decade:1960+i*10,plays:0})];
  const max=Math.max(1,...decades.map(r=>Number(r.plays)||0)),best=decades.find(r=>String(r.decade)===selectedDecade)||[...decades].sort((a,b)=>Number(b.plays)-Number(a.plays))[0];
  const bars=decades.map(r=>{
    const d=Number(r.decade),label=d<1960?'Pre-1960':`${d}s`,plays=Number(r.plays)||0,pct=total?100*plays/total:0,selected=r===best;
    decadeSelections.set(String(d),{row:r,label});
    return `<button type="button" class="decade-row${selected?' selected':''}" data-chart-decade="${d}" aria-pressed="${selected}" data-tip="${safe(`${label}: ${n(plays)} confirmed plays (${pct.toFixed(1)}%)${r.topAlbum?` · Top album: ${r.topAlbum} · ${r.topArtist}`:''}`)}"><span>${safe(label)}</span><span class="decade-track"><span class="decade-fill" style="width:${Math.max(0,100*plays/max)}%"></span></span><b>${n(plays)}</b><small>${pct.toFixed(1)}%</small></button>`;
  }).join('');
  return `<div class="decades-chart">${bars}<div id="decadeDetail" class="chart-detail" aria-live="polite">${chartAlbum(best,'Top album · '+(best.decade<1960?'Pre-1960':best.decade+'s'))}</div><p class="note">${n(yearMetadataPlays)} of ${n(total)} plays have verified release-year metadata. Unknown years are excluded.</p></div>`;
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
    countrySelections=new Map();
    const paths=shapes.map(c=>{
      const row=countriesMap.get(c.code),plays=Number(row?.plays)||0;
      const strength=plays>0?.2+.8*Math.sqrt(plays/max):0;
      const fill=plays>0?`rgba(200,241,105,${strength.toFixed(3)})`:'#343735';
      countrySelections.set(String(c.code),{row,label:c.name});
      return `<path class="map-country${plays?' active':''}" tabindex="0" role="button" aria-pressed="false" data-chart-country="${safe(c.code)}" data-tip="${safe(c.name+': '+n(plays)+' confirmed plays'+(row?' · '+n(row.artists)+' artists':''))}" aria-label="${safe(c.name+': '+n(plays)+' plays')}" d="${safe(c.d)}" fill="${fill}"/>`;
    }).join('');
    target.innerHTML=`<svg viewBox="0 0 900 435" role="group" aria-label="Listening activity by verified artist origin country">${paths}</svg>`;
    const best=[...countriesMap.values()].filter(r=>countrySelections.has(String(r.code))).sort((a,b)=>b.plays-a.plays)[0];
    if(selectedCountry&&countrySelections.has(selectedCountry))setChartSelection('country',selectedCountry);else if(best)setChartSelection('country',best.code);
    resized();
  }catch {worldPromise=null;if(target.isConnected)target.textContent='Map data unavailable.';}
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
const tileNames=['history','clock','artists','albums','tracks','weekdays','fingerprint','genres','decades'];
const periods=[['week','Week'],['month','Month'],['year','Year'],['all','All time']];
let overrides={},summaryMemo=new Map();
function tileControls(id){const current=overrides[id]||state.period;return `<div class="tile-filters" role="group" aria-label="${id} date range">${periods.map(([v,l])=>`<button type="button" data-tile="${id}" data-tile-period="${v}" class="chip${v===current?' active':''}" aria-pressed="${v===current}">${l}</button>`).join('')}</div>`;}
function getSummary(period,force=false){const params=new URLSearchParams({scope:state.scope,period,year:String(state.year),month:'all',offset:String(-new Date().getTimezoneOffset())});if(period==='week'||period==='month')params.set('start',state.start);const key=params.toString();const old=summaryMemo.get(key);if(!force&&old&&old.until>Date.now())return old.promise;const promise=fetch('/api/telemetry?'+key,{cache:'no-store'}).then(async response=>{const data=await response.json();if(!response.ok)throw Error(data.error||'Statistics are temporarily unavailable');const current=summaryMemo.get(key);if(current?.promise===promise)current.until=Date.now()+Math.max(60000,Number(data.refreshMs)||300000);return data;}).catch(e=>{if(summaryMemo.get(key)?.promise===promise)summaryMemo.delete(key);throw e;});summaryMemo.set(key,{promise,until:Date.now()+60000});if(summaryMemo.size>24)summaryMemo.delete(summaryMemo.keys().next().value);return promise;}
function controls(){return `<div class="controls" role="group" aria-label="Telemetry date filters">
  <div class="switches">${[['week','Week'],['month','Month'],['year','Year'],['all','All time']].map(([v,l])=>`<button type="button" data-period="${v}" class="chip${state.period===v?' active':''}" aria-pressed="${state.period===v}">${l}</button>`).join('')}</div>
  <label class="control">Year<select id="year">${Array.from({length:12},(_,i)=>new Date().getFullYear()-i).map(y=>`<option value="${y}" ${state.year===y?'selected':''}>${y}</option>`).join('')}</select></label>

  <label class="control">Listening scope<select id="scope"><option value="hive" ${state.scope==='hive'?'selected':''}>Entire HIVE</option><option value="local" ${state.scope==='local'?'selected':''}>This server</option></select></label>
  <button type="button" class="chip" data-refresh-telemetry>Refresh telemetry</button><div class="period-nav"><button type="button" data-step="-1" title="Previous period" aria-label="Previous period">‹</button><button type="button" data-step="1" title="Next period" aria-label="Next period">›</button></div>
  </div>`;}
// A card change updates just that card. Other cards, the map, player, and
// global totals stay mounted and keep their current range.
const tileVersions=new Map();
async function changeTile(id,period){
 if(!tileNames.includes(id)||!periods.some(([v])=>v===period))return;
 const card=root.querySelector(`[data-tile-card="${id}"]`);if(!card)return;
 const version=(tileVersions.get(id)||0)+1;tileVersions.set(id,version);const globalRequest=state.request;
 card.setAttribute('aria-busy','true');
 try{const d=await getSummary(period);if(state.request!==globalRequest||tileVersions.get(id)!==version||!card.isConnected)return;
 overrides[id]=period;
 if(['artists','albums','tracks'].includes(id)){card.outerHTML=rankList(d['top'+id[0].toUpperCase()+id.slice(1)],id);}
 else{const f=card.querySelector('.tile-filters');if(f)f.outerHTML=tileControls(id);
 const el=card.querySelector('.tile-body');if(id==='history'){el.innerHTML=bars(d.series||[]);const label=card.querySelector('.chart-head small');if(label)label.textContent=['year','all'].includes(period)?'By month':'By day';}
 if(id==='clock')el.innerHTML=hourChart(d.hours||[]);
 if(id==='weekdays')el.innerHTML=bars(d.weekdays||[],true);
 if(id==='fingerprint')el.innerHTML=fingerprint(d);
 if(id==='genres')el.innerHTML=tagStream(d.topTags||[],d.series||[]);
 if(id==='decades')el.innerHTML=decadesChart(d.decades||[],Number(d.plays)||0,Number(d.yearMetadataPlays)||0);
 card.querySelector('.tile-error')?.remove();}
 resized();
 }catch(e){if(state.request===globalRequest&&tileVersions.get(id)===version&&card.isConnected){let err=card.querySelector('.tile-error');if(!err){err=document.createElement('p');err.className='note tile-error';card.append(err);}err.textContent='Could not load this range. Previous statistics retained.';}}
 finally{if(tileVersions.get(id)===version&&card.isConnected)card.removeAttribute('aria-busy');}
}
function syncLabel(data){return data.lastSynced?'Synced '+new Date(data.lastSynced).toLocaleString():'Local cache · peer sync pending';}
let telemetryRefreshAt=0,telemetryBusy=false;
async function showHive({quiet=false,keep=false}={}){
  if(quiet&&(telemetryBusy||root.querySelector('[aria-busy="true"]')))return;
  const request=++state.request;telemetryBusy=true;
  if(!quiet&&!keep)root.innerHTML=`<div class="heading"><div><span class="eyebrow">WASP · NETWORK LISTENING</span><h1>HIVE Telemetry</h1><p>ONE HIVE. EVERY BEAT.</p></div><span class="status">Loading historical data…</span></div>${controls()}<p class="loading">Reading cached telemetry…</p>`;
  resized();
  try{
    if(quiet)summaryMemo.clear();
    const requested=[...new Set([state.period,...Object.values(overrides)])];const reports=new Map(await Promise.all(requested.map(async p=>[p,await getSummary(p)])));
    if(request!==state.request)return;
    const data=reports.get(state.period),tile=id=>reports.get(overrides[id]||state.period)||data;
    artOrigins=Array.isArray(data.artworkOrigins)?data.artworkOrigins:[];
    telemetryRefreshAt=Date.now()+Math.max(60000,Number(data.refreshMs)||300000);
    const growth=data.previousPlays>0?`${Math.round((data.plays-data.previousPlays)*100/data.previousPlays)}% vs previous period`:'No comparable previous period';
    root.innerHTML=`<div class="heading"><div><span class="eyebrow">WASP · NETWORK LISTENING</span><h1>HIVE Telemetry</h1><p>ONE HIVE. EVERY BEAT.</p></div><span class="status">${safe(syncLabel(data))}${data.generatedAt?` · Updated ${safe(new Date(data.generatedAt).toLocaleTimeString())}`:''}</span></div>
      ${controls()}
      <div class="metric-grid">${metric('Confirmed plays',data.plays,growth)}${metric('Unique artists',data.artists)}${metric('Unique albums',data.albums)}${metric('Unique tracks',data.tracks)}</div>
      <div class="two-col section"><div class="panel" data-tile-card="history"><div class="chart-head"><h2>Listening history</h2>${tileControls('history')}<small>${safe(['year','all'].includes(overrides.history||state.period)?'By month':'By day')}</small></div><div class="tile-body">${bars(tile('history').series||[])}</div></div>
      <div class="panel" data-tile-card="clock"><div class="chart-head"><h2>Listening clock</h2>${tileControls('clock')}<small>By hour · your timezone</small></div><div class="tile-body">${hourChart(tile('clock').hours||[])}</div></div></div>
      <div class="section"><h2>Most played music</h2><div class="three-col">${rankList(tile('artists').topArtists,'artists')}${rankList(tile('albums').topAlbums,'albums')}${rankList(tile('tracks').topTracks,'tracks')}</div></div>
      <div class="two-col section"><div class="panel" data-tile-card="weekdays"><h2>Days of the week</h2>${tileControls('weekdays')}<div class="tile-body">${bars(tile('weekdays').weekdays||[],true)}</div></div>
      <div class="info-card"><h3>Across the HIVE</h3><p><b>${n(data.nodes)}</b> contributing origin servers in this period.</p>
      <p><b>${n(data.connectedCaches)}</b> peer cursors synchronized to this server.</p><p>Each server keeps its own cached copy. Events carry unique origin identifiers so relayed plays can be counted once.</p></div></div>
      <div class="section"><h2>Listening fingerprint & quick facts</h2><div class="two-col">
        <div class="panel" data-tile-card="fingerprint"><div class="chart-head"><h2>Music fingerprint</h2>${tileControls('fingerprint')}<small>Recorded activity, not personal profiling</small></div>
          <div class="tile-body fingerprint">${fingerprint(tile('fingerprint'))}</div>
          <p class="note">Repeat rate: replayed tracks / total plays. Concentration: top artist's share. Consistency: active days / days in range.</p></div>
        <div class="panel"><div class="fact-grid">
          <div><span>Longest recorded streak</span><b>${n(data.longestStreak)} days</b></div>
          <div><span>Most active day</span><b>${safe(data.mostActiveDay||'—')}</b><small>${n(data.mostActiveDayPlays)} plays</small></div>
          <div><span>Busiest listening hour</span><b>${data.busiestHour==null?'—':String(data.busiestHour).padStart(2,'0')+':00'}</b><small>${n(data.busiestHourPlays)} plays</small></div>
          <div><span>Active days in selected period</span><b>${n(data.activeDays)}</b></div>
        </div></div></div></div>
      <div class="section"><div class="panel" data-tile-card="genres"><div class="chart-head"><h2>Top tags · genre trends</h2>${tileControls('genres')}<small>Hover to highlight a genre</small></div><div class="tile-body">${tagStream(tile('genres').topTags||[],tile('genres').series||[])}</div></div></div>
      <div class="two-col section"><div class="panel"><div class="chart-head"><h2>Artist origin heat map</h2><small>Verified country metadata only</small></div>
        <div id="worldMap" class="world-map"><p class="message">Preparing country map…</p></div><div id="countryDetail" class="chart-detail" aria-live="polite">Select a country to see its top artist and album.</div>
        <div class="world-legend"><span>Lower activity</span><i></i><strong>Higher activity</strong></div>
        <p class="note">${n(data.unknownCountryPlays)} plays have unknown artist origin. Artist geography is not inferred from IP addresses or user locations.</p>
      </div><div class="panel" data-tile-card="decades"><div class="chart-head"><h2>Music by decade</h2>${tileControls('decades')}<small>Album / track release years</small></div>
        <div class="tile-body">${decadesChart(tile('decades').decades||[],Number(tile('decades').plays)||0,Number(tile('decades').yearMetadataPlays)||0)}</div></div></div>
      <div class="info-card section"><h3>Listening privacy</h3><p>The HIVE view shows aggregate activity. Personal listening profiles and named-user leaderboards are not shared with peers.</p></div>
      <p class="history-note">${safe(data.historicalCoverage)} Figures represent confirmed WASP play events, not audio bytes transferred or the length of entire songs. Metadata sources include embedded audio tags and <a href="https://musicbrainz.org" target="_blank" rel="noopener">MusicBrainz</a>, <a href="https://www.wikidata.org" target="_blank" rel="noopener">Wikidata</a> and <a href="https://www.last.fm" target="_blank" rel="noopener">Last.fm</a>.</p>`;
    void mountWorldMap(request,data.countries||[],data.unknownCountryPlays||0);
  }catch(e){if(request!==state.request)return;telemetryRefreshAt=Date.now()+300000;if(quiet){const status=root.querySelector('.status');if(status)status.textContent='Refresh failed; showing previous statistics.';}else if(request===state.request)root.innerHTML=`<div class="heading"><div><span class="eyebrow">WASP HIVE</span><h1>Telemetry</h1></div></div>${controls()}<p class="message">${safe(e.message)}</p>`;}
  finally{if(request===state.request)telemetryBusy=false;}
  resized();
}
function showRanking(){
  ++state.request;telemetryBusy=false;
  const rankable=['stars','hearts'].includes(state.mode);
  const sorted=[...state.items].sort((a,b)=>{
    const av=Number(a.score)||0,bv=Number(b.score)||0;
    return (state.rankingSort==='least'?av-bv:bv-av)||String(a.title||'').localeCompare(String(b.title||''));
  });
  const rows=rankable?sorted:state.items;
  const header=(state.mode==='top'?names.top:names[state.mode]||'Rankings')+(state.mode==='top'?'':` · ${state.sub}`);
  const sortLabel=state.mode==='stars'?'stars':'hearts';
  root.innerHTML=`<div class="heading"><div><span class="eyebrow">WASP · MUSIC RANKINGS</span><h1>${safe(header)}</h1><p>${state.mode==='top'?'Most listened tracks available on this server and its connected peers.':state.mode==='stars'?'Ranked by total stars given on this WASP server. Average rating and number of votes appear on each item.':'Reactions recorded for local and available peer music.'}</p></div>
    ${rankable?`<label class="ranking-sort-label" for="rankingSort">Sort by<select id="rankingSort" aria-label="Sort ${sortLabel} ranking"><option value="most" ${state.rankingSort==='most'?'selected':''}>Most ${sortLabel}</option><option value="least" ${state.rankingSort==='least'?'selected':''}>Least ${sortLabel}</option></select></label>`:''}</div>
    ${rows.length?`<div class="browse-grid">${rows.map((r,i)=>`<button type="button" class="browse-tile" data-kind="${safe(r.kind)}" data-id="${safe(r.id)}"><span class="picture">${r.cover?`<img loading="lazy" src="${safe(r.cover)}" alt="" onerror="this.style.display='none'">`:''}</span><b>${safe(r.title)}</b><small>${safe(r.subtitle||'')}</small><small>${state.mode==='stars'?`★ ${n(r.score)} stars · ${Number(r.average||0).toFixed(1)}/5 · ${n(r.votes)} vote${Number(r.votes)===1?'':'s'}`:n(r.score)+' '+safe(r.scoreLabel||'votes')}</small></button>`).join('')}</div>`:
      '<p class="message">Nothing here yet. Results appear when songs are played or rated.</p>'}`;
  resized();
}

function resized(){requestAnimationFrame(()=>tell('wasp:telemetry-height',{height:Math.ceil(document.body.scrollHeight)}));}
function movePeriod(delta){
  if(state.period==='all')return;
  if(state.period==='week'||state.period==='month'){const d=new Date(state.start+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+delta*(state.period==='week'?7:30));state.start=d.toISOString().slice(0,10);}
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
  const decade=active?.dataset.chartDecade;if(decade&&active.getAttribute('aria-pressed')!=='true')setChartSelection('decade',decade);
  updateTagFocus(active);
  showTooltip(e,active?.dataset.tip||'');
});
root.addEventListener('pointerleave',()=>{showTooltip(null,'');updateTagFocus(null);});
root.addEventListener('focusin',e=>{
  const active=e.target.closest?.('[data-tip]');updateTagFocus(active);
  if(active?.dataset.chartDecade&&active.getAttribute('aria-pressed')!=='true')setChartSelection('decade',active.dataset.chartDecade);
  if(active){const r=active.getBoundingClientRect();showTooltip({clientX:r.left+r.width/2,clientY:r.top},active.dataset.tip);}
});
root.addEventListener('focusout',()=>{showTooltip(null,'');updateTagFocus(null);});
root.addEventListener('change',e=>{
  if(e.target.id==='rankingSort'){state.rankingSort=e.target.value==='least'?'least':'most';showRanking();tell('wasp:telemetry-rank-sort',{sort:state.rankingSort});return;}
  if(e.target.id==='year')state.year=int(e.target.value,2000,2100);
  else if(e.target.id==='month')state.month=int(e.target.value,1,12);
  else if(e.target.id==='scope')state.scope=e.target.value==='local'?'local':'hive';
  else return;
  if(state.mode==='top'&&state.sub==='telemetry')void showHive();
});
root.addEventListener('keydown',e=>{const c=e.target.closest?.('[data-chart-country]');if(c&&['Enter',' '].includes(e.key)){e.preventDefault();setChartSelection('country',c.dataset.chartCountry);}});
root.addEventListener('click',e=>{
  if(e.target.closest('[data-refresh-telemetry]')){void showHive({quiet:true});return;}
  const c=e.target.closest('[data-chart-country]');if(c){setChartSelection('country',c.dataset.chartCountry);return;}
  const d=e.target.closest('[data-chart-decade]');if(d){setChartSelection('decade',d.dataset.chartDecade);return;}
  const tile=e.target.closest('[data-tile-period]');if(tile){void changeTile(tile.dataset.tile,tile.dataset.tilePeriod);return;}
  const period=e.target.closest('[data-period]');if(period){state.period=period.dataset.period;overrides={};state.start=localToday();void showHive();return;}
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
  const wasTelemetry=state.mode==='top'&&state.sub==='telemetry';
  const nextMode=['top','hearts','stars','likes','dislikes'].includes(data.mode)?data.mode:'top';
  if(state.mode!==nextMode||state.sub!==data.sub)state.rankingSort='most';
  state.mode=nextMode;
  state.sub=typeof data.sub==='string'?data.sub:'ranked';
  state.items=Array.isArray(data.items)?data.items.slice(0,100):[];
  state.query=String(data.query||'');
  if(state.mode==='top'&&state.sub==='telemetry'){if(!wasTelemetry||!state.opened){state.period='week';state.start=localToday();state.year=new Date().getFullYear();overrides={};state.opened=true;}void showHive();}else{state.opened=false;showRanking();}
});
const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(resized):null;
if(observer)observer.observe(root);
window.addEventListener('load',()=>{tell('wasp:telemetry-ready');resized();});
window.addEventListener('pageshow',()=>{tell('wasp:telemetry-ready');resized();});

setInterval(()=>{if(state.mode==='top'&&state.sub==='telemetry'&&!document.hidden&&telemetryRefreshAt&&Date.now()>=telemetryRefreshAt)void showHive({quiet:true});},15000);
