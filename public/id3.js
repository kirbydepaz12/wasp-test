// Minimal ID3 reader (v2.3 / v2.4 text frames, v1 fallback) + duration lookup. Runs in the browser.
function decode(d) {
  const e = d[0], b = d.subarray(1);
  let label = e === 0 ? "windows-1252" : e === 3 ? "utf-8" : e === 2 ? "utf-16be" : "utf-16le";
  if (e === 1 && b[0] === 0xfe && b[1] === 0xff) label = "utf-16be";
  return new TextDecoder(label).decode(b).replace(/\uFEFF/g, "").replace(/\0+$/, "").replace(/\0+/g, ";").trim();
}
const v1 = (a) => new TextDecoder("windows-1252").decode(a).replace(/\0+$/g, "").trim();

export async function readTags(file) {
  const out = {};
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (String.fromCharCode(...head.slice(0, 3)) === "ID3") {
      const ver = head[3];
      const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
      const buf = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
      const map = { TIT2: "title", TPE1: "artist", TALB: "album", TRCK: "track", TDRC: "year", TYER: "year", TCON: "genre", TDOR: "original_date" };
      const custom = {};
      const customField = (bytes) => {
        const enc=bytes[0], step=(enc===1||enc===2)?2:1;
        let p=1;for(;p+step<=bytes.length;p+=step){if(step===1?bytes[p]===0:bytes[p]===0&&bytes[p+1]===0)break;}
        return [decode(new Uint8Array([enc,...bytes.subarray(1,p)])),decode(new Uint8Array([enc,...bytes.subarray(p+step)]))];
      };
      const find = (d, sig) => { for (let i = 0; i < Math.min(d.length - sig.length, 400); i++) if (sig.every((b, j) => d[i + j] === b)) return i; return -1; };
      let p = 0;
      while (p + 10 <= buf.length) {
        const id = String.fromCharCode(...buf.subarray(p, p + 4));
        if (!/^[A-Z0-9]{4}$/.test(id)) break;
        const fs = ver === 4
          ? (buf[p + 4] << 21) | (buf[p + 5] << 14) | (buf[p + 6] << 7) | buf[p + 7]
          : ((buf[p + 4] << 24) | (buf[p + 5] << 16) | (buf[p + 6] << 8) | buf[p + 7]) >>> 0;
        if (fs <= 0 || p + 10 + fs > buf.length) break;
        const d = buf.subarray(p + 10, p + 10 + fs);
        if (map[id]) out[map[id]] = decode(d);
        else if (id === "TXXX") { const [name,value]=customField(d);if(name) custom[name.toLowerCase()]=value; }
        else if (id === "POPM") { const end=d.indexOf(0);if(end>=0&&end+1<d.length)out.embedded_rating=(d[end+1]/255*5); }
        else if (id === "USLT") { const [descr,lyrics]=customField(new Uint8Array([d[0],...d.subarray(4)]));if(lyrics&&/\[\d{1,2}:\d{2}(?:\.\d+)?\]/.test(lyrics))out.lyrics_timed=true; }
        else if (id === "APIC" && !out.cover && fs < 5e6) {
          let i = find(d, [0xff, 0xd8, 0xff]), type = "image/jpeg";
          if (i < 0) { i = find(d, [0x89, 0x50, 0x4e, 0x47]); type = "image/png"; }
          if (i >= 0) out.cover = new Blob([d.slice(i)], { type });
        }
        p += 10 + fs;
      }
    }
    if (!out.title && !out.artist && file.size > 128) {
      const t = new Uint8Array(await file.slice(file.size - 128).arrayBuffer());
      if (String.fromCharCode(...t.slice(0, 3)) === "TAG") {
        out.title = v1(t.subarray(3, 33)); out.artist = v1(t.subarray(33, 63)); out.album = v1(t.subarray(63, 93));
      }
    }
    out.release_date=out.year||"";
    out.original_date=out.original_date||custom.originaldate||custom.originalyear||"";
    out.year=out.original_date||out.release_date||"";
    out.artists=String(custom.artists||"").split(/[\0;]/).map(s=>s.trim()).filter(Boolean).slice(0,30);
    out.musicbrainz_artist_ids=String(custom["musicbrainz artist id"]||"").split(/[\0;]/).map(s=>s.trim()).filter(s=>/^[a-f0-9-]{36}$/i.test(s)).slice(0,30);
    const country=String(custom.artistcountry||custom["artist country"]||"").split(/[\0;]/).map(s=>s.trim()).filter(Boolean);
    const area=String(custom.artistbeginarea||"").split(/[\0;]/).map(s=>s.trim()).filter(Boolean);
    out.artist_origins=out.artists.map((artist,i)=>({artist,mbid:out.musicbrainz_artist_ids[i]||"",country_code:country[i]||(country.length===1&&out.artists.length===1?country[0]:""),begin_area:area[i]||""}));
    // A worldwide album release (XW) is not an artist origin.
  } catch {}
  out.duration = await new Promise((res) => {
    const a = new Audio(), u = URL.createObjectURL(file);
    const done = (v) => { URL.revokeObjectURL(u); res(v); };
    a.preload = "metadata";
    a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => done(0);
    a.src = u;
  });
  return out;
}
