// Pure catalogue presentation helpers. All rankings are based on tracks that
// WASP can actually play; no external popularity figures are invented.
const yearOf = t => {const value=Number(t?.release_year || t?.year || 0);return Number.isInteger(value)&&value>=1850&&value<=new Date().getFullYear()+1?value:0;};
const norm=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const releasesType=(t,n)=>String(t?.release_type||t?.album_type||t?.release_primary_type||t?.primary_type||'').toLowerCase();
// A credited artist remains associated with a compilation even when the other
// tracks have different performers. Expand only an established, non-generic
// release; never add an unrelated "Greatest Hits" recording by title alone.
export function expandArtistAlbumTracks(artistTracks,allTracks){
  const own=new Map((artistTracks||[]).filter(t=>t?.id).map(t=>[String(t.id),t]));
  const names=new Set((artistTracks||[]).map(t=>norm(t?.album)).filter(x=>x&&
    !/^(greatest hits|the greatest hits|best of|the best of|live|unknown album|demo|singles|compilation|collection|the collection|essentials)$/.test(x)));
  for(const t of allTracks||[]){
    if(!t?.id||own.has(String(t.id)))continue;
    if(names.has(norm(t.album)))own.set(String(t.id),t);
  }
  return [...own.values()];
}
export function buildArtistDiscography(tracks) {
  const releases=new Map();
  for(const t of tracks){
    if(!t?.id)continue;
    const name=String(t.album||'').trim()||String(t.title||'').trim()||'Untitled single';
    const key=norm(name)||String(t.id);
    let item=releases.get(key);
    if(!item){item={key,name,tracks:[],year:0,created:0,type:'',coverTrack:t};releases.set(key,item);}
    if(!item.tracks.some(x=>x.id===t.id))item.tracks.push(t);
    item.year=Math.max(item.year,yearOf(t));
    item.created=Math.max(item.created,Number(t.created_at)||0);
    item.type ||= releasesType(t);
    if(!item.coverTrack?.cover_url&&t.cover_url)item.coverTrack=t;
  }
  return [...releases.values()].map(item=>{
    const tag=item.type;
    // The release type is authoritative when supplied by tags. A single track
    // from an incomplete album is NOT sufficient evidence that it is a single.
    item.kind=/(compilation)/.test(tag)?'compilation':/(ep|single)/.test(tag)?'single':/(album|lp)/.test(tag)?'album':
      /(\bep\b|\bsingle\b)/i.test(item.name)?'single':item.tracks.length===1&&norm(item.name)===norm(item.tracks[0].title)?'single':'album';
    item.tracks.sort((a,b)=>(Number(a.disc_no)||1)-(Number(b.disc_no)||1)||(Number(a.track_no)||999)-(Number(b.track_no)||999)||String(a.title).localeCompare(String(b.title)));
    return item;
  }).sort((a,b)=>b.year-a.year||b.created-a.created||a.name.localeCompare(b.name));
}
export function artistPopularTracks(tracks,limit=10){
  const sorted=[...new Map(tracks.filter(t=>t?.id).map(t=>[t.id,t])).values()].sort((a,b)=>
    (Number(b.plays)||0)-(Number(a.plays)||0)||(Number(b.created_at)||0)-(Number(a.created_at)||0)||String(a.title).localeCompare(String(b.title)));
  return {tracks:sorted.slice(0,limit),hasPlays:sorted.some(t=>Number(t.plays)>0)};
}
export function featuringArtistPlaylists(artist,playlists,trackById,artistsOf){
  const wanted=norm(artist),seen=new Set();
  return playlists.map(p=>{
    if(!p||!p.id||seen.has(p.id))return null;seen.add(p.id);
    let count=0;
    for(const entry of Array.isArray(p.tracks)?p.tracks:[]){
      const raw=typeof entry==='object'?(entry.ref||entry.track_id||entry.id):entry;
      const id=String(raw||'');
      const fromOrigin=p.origin&&!id.startsWith(p.origin+'|')?p.origin+'|'+id:id;
      const t=trackById[id]||trackById[fromOrigin];
      if(t&&artistsOf(t).some(name=>norm(name)===wanted))count++;
    }
    return count?{playlist:p,count}:null;
  }).filter(Boolean).sort((a,b)=>b.count-a.count||String(a.playlist.name).localeCompare(String(b.playlist.name)));
}
