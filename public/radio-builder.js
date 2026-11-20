// Radio and playlist suggestions use catalogue metadata only. No audio or
// playlist data is changed unless a member explicitly saves a selection.
export const normal = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const artistNames = track => Array.isArray(track?.artists) && track.artists.length ? track.artists : [track?.artist || ''];
export const trackYear = t => {const y=Number(t?.release_year || t?.year || 0); return Number.isInteger(y)&&y>=1850&&y<=new Date().getFullYear()+1?y:0;};
export const trackGenres = (t, known={}) => {
  const raw=[t?.genre, ...(Array.isArray(t?.genres)?t.genres:[])];
  artistNames(t).forEach(a=>raw.push(...(known[a]||[])));
  return [...new Set(raw.flatMap(g=>String(g||'').split(/[,;|]/)).map(x=>x.trim()).filter(Boolean))];
};
const tokens = s=>new Set(normal(s).split(' ').filter(Boolean));
function similarity(a,b){const A=tokens(a),B=tokens(b);if(!A.size||!B.size)return 0;let both=0;for(const w of A)if(B.has(w))both++;return 2*both/(A.size+B.size);}
const protectedVersion = name => (normal(name).match(/\b(live|remix|remaster|acoustic|instrumental|demo|karaoke|radio edit|sped up|slowed)\b/g)||[]).sort().join(' ');
const baseTitle = title => String(title||'').replace(/\s*[([]\s*(?:feat\.?|ft\.?|featuring)\b[^)\]]*[)\]]/ig,'').replace(/\b(feat\.?|ft\.?|featuring)\s+.+$/i,'').trim();
export function duplicateCandidates(ids, byId){
 const groups=[];const used=new Set();
 for(let i=0;i<ids.length;i++){
   if(used.has(i))continue;
   const t=byId[ids[i]];if(!t?.title)continue;
   const group=[i],artists=artistNames(t).map(normal).filter(Boolean),version=protectedVersion(t.title);
   for(let j=i+1;j<ids.length;j++){
     const u=byId[ids[j]];if(!u?.title)continue;
     const their=artistNames(u).map(normal).filter(Boolean);
     if(!artists.some(a=>their.includes(a)))continue;
     // Different live, demo or remix editions remain separate unless the title is identical.
     if(protectedVersion(u.title)!==version)continue;
     const titleScore=similarity(baseTitle(t.title),baseTitle(u.title));
     if(titleScore<.87)continue;
     // Two distinct releases of similar names are suggestions, never auto-removals.
     group.push(j);used.add(j);
   }
   if(group.length>1){groups.push(group);used.add(i);}
 }
 return groups;
}
export function artistSearchTokens(input){return [...new Set(String(input||'').split(',').map(s=>s.trim()).filter(Boolean))];}
const randomShuffle = (rows,rnd=Math.random)=>{const a=[...rows];for(let i=a.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
const genreRelated = (a,b) => {
 const A=a.map(normal),B=b.map(normal);if(!A.length||!B.length)return false;
 if(A.some(g=>B.includes(g)))return true;
 // Related genres must share a meaningful tag component, not generic 'music'.
 const common=new Set(A.flatMap(g=>g.split(' ')).filter(w=>w.length>3&&!['music','rock','indie'].includes(w)));
 return B.some(g=>g.split(' ').some(w=>common.has(w)));
};
export function createRadioSelection({tracks=[],mode='decade',decade=1980,artist='',selectedGenres=[],knownGenres={},similarArtists=[],topTracks=[],count=20,rnd=Math.random}={}) {
 const desired=Math.min(100,Math.max(1,Math.floor(Number(count)||20)));
 const playable=tracks.filter(t=>t&&t.id&&!t.peer_offline);
 let eligible=[];
 if(mode==='decade')eligible=playable.filter(t=>{const y=trackYear(t);return y>0&&(decade==='pre'?y<1960:Math.floor(y/10)*10===Number(decade));});
 if(mode==='genre'){
   const selected=selectedGenres.map(normal).filter(Boolean);
   eligible=playable.filter(t=>trackGenres(t,knownGenres).some(g=>selected.includes(normal(g))));
 }
 if(mode==='artist'){
   const key=normal(artist),close=new Set(similarArtists.map(normal).filter(Boolean));
   const seedGenres=Object.entries(knownGenres).filter(([a])=>normal(a)===key).flatMap(([,g])=>g);
   const direct=playable.filter(t=>artistNames(t).some(a=>normal(a)===key));
   const others=playable.filter(t=>!direct.includes(t)&&artistNames(t).some(a=>close.has(normal(a))||genreRelated(seedGenres,knownGenres[a]||[])));
   eligible=[...randomShuffle(direct,rnd),...randomShuffle(others,rnd)];
 }
 if(mode==='top'){
   const indexed=new Map();for(const t of playable){const k=normal(t.title)+'|'+normal(artistNames(t)[0]);if(!indexed.has(k))indexed.set(k,t);}
   eligible=topTracks.map(r=>{const name=normal(r.name||r.title),artist=normal(r.artist);return indexed.get(name+'|'+artist)||playable.find(t=>normal(t.title)===name&&artistNames(t).some(a=>{const k=normal(a);return k===artist||(k.length>2&&artist.includes(k));}));}).filter(Boolean);
 }
 const unique=[...new Map(eligible.map(t=>[t.id,t])).values()];
 const chosen=mode==='artist'||mode==='top'?unique.slice(0,desired):randomShuffle(unique,rnd).slice(0,desired);
 return {ids:chosen.map(t=>t.id),requested:desired,available:unique.length,limited:unique.length<desired};
}
