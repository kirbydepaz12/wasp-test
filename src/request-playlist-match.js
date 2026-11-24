// v18.0.7: transparent, review-only song suggestions for Spotify requests.
// Title similarity never authorizes an automatic replacement. Administrators
// explicitly choose a source; the API verifies that source still exists.
const norm = s => String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
  .replace(/&/g,' and ').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim();
export const requestSongKey = song => norm(song?.t)+'|'+norm(song?.a);
function trimEdition(s){return norm(String(s||'').replace(/\s*\((?:feat\.?|ft\.?|with|from|remaster|live|bonus|single|edit|version|radio|explicit|instrumental)[^)]*\)/gi,'').replace(/\s*\[(?:feat\.?|ft\.?|from|remaster|live|bonus|single|edit|version|radio)[^\]]*\]/gi,''));}
const tokenSimilarity=(a,b)=>{const aa=new Set(a.split(' ').filter(Boolean)),bb=new Set(b.split(' ').filter(Boolean));if(!aa.size||!bb.size)return 0;let c=0;for(const t of aa)if(bb.has(t))c++;return (2*c)/(aa.size+bb.size);};
function artists(row){const value=row?.artists;let a=[];if(Array.isArray(value))a=value;else if(typeof value==='string')try{const p=JSON.parse(value);if(Array.isArray(p))a=p;}catch{};if(row?.artist)a.push(row.artist);return a.flatMap(v=>String(v||'').split(/\s*(?:,|;|\bfeat\.?\b|\bft\.?\b|\band\b|&)\s*/i)).map(norm).filter(Boolean);}
export function scoreRequestCandidate(song,row){
 const a=trimEdition(song?.t),b=trimEdition(row?.title);if(!a||!b)return 0;
 let title=a===b?1:tokenSimilarity(a,b);
 if(a!==b&&(a.includes(b)||b.includes(a))&&Math.min(a.length,b.length)>=6)title=Math.max(title,.78);
 const ra=artists(row),wanted=norm(song?.a),wantPieces=wanted.split(/\s*(?:,|;|\bfeat\.?\b|\band\b|&)\s*/i).filter(Boolean);
 const artist=ra.some(x=>x===wanted||wantPieces.includes(x)||wanted.includes(x)&&x.length>=5)?1:ra.some(x=>tokenSimilarity(x,wanted)>.5)?0.6:0;
 return Math.round(title*75+artist*25);
}
export function suggestRequestCandidates(song,catalogue,{query='',rejected=[],limit=8}={}){
 const rejectedSet=new Set(rejected);const q=norm(query);
 const rows=[...(catalogue?.local||[]),...(catalogue?.remote||[])];
 const seen=new Set();const scored=[];
 for(const row of rows){if(!row?.id||!row.title)continue;
   const origin=String(row.origin||''),id=String(row.remote_id||row.id);const key=origin+'|'+id;
   if(seen.has(key)||rejectedSet.has(key))continue;seen.add(key);
   const score=scoreRequestCandidate(song,row);
   const hay=norm(row.title+' '+row.artist+' '+row.album);
   if(q ? !hay.includes(q) : score<45)continue;
   scored.push({origin,id,title:row.title,artist:row.artist,album:row.album||'',score});
 }
 const max=Math.max(1,Math.min(20,limit));
 const sorted=scored.sort((a,b)=>b.score-a.score||(a.origin?1:-1));
 if(sorted.length<=max || max<2)return sorted.slice(0,max);
 // A very large local library must not push every peer candidate out of the
 // review window (nor should many peers hide the local candidates). Reserve
 // some positions for each source when both have plausible results.
 const local=sorted.filter(x=>!x.origin),peers=sorted.filter(x=>x.origin);
 if(!local.length||!peers.length)return sorted.slice(0,max);
 const minEach=Math.min(3,Math.floor(max/2));
 const keep=[...local.slice(0,minEach),...peers.slice(0,minEach)];
 const ids=new Set(keep.map(x=>x.origin+'|'+x.id));
 for(const candidate of sorted){if(keep.length>=max)break;
   if(!ids.has(candidate.origin+'|'+candidate.id)){keep.push(candidate);ids.add(candidate.origin+'|'+candidate.id);}
 }
 return keep.sort((a,b)=>b.score-a.score||(a.origin?1:-1));
}
export function safeManualMatches(meta){const out={};for(const [index,selection] of Object.entries(meta?.manual_matches||{})){
 if(!/^\d{1,4}$/.test(index)||!selection||typeof selection!=='object')continue;
 if(typeof selection.id!=='string'||selection.id.length>110||typeof selection.origin!=='string'||selection.origin.length>300)continue;
 if(Number(index)>=0&&Number(index)<(meta?.tracks?.length||0))out[index]=selection;
 }return out;}

// Album requests are not song requests: suggest album *groups* represented by
// existing local/peer catalogue tracks. A single track never proves that an
// entire album is present; a confirmed group remains pending admin review.
export function suggestAlbumCandidates(wanted,catalogue,{query='',rejected=[],limit=12}={}){
 const q=norm(query),target=norm(wanted?.t),artist=norm(wanted?.a);
 const groups=new Map();
 for(const row of [...(catalogue?.local||[]),...(catalogue?.remote||[])]){
  const album=String(row?.album||'').trim(),origin=String(row?.origin||'');
  if(!album||!row?.id)continue;
  const key=origin+'|'+norm(album);
  if(rejected.includes(key))continue;
  const hay=norm(album+' '+(row.artist||'')+' '+(row.title||''));
  if(q&&!hay.includes(q))continue;
  const albumKey=norm(album);
  let titleScore=albumKey===target?100:Math.round(tokenSimilarity(albumKey,target)*85);
  if(albumKey.includes(target)&&target.length>=6)titleScore=Math.max(titleScore,75);
  const artistMatches=artist&&(artists(row).some(v=>v===artist||v.includes(artist)||artist.includes(v))||norm(row.artist||'')===artist);
  let score=Math.min(100,Math.round(titleScore*.85+(artistMatches?15:0)));
  if(!q&&score<45)continue;
  const old=groups.get(key);
  if(old){old.track_count++;old.score=Math.max(old.score,score);if(artistMatches)old.artist=row.artist||old.artist;}
  else groups.set(key,{origin,album,title:album,artist:String(row.artist||''),score,track_count:1});
 }
 const max=Math.max(1,Math.min(20,limit));
 const sorted=[...groups.values()].sort((a,b)=>b.score-a.score||b.track_count-a.track_count||(a.origin?1:-1));
 if(sorted.length<=max||max<2)return sorted.slice(0,max);
 const local=sorted.filter(x=>!x.origin),peer=sorted.filter(x=>x.origin);
 if(!local.length||!peer.length)return sorted.slice(0,max);
 const keep=[...local.slice(0,Math.min(3,Math.floor(max/2))),...peer.slice(0,Math.min(3,Math.floor(max/2)))];
 const seen=new Set(keep.map(x=>x.origin+'|'+norm(x.album)));
 for(const r of sorted){if(keep.length>=max)break;const k=r.origin+'|'+norm(r.album);if(!seen.has(k)){keep.push(r);seen.add(k);}}
 return keep.sort((a,b)=>b.score-a.score||b.track_count-a.track_count);
}
