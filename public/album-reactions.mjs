// Stable, entity-scoped identifiers. A vote belongs to the release, not its songs.
export const normalizeAlbumPart = text => String(text||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en');
export function albumReactionKey(album,artist){
 const a=normalizeAlbumPart(album),b=normalizeAlbumPart(artist);
 if(!a||!b||a.length>180||b.length>180)return '';
 return 'album:v1:'+JSON.stringify([a,b]);
}
export function parseAlbumReactionKey(key){
 if(typeof key!=='string'||!key.startsWith('album:v1:')||key.length>512)return null;
 try{const pair=JSON.parse(key.slice(9));
  if(!Array.isArray(pair)||pair.length!==2||pair.some(x=>typeof x!=='string'))return null;
  const [album,artist]=pair;return albumReactionKey(album,artist)===key?{album,artist}:null;
 }catch{return null;}
}
