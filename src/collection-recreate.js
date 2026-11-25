// v18.3: conservative matching. Ambiguous titles never auto-attach or change audio.
export const normalizeRecreate=s=>String(s||'').normalize('NFKC').toLocaleLowerCase().replace(/\([^)]*(?:feat\.?|ft\.?|live|remaster|version)[^)]*\)/gi,'').replace(/[\p{P}\p{S}\s]+/gu,' ').trim();
function artists(r){return Array.isArray(r.artists)?r.artists.join(' '):r.artist||r.a||'';}
export function recreateCandidates(item,local=[],remote=[]){
 const title=normalizeRecreate(item.title||item.t);
 const wanted=(Array.isArray(item.artists)?item.artists:Array.isArray(item.a)?item.a:String(item.artist||item.a||'').split(';')).map(normalizeRecreate).filter(Boolean);
 if(!title)return [];
 const found=[];
 for(const [group,rows] of [['local',local],['peer',remote]]){
  for(const row of rows){if(normalizeRecreate(row.title)!==title)continue;
   const credited=(Array.isArray(row.artists)?row.artists:String(row.artist||row.a||'').split(/[;]+/)).map(normalizeRecreate).filter(Boolean);
   // Whole-artist equality, not a shared word like "Artist", prevents false
   // auto-assignment of similarly named performers.
   const artistExact=wanted.some(w=>credited.includes(w));
   const duration=Number(item.duration||0),rd=Number(row.duration||0),durationOk=!duration||!rd||Math.abs(duration-rd)<5;
   found.push({source:group,origin:row.origin||'',id:String(row.remote_id||row.id),title:row.title,artist:artists(row),duration:rd,exact_artist:artistExact,duration_ok:durationOk,score:(artistExact?100:50)+(durationOk?10:0)});
  }
 }
 return found.sort((a,b)=>b.score-a.score).slice(0,20);
}
export function autoRecreateMatch(item,local,remote){
 const candidates=recreateCandidates(item,local,remote);
 // Different editions and similarly titled songs: require unique exact artist and compatible duration.
 const valid=candidates.filter(c=>c.exact_artist&&c.duration_ok);
 return {match:valid.length===1?valid[0]:null,candidates,ambiguous:valid.length>1};
}
