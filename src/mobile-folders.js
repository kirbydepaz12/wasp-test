/** Virtual source-aware folders for Subsonic clients. No physical MP3 moves. */
const clean=s=>String(s??'');
const key=(origin,id)=>origin+'\0'+id;
function folderId(origin){
  // Positive integer IDs are more compatible with older Subsonic clients.
  let h=2166136261;
  for(const byte of new TextEncoder().encode(origin))h=Math.imul(h^byte,16777619)>>>0;
  return String(3+(h%2000000000));
}
export function makeMobileFolders(catalogue){
  const roots=new Map();
  const all={id:'1',name:'All WASP music',songs:catalogue.tracks};
  roots.set('1',all);
  const local=catalogue.tracks.filter(t=>!t.origin || t.alternatives?.some(x=>!x.origin));
  roots.set('2',{id:'2',name:'This WASP server',songs:local});
  const origins=[...catalogue.authorizedOrigins].sort();
  for(const origin of origins){
    if(!origin)continue;
    let id=folderId(origin);
    while(roots.has(id))id=String(3+((Number(id)+1)%2000000000));
    const songs=catalogue.tracks.filter(t=>t.origin===origin||t.alternatives?.some(x=>x.origin===origin));
    // Do not advertise empty sources or playlist-only origins as music folders.
    if(songs.length)roots.set(id,{id,name:'Peer · '+new URL(origin).host,songs,origin});
  }
  return {roots,folders:[...roots.values()].filter(x=>x.songs.length).map(({id,name})=>({id:Number(id),name})),
    parse(id){const match=/^(fa|fb):([0-9]+):(.+)$/.exec(clean(id));return match && roots.has(match[2])?{type:match[1],folder:roots.get(match[2]),id:match[3]}:null;}};
}
export function folderArtistIndex(songs,artistId){
  const artists=new Map();
  for(const song of songs){
    if(artistId && song.artistId!==artistId)continue;
    if(!artists.has(song.artistId))artists.set(song.artistId,{id:song.artistId,name:song.artist,albums:new Map(),songs:[]});
    const artist=artists.get(song.artistId);artist.songs.push(song);
    if(!artist.albums.has(song.albumId))artist.albums.set(song.albumId,{id:song.albumId,name:song.album,artist:song.artist,songs:[]});
    artist.albums.get(song.albumId).songs.push(song);
  }
  return artists;
}
