// A catalogue-scoped artist index, shared by artist cards, artwork routing and
// local/HIVE availability badges. Build once per catalogue refresh, not once
// per artist card. This module is deliberately DOM/network independent.
export function buildArtistIndex(catalogue, peerTracks, artistsOf, normalize) {
  const byName = new Map();
  const sources = new Map();
  const coverOrigin = new Map();
  const tracksByNormalized = new Map();
  const markSource = (name, track) => {
    const key = normalize(name);
    if (!key) return;
    let s = sources.get(key);
    if (!s) { s = {local:false,peer:false};sources.set(key,s); }
    const alternatives = Array.isArray(track.alternates) ? track.alternates : [];
    const origins = [track.origin || '', ...alternatives.map(a => a.origin || '')];
    if (origins.includes('')) s.local = true;
    if (origins.some(Boolean)) s.peer = true;
  };
  for (const track of catalogue) {
    // A song credited twice to the same artist should not count twice.
    const names = [...new Set(artistsOf(track).filter(Boolean))];
    const normalized = new Set();
    for (const name of names) {
      let item = byName.get(name);
      if (!item) {
        item = { id:name, name, songs:0, created:0, plays:0, tracks:[] };
        byName.set(name,item);
      }
      item.songs++;
      item.tracks.push(track);
      item.created = Math.max(item.created,Number(track.created_at)||0);
      item.plays += Number(track.plays)||0;
      markSource(name,track);
      if (track.origin && !coverOrigin.has(name)) coverOrigin.set(name,track.origin);
      const key=normalize(name);
      if(key&&!normalized.has(key)) {
        normalized.add(key);
        if (!tracksByNormalized.has(key)) tracksByNormalized.set(key,[]);
        tracksByNormalized.get(key).push(track);
      }
    }
  }
  // Hidden/deduplicated peer tracks still contribute to origin badges.
  for (const track of peerTracks) for (const name of new Set(artistsOf(track).filter(Boolean))) markSource(name,track);
  const alphabetical=[...byName.values()].sort((a,b)=>a.name.localeCompare(b.name));
  const newest=[...byName.values()].sort((a,b)=>b.created-a.created||a.name.localeCompare(b.name));
  return {byName,sources,coverOrigin,tracksByNormalized,alphabetical,newest};
}
