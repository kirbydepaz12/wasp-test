// Per-tab WASP playback session. sessionStorage intentionally keeps tabs from
// overwriting one another while surviving refresh and same-tab navigation.
export const QUEUE_KEY='wasp:playback-session:v1820';
const MAX_IDS=3000;
export function makeQueueSnapshot({queue,qi,qLabel,playlistScope,ctxPl,shufKind,repeat,left,counted,position},now=Date.now()){
  if(!Array.isArray(queue)||!queue.length||qi<0||qi>=queue.length)return null;
  const ids=queue.slice(0,MAX_IDS).filter(x=>typeof x==='string'&&x.length<=512);
  const current=queue[qi];if(!ids.includes(current))return null;
  const scope=playlistScope&&typeof playlistScope.name==='string'?{
    id:String(playlistScope.id||'').slice(0,512),name:playlistScope.name.slice(0,256),
    ids:Array.isArray(playlistScope.ids)?playlistScope.ids.filter(x=>typeof x==='string').slice(0,MAX_IDS):[]
  }:null;
  return {v:1,savedAt:now,ids,current,index:qi,label:String(qLabel||'').slice(0,256),scope,
    contextId:typeof ctxPl==='string'?ctxPl.slice(0,512):typeof ctxPl?.id==='string'?ctxPl.id.slice(0,512):null,
    shuffle:String(shufKind||'').slice(0,32),repeat:[0,2,3].includes(repeat)?repeat:0,
    left:Math.max(0,Math.min(3,Number(left)||0)),counted:!!counted,
    position:Math.max(0,Math.min(86400,Number.isFinite(position)?position:0))};
}
export function parseQueueSnapshot(raw,now=Date.now()){
  try{
    const data=typeof raw==='string'?JSON.parse(raw):raw;
    if(!data||data.v!==1||!Array.isArray(data.ids)||data.ids.length>MAX_IDS||
      data.ids.some(x=>typeof x!=='string'||x.length>512)||typeof data.current!=='string'||
      !data.ids.includes(data.current)||typeof data.savedAt!=='number'||
      now-data.savedAt>30*86400000||data.savedAt>now+60000)return null;
    return data;
  }catch{return null;}
}
export function recoverQueueSnapshot(snapshot,lookup){
  if(!snapshot)return null;
  const ids=snapshot.ids.filter(id=>Boolean(lookup[id]));
  if(!ids.length)return null;
  const current=lookup[snapshot.current]?snapshot.current:ids[0];
  const index=Number.isInteger(snapshot.index)&&ids[snapshot.index]===current?snapshot.index:ids.indexOf(current);
  return {ids,current,index,position:current===snapshot.current?Math.max(0,Number(snapshot.position)||0):0,
    counted:current===snapshot.current&&!!snapshot.counted,
    scope:snapshot.scope?{...snapshot.scope,ids:snapshot.scope.ids.filter(id=>!!lookup[id])}:null};
}
