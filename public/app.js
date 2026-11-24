import { radioIds } from "/radio.js";
import { buildArtistIndex } from "/artist-index.mjs";
import { createRadioSelection, duplicateCandidates, artistSearchTokens, trackYear, trackGenres, normal } from "/radio-builder.js";
import { renderSidebarBBCode, legacySidebarToBBCode } from "/sidebar-bbcode.js";
import { artistArt as _artistArt, albumArt as _albumArt, albumName, artistsOf, artistLine, primaryArtist, adDoc, AD_SANDBOX } from "/art.js";
// v13: Docker injects same-origin relay_base in the local peer registry.
// Cloudflare Workers keep using their existing direct-peer behavior.
const peerRelays = new Map();
const peerSourceOrigins = new Map();
const peerCanonicalOrigins = new Map();
function registeredPeerOrigin(origin) { return peerSourceOrigins.get(origin) || origin; }
function peerResourceUrl(origin, resource) {
  const base=peerRelays.get(String(origin||'').replace(/\/$/,'')) || String(origin||'').replace(/\/$/,'');
  return base + resource;
}
function registerPeerRelay(peer) {
  if (!peer || !peer.url) return;
  const origin=String(peer.url).replace(/\/$/,'');
  const base=peer.relay_base || origin;
  peerRelays.set(origin,base);
  peerSourceOrigins.set(origin,origin);
  for (const alias of (Array.isArray(peer.origin_aliases) ? peer.origin_aliases : [])) {
    try { const canonical=new URL(alias).origin;peerRelays.set(canonical,base);peerSourceOrigins.set(canonical,origin);if(!peerCanonicalOrigins.has(origin))peerCanonicalOrigins.set(origin,canonical); } catch {}
  }
}
// Prefix peer origin so remote artwork and audio are fetched from Docker's
// local gateway when available, rather than from a browser-blocked Tailscale IP.
const albumArt = (t) => {
  // A peer track's public id is namespaced here, but its artwork endpoint expects
  // the original ID assigned by that peer (not origin|id).
  const u = _albumArt(t && t.remote_id ? {...t,id:t.remote_id} : t);
  return t && t.origin && u.startsWith("/") ? peerResourceUrl(t.origin,u) : u;
};
const artistArt = (name, origin) => {
  const u = _artistArt(name);
  const peerOrigin = origin || getArtistIndex().coverOrigin.get(name);
  return peerOrigin && u.startsWith("/") ? peerResourceUrl(peerOrigin,u) : u;
};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (s) => { s = Math.floor(s || 0); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
const plural = (n, w) => `${n} ${n === 1 ? w : w + "s"}`;
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const audio = $("#audio");
const TABS = { recent: "Recently added", top: "Most listened", listened: "Recently listened", artists: "Artists", playlists: "Playlists", radio: "Radio", hearts: "Most hearted", stars: "Most starred", user: "My playlists", settings: "Account settings", request: "Request" };
// Icon assets are the original user-supplied images; dark glyphs get a light CSS treatment.
const NAV_ICONS = Object.fromEntries(Object.keys(TABS).map((key) => [key, key === "stars" ? "/star.png" : `/nav-icons/${key}.png`]));
let sidebarCollapsed = store.get('sidebarCollapsed', false) === true;
const sidebarTooltip = $('#sidebarHoverTip');
function hideSidebarTooltip() { if(sidebarTooltip) sidebarTooltip.hidden=true; }
function showSidebarTooltip(text, x, y) {
  if(!sidebarCollapsed || !sidebarTooltip) return hideSidebarTooltip();
  sidebarTooltip.textContent = text;
  sidebarTooltip.hidden=false;
  const w=sidebarTooltip.offsetWidth,h=sidebarTooltip.offsetHeight;
  sidebarTooltip.style.left = Math.max(8,Math.min(x+16,window.innerWidth-w-8))+'px';
  sidebarTooltip.style.top = Math.max(8,Math.min(y+16,window.innerHeight-h-8))+'px';
}
function setSidebarCollapsed(value) {
  sidebarCollapsed=Boolean(value);
  document.body.classList.toggle('sidebar-collapsed',sidebarCollapsed);
  const toggle=$('#sidebarToggle');
  if(toggle){
    toggle.setAttribute('aria-expanded',String(!sidebarCollapsed));
    toggle.setAttribute('aria-label',sidebarCollapsed?'Expand sidebar':'Collapse sidebar');
    toggle.title=sidebarCollapsed?'Expand sidebar':'Collapse sidebar';
  }
  store.set('sidebarCollapsed',sidebarCollapsed);
  hideSidebarTooltip();
}
setSidebarCollapsed(sidebarCollapsed);
$('#sidebarToggle').addEventListener('click',()=>setSidebarCollapsed(!sidebarCollapsed));
$('#nav').addEventListener('pointerover',e=>{
  const item=e.target.closest('.nav-item');
  if(item)showSidebarTooltip(item.dataset.label,e.clientX,e.clientY);
});
$('#nav').addEventListener('pointermove',e=>{
  const item=e.target.closest('.nav-item');
  if(item)showSidebarTooltip(item.dataset.label,e.clientX,e.clientY);
});
$('#nav').addEventListener('pointerleave',hideSidebarTooltip);
$('#nav').addEventListener('focusin',e=>{
  const item=e.target.closest('.nav-item');
  if(item){const r=item.getBoundingClientRect();showSidebarTooltip(item.dataset.label,r.right,r.top+8);}
});
$('#nav').addEventListener('focusout',hideSidebarTooltip);
window.addEventListener('scroll',hideSidebarTooltip,true);
window.addEventListener('blur',hideSidebarTooltip);
const KEY = { heart: "hearts", like: "likes", dislike: "dislikes" };

let tracks = [], byId = {}, playlists = [], userPublicPlaylists = [], peerPlaylists = [], query = "";
let peerTrackLookup = new Map();
// Recreated only after loading a fresh catalogue (including peer snapshots).
// Artist cards never scan the entire local/HIVE library one by one.
let artistIndexCache = null;
function invalidateArtistIndex() { artistIndexCache=null; }
function getArtistIndex() {
  if (!artistIndexCache) artistIndexCache=buildArtistIndex(tracks,peerTrackLookup.values(),artistsOf,normalizeRecording);
  return artistIndexCache;
}

let primaryPeerOrigin = "";
let peerSnapshots = new Map();
let stalePeerSnapshots = new Set();
let recentListens = [];
let activeListeningKeys = new Set();
let activeStreamTracks = [];
let activeListenerCount = 0;
let activeListenerCountPartial = false;
const MAX_CURRENTLY_STREAMING = 30;
let recentBusy=false;
let view = { ids: [], label: "", pl: null }; // what the main area is showing (what a click on a row plays)
let queue = [], qi = -1, qLabel = "", ctxPl = null; // what is playing, and the playlist it came from
let repeat = store.get("rep", 0), left = 0, counted = false, shufKind = "";
let mine = store.get("mine", {});
// crypto.randomUUID() is only available in secure contexts (HTTPS / localhost).
// Over plain HTTP on a public IP it throws and the boot screen never finishes.
function makeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
let vid = store.get("vid", null);
if (!vid) { vid = makeId(); store.set("vid", vid); }

// ---------- site name, tab title, browser icon, front-page ad (set by the admin) ----------
let site = store.get("site", { name: "WASP", title: "", favicon: 0, show_brand_icon: false, brand_mode:"text", brand_v:0, sidebar:{enabled:false,html:""}, ad: { enabled: false, html: "", height: 340 } });
const setTip = (sel, text) => { const b = $(sel); b.dataset.tip = text; b.setAttribute("aria-label", text); };
function applySite() {
  const brand = $("#brand");
  brand.textContent = "";
  if(site.brand_mode==="image" && site.brand_v){
    const image=document.createElement("img");image.className="brand-image";image.alt=site.name||"WASP";
    image.src=`/site/brand?v=${site.brand_v}`;brand.append(image);
  }else{
  if (site.show_brand_icon) {
    const img = document.createElement("img");
    img.className = "brand-icon";
    img.alt = "";
    img.src = site.favicon ? `/site/favicon?v=${site.favicon}` : "/wasp-icon.png";
    brand.append(img);
  }
  brand.append(document.createTextNode(site.name || "WASP"));
  }
  // The compact sidebar keeps a small recognizable icon even for image-based brands.
  const mini=document.createElement('img');mini.className='mini-brand-icon';mini.alt='';
  mini.src=site.favicon ? `/site/favicon?v=${site.favicon}` : '/wasp-icon.png';
  brand.append(mini);
  applySidebarCredits();
  document.title = site.title || site.name || "WASP";
  $("#favicon").href = site.favicon ? `/site/favicon?v=${site.favicon}` : "/wasp-icon.png";
}
let lastCreditsBBCode=null;
function applySidebarCredits(){
  const target=$("#sidebarCredits");if(!target)return;
  const credits=site.sidebar||{};
  const source=credits.enabled
    ? (credits.bbcode!==null && credits.bbcode!==undefined
        ? String(credits.bbcode) : (credits.html ? legacySidebarToBBCode(credits.html) : "")).trim()
    : "";
  target.hidden=!source;
  if(source===lastCreditsBBCode)return;
  lastCreditsBBCode=source;
  if(!source){target.replaceChildren();return;}
  const block=document.createElement("div");block.className="sidebar-credits-content";
  renderSidebarBBCode(block,source);
  target.replaceChildren(block);
}
function adSlot() {
  const ad = site.ad;
  if (!ad || !ad.enabled || !ad.html.trim()) return "";
  return `<div class="spslot"><iframe class="spframe" title="Featured" sandbox="${AD_SANDBOX}" referrerpolicy="no-referrer" style="height:${ad.height}px" srcdoc="${esc(adDoc(ad.html, adStats()))}"></iframe></div>`;
}
applySite();

const BOOT_N = 40;
function paintBoot(pct, what) {
  const ring = $("#bootTicks");
  if (!ring) return;
  if (!ring.childElementCount) {
    ring.innerHTML = Array.from({ length: BOOT_N }, (_, i) =>
      `<i class="boot-tick" style="transform:rotate(${(360 / BOOT_N) * i}deg)"></i>`).join("");
  }
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  $("#bootPct").textContent = String(pct);
  $("#bootFill").style.width = pct + "%";
  if (what) $("#bootWhat").textContent = what;
  const lit = Math.round((pct / 100) * BOOT_N);
  [...ring.children].forEach((t, i) => t.classList.toggle("on", i < lit));
}
function hideBoot() {
  paintBoot(100, "Songs, artists and playlists");
  const el = $("#boot");
  if (!el) return;
  setTimeout(() => { el.classList.add("hide"); el.setAttribute("hidden", ""); }, 220);
}
paintBoot(3, "Songs, artists and playlists");

const art = (src, label, cls = "") =>
  `<span class="art ${cls}" data-i="${esc((label || "?").trim().charAt(0).toUpperCase())}">${src ? `<img loading="lazy" alt="" src="${esc(src)}">` : ""}</span>`;
// If external album/artist art is missing, walk matching MP3 embedded-cover
// endpoints before giving up. Peer URLs are kept source-aware so browsers
// behind a private Tailscale bridge never have to access the peer directly.
const artworkFallbacks=new WeakMap();
function embeddedTrackUrl(t){
 const id=t.remote_id||t.id;
 return t.origin ? peerResourceUrl(t.origin,"/art/track?id="+enc(id)+"&artv=15.0.3") : "/art/track?id="+enc(id)+"&artv=15.0.3";
}
function validExplicitCover(t){
 if(!t.cover_url)return "";
 try{
  const u=new URL(t.cover_url,t.origin||location.origin);
  if(t.origin&&u.origin===new URL(t.origin).origin)return peerResourceUrl(t.origin,u.pathname+u.search);
  return u.protocol==="https:"?u.href:"";
 }catch{return "";}
}
function artworkForMatchingTracks(kind,params,failedUrl){
 const id=params.get("id"),name=params.get(kind==="artist"?"name":"artist"),album=params.get("album");
 const candidates=[];
 const first=kind==="track"?tracks.find(t=>String(t.remote_id||t.id)===id):null;
 const effectiveArtist=name||(first&&primaryArtist(first));
 const effectiveAlbum=album||(first&&albumName(first));
 // The failed artwork path can fire for hundreds of artist images at once.
 // Use the catalogue-wide index instead of another full music scan per image.
 const pool=effectiveArtist && typeof getArtistIndex==='function' ? (getArtistIndex().tracksByNormalized.get(normalizeRecording(effectiveArtist))||[]) : tracks;
 const matching=pool.filter(t=>{
  if(kind==="track"&&String(t.remote_id||t.id)===id)return true;
  if(!effectiveArtist||!artistsOf(t).some(a=>a.toLowerCase()===String(effectiveArtist).toLowerCase()))return false;
  return kind==="artist"||!effectiveAlbum||albumName(t).toLowerCase()===String(effectiveAlbum).toLowerCase();
 });
 // Prefer same-source album art (when peer and local copies both exist).
 const failedOrigin=new URL(failedUrl,location.href).origin;
 matching.sort((a,b)=>{
  const aSame=new URL(embeddedTrackUrl(a),location.href).origin===failedOrigin;
  const bSame=new URL(embeddedTrackUrl(b),location.href).origin===failedOrigin;
  return Number(bSame)-Number(aSame);
 });
 for(const t of matching.slice(0,24)){
  const direct=embeddedTrackUrl(t),explicit=validExplicitCover(t);
  if(explicit)candidates.push(explicit);
  candidates.push(direct);
 }
 return candidates;
}
document.addEventListener("error",e=>{
 const img=e.target;if(img.tagName!=="IMG")return;
 let candidates=artworkFallbacks.get(img);
 if(!candidates){
  const src=new URL(img.src,location.href),kind=src.pathname.split("/").at(-1);
  if(!["artist","album","track"].includes(kind)||!src.pathname.includes("/art/")){
   img.remove();return;
  }
  candidates=artworkForMatchingTracks(kind,src.searchParams,img.src);
  candidates=[...new Set(candidates)].filter(x=>x&&new URL(x,location.href).href!==img.src);
  artworkFallbacks.set(img,candidates);
 }
 const next=candidates.shift();if(next){img.src=next;return;}
 img.remove();
},true);

let loadError = "";
let catalogueRevision = "";
let lastCatalogueCheck = 0;
let loadingCatalogue = false;
let peerRevisionSnapshot = new Map();
const catalogueURL=(path)=>catalogueRevision && catalogueRevision!=="0" ? path+"?v="+encodeURIComponent(catalogueRevision) : path;

const arr = (x) => (Array.isArray(x) ? x : []);
async function getJson(url) { // { data } or { fail: "what went wrong" }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const j = await r.json().catch(() => undefined);
    if (!r.ok || j === undefined) return { fail: `${url} answered ${r.status}${j && j.error ? ": " + j.error : ""}` };
    return { data: j };
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    return { fail: timedOut ? `${url} did not answer. The Worker is up, but D1 is not responding. In Cloudflare, open the Worker → Settings → Bindings and confirm DB (D1) and MUSIC (R2) are listed.` : `${url}: ${(e && e.message) || "no connection"}` };
  } finally { clearTimeout(timer); }
}
async function loadPeers(localIds) {
  // Pull catalogues from peer instances (admin-configured). Songs stream from the peer origin.
  let peers = [];
  try {
    const r = await fetch("/api/network/peers");
    if (r.ok) peers = arr(await r.json());
  } catch { return []; }
  peers.forEach(registerPeerRelay);
  primaryPeerOrigin = peers.find(p=>p.is_primary)?.url?.replace(/\/$/,"") || "";
  const remote = [];
  await Promise.all(peers.map(async (peer) => {
    if (!peer.url) return;
    const originKey=peer.url.replace(/\/$/,"");
    const saved=peerSnapshots.get(originKey);
    // If a reachable peer becomes unavailable, preserve the last metadata-only
    // snapshot instead of making its local-designated catalogue disappear.
    // This does not imply the remote audio can play while the peer is offline.
    const useSaved=(offline=false)=>{
      if(!saved?.synced_at || !Array.isArray(saved.tracks))return;
      for(const t of saved.tracks)if(t?.id)remote.push({...t,id:originKey+"|"+t.id,remote_id:t.id,origin:originKey,peer_name:peer.name||peer.url,peer_offline:offline});
    };
    try {
      let reachable=true;
      if(saved && saved.synced_at){
        try {
          const r=await fetch((peer.relay_base||peer.url)+"/api/catalog-version",{cache:"no-store",signal:AbortSignal.timeout(4000)});
          if(r.ok){const revision=(await r.json()).revision||"";
            peerRevisionSnapshot.set(originKey,revision);
            if(revision && saved.revision && revision!==saved.revision)stalePeerSnapshots.add(originKey);
          }else reachable=false;
        }catch{reachable=false;}
      }
      if(saved && Array.isArray(saved.tracks) && saved.synced_at && !stalePeerSnapshots.has(originKey)){
        useSaved(!reachable);return;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const base=(peer.relay_base||peer.url).replace(/\/$/, "");
      let revision="";
      try {const v=await fetch(base+"/api/catalog-version",{signal:AbortSignal.timeout(5000),cache:"no-store"});
        if(v.ok){revision=(await v.json()).revision||"";peerRevisionSnapshot.set(peer.url.replace(/\/$/,""),revision);}
      }catch{}
      const r = await fetch(base + "/api/tracks" + (revision&&revision!=="0" ? "?v="+encodeURIComponent(revision) : ""), { signal: ctrl.signal, headers: { accept: "application/json" } });
      clearTimeout(timer);
      if (!r.ok) {useSaved(true);return;}
      const list = arr(await r.json());
      for (const t of list) {
        if (!t || !t.id) continue; // remote IDs are scoped by their origin; local ID collisions are valid
        const origin=peer.url.replace(/\/$/, "");
        remote.push({
          ...t,
          id: origin + '|' + t.id,
          remote_id: t.id,
          origin,
          peer_name: peer.name || peer.url,
          plays: t.plays || 0,
          hearts: t.hearts || 0,
          likes: t.likes || 0,
          dislikes: t.dislikes || 0,
        });
      }
    } catch { useSaved(true); }
  }));
  return remote;
}
// Merge entries when artist/title/duration match. The administrator's
// explicitly selected primary server MUST win over other copies, including
// Cloudflare R2, without changing the underlying file or track origin.
const normalizeRecording = s => String(s||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
function localSourceRank(t) {
  // Prefer a playable local alternative to an offline snapshot of the primary
  // peer. A cached entry can still appear as metadata when no other copy exists.
  if(t.peer_offline)return 0;
  if (primaryPeerOrigin && t.origin === primaryPeerOrigin) return 3;
  return t.origin ? 1 : 2;
}
let routeCatalogue=new Map(),routeRecordingIndex=new Map();
const routeIdentity=t=>`${t.origin||''}|${t.remote_id||(t.origin&&String(t.id).startsWith(t.origin+'|')?String(t.id).slice(t.origin.length+1):t.id)}`;
const routeNorm=s=>String(s||'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
function routeRecordingKey(t){
  const artist=routeNorm((t.artists||[])[0]||t.artist),title=routeNorm(t.title),album=routeNorm(t.album);
  if(!artist||!title||!album||!Number(t.duration))return '';
  return JSON.stringify([artist,title,album]);
}
function samePlayableRecording(a,b){
  if(routeIdentity(a)===routeIdentity(b))return true;
  // Metadata matching is conservative and never compares versions across albums.
  const key=routeRecordingKey(a);if(!key||key!==routeRecordingKey(b))return false;
  const ad=Number(a.duration),bd=Number(b.duration);
  return ad>0&&bd>0&&Math.abs(ad-bd)<=2;
}
function dedupeCatalogue(items) {
  routeCatalogue=new Map();routeRecordingIndex=new Map();
  const groups = new Map(), members=new Map(), output=[];
  for (const t of items) {
    const routeKey=routeRecordingKey(t);if(routeKey){if(!routeRecordingIndex.has(routeKey))routeRecordingIndex.set(routeKey,[]);routeRecordingIndex.get(routeKey).push(t);}
    const artist=normalizeRecording((t.artists&&t.artists[0])||t.artist), title=normalizeRecording(t.title);
    const duration=Math.round(Number(t.duration)||0);
    const version=/\b(live|remix|remaster|acoustic|instrumental|demo|edit)\b/i.test(t.title||"");
    const key=artist && title && duration>0 && !version ? `${artist}|${title}|${Math.round(duration/3)}` : `unique:${t.origin||"local"}:${t.id}`;
    if(!members.has(key))members.set(key,[]);
    members.get(key).push(t);
    const prior=groups.get(key);
    if (!prior) { t.alternates=[]; groups.set(key,t); output.push(t); }
    else if (localSourceRank(t)>localSourceRank(prior)) {
      t.alternates=[{origin:prior.origin||null,id:prior.id},...(prior.alternates||[])];
      output[output.indexOf(prior)]=t;groups.set(key,t);
    } else {
      prior.alternates.push({origin:t.origin||null,id:t.id});
    }
  }
  for(const group of members.values())for(const t of group)routeCatalogue.set(t.id,group);
  return output;
}
async function load() {
  if(loadingCatalogue)return;
  loadingCatalogue=true;
  try {
  try {const r=await fetch("/api/catalog-version",{cache:"no-store"});if(r.ok)catalogueRevision=(await r.json()).revision||"";}catch{}

  const steps = [
    ["/api/tracks", "Songs"],
    ["/api/playlists", "Playlists"],
    ["/api/site", "Site"],
    ["/api/entity-reactions", "Reactions"],
  ];
  let done = 0;
  paintBoot(6, "Songs");
  const results = await Promise.all(steps.map(async ([url, label], i) => {
    const r = await getJson(["/api/tracks","/api/playlists"].includes(url)?catalogueURL(url):url);
    done++;
    paintBoot(8 + done * 22, steps[Math.min(done, steps.length - 1)][1] || label);
    return r;
  }));
  const [t, p, s, en] = results;
  entity = { artist: (en.data && en.data.artist) || {}, playlist: (en.data && en.data.playlist) || {} };
  ratedPlaylistCache = arr(en.data?.playlist_meta);
  tracks = arr(t.data); playlists = arr(p.data);
  try {const r=await fetch(catalogueURL("/api/user-playlists"));if(r.ok)userPublicPlaylists=arr(await r.json());}catch{}
  peerPlaylists=[];
  loadError = t.fail || p.fail || (t.data && !Array.isArray(t.data) ? "/api/tracks returned something unexpected" : "");
  if (s.data && typeof s.data.name === "string") { site = { ...s.data, ad: s.data.ad || { enabled: false, html: "", height: 340 } }; store.set("site", site); applySite(); }
  paintBoot(90, "Network peers");
  try {
    const cache=await fetch("/api/peer-catalogue",{cache:"no-store"});
    if(cache.ok){
      const old=peerSnapshots;
      peerSnapshots=new Map(arr(await cache.json()).map(row=>[row.origin.replace(/\/$/,""),row]));
      for(const [origin,row] of peerSnapshots){
        if(row.synced_at!==old.get(origin)?.synced_at || row.revision!==old.get(origin)?.revision)stalePeerSnapshots.delete(origin);
      }
    }
  }catch{}
  const localIds = new Set(tracks.map((x) => x.id));
  const remote = await loadPeers(localIds);
  peerTrackLookup = new Map(remote.map(t=>[t.id,t]));
  await loadPeerReactionCounts();
  try {
    const peers=arr(await (await fetch("/api/network/peers")).json());
    await Promise.all(peers.map(async peer=>{
      try {
        const origin=peer.url.replace(/\/$/,"");
        registerPeerRelay(peer);
        const via=peer.relay_base || origin;
        const peerRev=peerRevisionSnapshot.get(origin);
        const v=peerRev && peerRev!=="0" ? "?v="+encodeURIComponent(peerRev) : "";
        const saved=peerSnapshots.get(origin);
        let system=[],users=[];
        if(saved && saved.synced_at && !stalePeerSnapshots.has(origin)){system=arr(saved.playlists);users=arr(saved.users);}
        else {
          const [a,b]=await Promise.allSettled([fetch(via+"/api/playlists"+v),fetch(via+"/api/user-playlists"+v)]);
          const readList=async job=>{
            if(job.status!=="fulfilled"||!job.value.ok)return null;
            try{const value=await job.value.json();return Array.isArray(value)?value:null;}catch{return null;}
          };
          system=(await readList(a))??arr(saved?.playlists);
          users=(await readList(b))??arr(saved?.users);
        }
        const lists=[...system.map(p=>({...p,kind:"server"})),...users.map(p=>({...p,kind:"user"}))];
        const mapped=lists.map(p=>({...p,origin,id:origin+"|"+p.id,
          tracks:arr(p.tracks).map(id=>String(id).startsWith("peer:")?id:origin+"|"+id)}));
        if(origin===primaryPeerOrigin){
          playlists.push(...mapped.filter(p=>p.kind==="server"));
          userPublicPlaylists.push(...mapped.filter(p=>p.kind==="user"));
        }else peerPlaylists.push(...mapped);
      }catch{}
    }));
  }catch{}
  // Cross-server listening summaries: include play counts recorded on this
  // server for peer tracks, plus summaries from reachable connected peers.
  try {
    const peers=arr(await (await fetch("/api/network/peers")).json());
    const endpoints=["/api/peer-plays",...peers.map(p=>(p.relay_base||p.url)+"/api/peer-plays")];
    const rows=(await Promise.all(endpoints.map(u=>fetch(u,{signal:AbortSignal.timeout(6000)})
      .then(r=>r.ok?r.json():[]).catch(()=>[])))).flat();
    const totals=new Map();
    for(const row of rows){
      const key=String(row.origin||"").replace(/\/$/,"")+"|"+row.remote_id;
      totals.set(key,(totals.get(key)||0)+Math.max(0,Number(row.plays)||0));
    }
    for(const t of [...tracks,...remote]){
      const origin=t.origin ? registeredPeerOrigin(t.origin) : location.origin;
      const key=(peerCanonicalOrigins.get(origin)||origin)+"|"+(t.remote_id||t.id);
      t.plays=(Number(t.plays)||0)+(totals.get(key)||0);
    }
  }catch{}
  if (remote.length) tracks = dedupeCatalogue(tracks.concat(remote));
  else tracks = dedupeCatalogue(tracks);
  byId = Object.fromEntries(tracks.map((x) => [x.id, x]));
  for(const [id,group] of routeCatalogue)if(!byId[id])byId[id]=group.find(t=>t.id===id);
  // Keep peer playlist tracks addressable even when catalogue deduplication hides them.
  for(const [key,t] of peerTrackLookup) if(!byId[key]) byId[key]=t;
  // A public playlist can contain a song borrowed from a third RiffVault instance.
  // The publishing server includes its real origin and track ID in track_sources.
  for (const pl of [...playlists,...userPublicPlaylists,...peerPlaylists]) {
    for (const [ref, src] of Object.entries(pl.track_sources || {})) {
      if (!src || !src.origin || !src.remote_id) continue;
      let source;
      try { source=new URL(src.origin); } catch { continue; }
      if (!['https:','http:'].includes(source.protocol)) continue;
      const t={...src,id:ref,origin:source.origin,remote_id:src.remote_id,
        artists:[src.artist||'Unknown Artist'],title:src.title||'Unknown song',
        album:src.album||'',duration:Number(src.duration)||0,
        cover_url:src.cover_url||''};
      if (!byId[ref]) byId[ref]=t;
      peerTrackLookup.set(ref,byId[ref]);
    }
  }

  try {
    const r=await fetch("/api/user/peer-tracks");
    if(r.ok)for(const t of await r.json())if(!byId[t.id])byId[t.id]={...t,remote_id:t.remote_id,origin:t.origin,artists:[t.artist],cover_url:t.cover_url};
  } catch {}
  invalidateArtistIndex();
  paintBoot(100, "Songs, artists and playlists");
  render();
  hideBoot();
  } catch (e) {
    loadError = (e && e.message) || String(e);
    const el = $("#list");
    if (el) el.innerHTML = errorBox("This page couldn't be shown.", loadError);
    hideBoot();
  } finally {loadingCatalogue=false;}
}
// Check a cheap one-row revision instead of continuously downloading tracks.
// When a change is published, the next re-fetch uses a revision-keyed edge cache.
async function pollCatalogueChanges() {
  if(document.hidden || loadingCatalogue)return;
  if(Date.now()-lastCatalogueCheck<20000)return;
  lastCatalogueCheck=Date.now();
  let updated=false;
  try {const r=await fetch("/api/catalog-version",{cache:"no-store"});if(r.ok){
    const value=(await r.json()).revision||"0";
    if(catalogueRevision && value!==catalogueRevision)updated=true;
  }}catch{}
  try {
    const peers=arr(await (await fetch("/api/network/peers",{cache:"no-store"})).json());
    for(const peer of peers){
      const origin=peer.url?.replace(/\/$/,"");if(!origin)continue;
      const response=await fetch((peer.relay_base||origin)+"/api/catalog-version",{cache:"no-store",signal:AbortSignal.timeout(6000)});
      if(!response.ok)continue;
      const revision=(await response.json()).revision||"0";
      if(peerRevisionSnapshot.has(origin)&&peerRevisionSnapshot.get(origin)!==revision)updated=true;
      peerRevisionSnapshot.set(origin,revision);
    }
  }catch{}
  if(updated)await load();
}
setInterval(pollCatalogueChanges,30000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)pollCatalogueChanges();});
// An admin sync in another tab should refresh the open music view immediately.
window.addEventListener("storage",event=>{if(event.key==="wasp_peer_sync"){
  lastCatalogueCheck=0;load();
}});
window.addEventListener("hashchange",()=>{pollCatalogueChanges();});
const errorBox = (text, detail) => `<div class="empty"><p>${esc(text)}</p>${detail ? `<details style="margin:12px 0"><summary style="justify-content:center;font-size:14px">Details</summary><p class="muted" style="word-break:break-word">${esc(detail)}</p></details>` : ""}<button class="btn" type="button" data-act="retry">Try again</button></div>`;

// ---------- routing ----------
const SUBS = { songs: "Songs", artists: "Artists", albums: "Albums", playlists: "Playlists" };
const SUBMAPS = {
  top: { items: { ranked: "Most listened", telemetry: "Telemetry" }, def: "ranked" },
  recent: { items: SUBS, def: "songs" },
  hearts: { items: { songs: "Songs", artists: "Artists", playlists: "Playlists" }, def: "songs" },
  stars: { items: { songs: "Songs", artists: "Artists", playlists: "Playlists" }, def: "songs" },
  likes: { items: { songs: "Songs", artists: "Artists", playlists: "Playlists" }, def: "songs" },
  dislikes: { items: { songs: "Songs", artists: "Artists", playlists: "Playlists" }, def: "songs" },
  playlists: { items: { server: "Server playlists", peer: "Peer playlists", users: "Users playlists" }, def: "server" },
  request: { items: { queue: "Active queue", previous: "Previous requests", new: "Make a request" }, def: "queue" },
};
const LIMIT = { top: 100, hearts: 50, stars: 50, likes: 20, dislikes: 20 };
const RX = ["hearts", "stars"];
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const enc = encodeURIComponent;
const dict = () => Object.create(null);
function parse() {
  const raw = location.hash.slice(1) || "home", i = raw.indexOf("/");
  return { a: i < 0 ? raw : raw.slice(0, i), arg: i < 0 ? "" : raw.slice(i + 1) };
}
// Left menu is only the main sections. Sub tabs live in the sticky bar under search.
function updatePublishNoticeBadges(){
  const visible=!!(currentAccount?.authenticated&&currentAccount?.role==='user'&&currentAccount.publish_notice);
  const nav=document.querySelector('#nav a[href="#settings"]');
  if(nav){
    // Anchor the expanded notification to Account settings, not the sidebar.
    nav.classList.toggle('nav-has-notices', visible);
    nav.querySelectorAll('.nav-notice-dot').forEach(n=>n.remove());
    if(visible){
      const dot=document.createElement('span');dot.className='nav-notice-dot notice-expanded';dot.setAttribute('aria-label','Publishing permission approved');nav.appendChild(dot);
      const frame=nav.querySelector('.nav-icon-frame');if(frame){const compact=dot.cloneNode(true);compact.className='nav-notice-dot notice-compact';frame.appendChild(compact);}
    }
  }
  document.querySelectorAll('#subbar a[href="#settings/publish"], #accountSettingsDialog [data-settings-tab="publish"]').forEach(publish=>{
    publish.querySelectorAll('.publish-subtab-dot').forEach(el=>el.remove());
    if(visible){const d=document.createElement('span');d.className='publish-subtab-dot';d.setAttribute('aria-label','Publishing permission approved');publish.appendChild(d);}
  });
}
function renderNav(tab) {
  hideSidebarTooltip();
  $("#nav").innerHTML = Object.entries(TABS).filter(([k]) => !["user","settings"].includes(k) || currentAccount?.authenticated).map(([k, v]) =>
    `<a class="nav-item" href="#${k}" aria-label="${esc(v)}" data-label="${esc(v)}"${k === tab ? ' aria-current="page"' : ""}><span class="nav-icon-frame" aria-hidden="true"><img class="nav-icon${["hearts","stars"].includes(k) ? " nav-icon-color" : ""}" src="${NAV_ICONS[k]}" alt=""></span><span class="nav-label">${esc(v)}</span></a>`).join("");
  updatePublishNoticeBadges();
}
function renderSub(tab, sub) {
  const bar = $("#subbar");
  const sm = SUBMAPS[tab];
  if (!bar) return;
  if (!sm) { bar.hidden = true; bar.innerHTML = ""; return; }
  bar.hidden = false;
  bar.setAttribute("aria-label", TABS[tab] || "Sections");
  bar.innerHTML = Object.entries(sm.items).map(([s, sv]) =>
    `<a href="#${tab}${s === sm.def ? "" : "/" + s}"${s === sub ? ' aria-current="page"' : ""}>${sv}</a>`).join("");
}
const match = (t) => !query || `${t.title} ${artistLine(t)} ${albumName(t)}`.toLowerCase().includes(query);
const latest = (l) => Math.max(0, ...l.map((t) => t.created_at));
// The number from the song's own track tag, even when only one song of the album is here. Without any tags, the position.
const numLabel = (t, i, l) => t.track_no || (l.some((x) => x.track_no) ? "–" : i + 1);
const byTrack = (x, y) => (x.track_no || 999) - (y.track_no || 999) || x.title.localeCompare(y.title);

// v17.0.2: exact location indicators, including hidden duplicate sources.
// A primary peer remains remote storage even if its copy is preferred for playback.
const sourceGlyphs={
  server:'<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><circle cx="7" cy="6.5" r=".8" fill="currentColor"/><circle cx="7" cy="17.5" r=".8" fill="currentColor"/></svg>',
  cloud:'<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M20 17H7a4.5 4.5 0 0 1-.7-8.95 6.2 6.2 0 0 1 11.7 1.1A4 4 0 0 1 20 17Z"/></svg>'
};
function sourcesForTrack(t){
  const alternatives=Array.isArray(t?.alternates)?t.alternates:[];
  const origins=[t?.origin||'',...alternatives.map(a=>a.origin||'')];
  return {local:origins.includes(''),peer:origins.some(Boolean)};
}
function sourceIcons(source){
  const parts=[];
  if(source.local)parts.push(`<span class="source-location local" title="Stored on this WASP server" aria-label="Local server">${sourceGlyphs.server}</span>`);
  if(source.peer)parts.push(`<span class="source-location peer" title="Available from another WASP peer" aria-label="Peer server">${sourceGlyphs.cloud}</span>`);
  return parts.length?`<span class="source-icons" role="group" aria-label="${source.local&&source.peer?'Local and peer sources':source.local?'Local source':'Peer source'}">${parts.join('')}</span>`:'';
}
function artistSources(name){
  return getArtistIndex().sources.get(normalizeRecording(name)) || {local:false,peer:false};
}
const sourceTitle=(text,src)=>`${sourceIcons(src)}${esc(text)}`;

function row(t, num, extra = "", cover = false) {
  // Metadata is shown only when verified/available; never infer a release year.
  const year=trackYear(t),tags=trackGenres(t);
  return `<button class="row track-detail-row" data-id="${esc(t.id)}"><span class="n">${cover ? art(albumArt(t), albumName(t) || t.title) : num}</span>
    <span class="t">${sourceTitle(t.title,sourcesForTrack(t))}<small class="compact-artist">${esc(artistLine(t))}</small></span>
    <span class="al muted" title="Album">${esc(extra || albumName(t) || "Single")}</span>
    <span class="row-artists muted" title="Artists">${esc(artistLine(t))}</span>
    <span class="row-year muted" title="Release year">${year||'—'}</span>
    <span class="row-genre muted" title="Genre">${esc(tags.join(', ') || '—')}</span>
    <span class="row-duration muted" title="Duration">${fmt(t.duration)}</span></button>`;
}
function rowHeading(){return `<div class="track-column-head" aria-hidden="true"><span>#</span><span>Title</span><span>Album</span><span>Artists</span><span>Year</span><span>Genre</span><span>Duration</span></div>`;}
const songTiles = (l, extra) => `<div class="grid s">${l.map((t) =>
  `<button class="tile sq song" data-id="${esc(t.id)}">${art(albumArt(t), albumName(t) || t.title)}<b>${sourceTitle(t.title,sourcesForTrack(t))}</b><span class="muted">${esc(artistLine(t))}</span>${extra ? `<span class="muted">${esc(extra(t))}</span>` : ""}</button>`).join("")}</div>`;
const empty = (msg) => `<div class="empty">${msg}</div>`;
let entity = { artist: {}, playlist: {} };
let ratedPlaylistCache = []; // Locally voted peer playlists remain listed when a peer is offline.
const ownedPlaylistIndex = new Map(); // Private playlist data is only available to the owner.
const ecount = (type, key) => (entity[type] && has(entity[type], key) ? entity[type][key] : { hearts: 0, likes: 0, dislikes: 0 });
// v18.0.7: five-star votes are separate from existing heart and legacy reactions.
// Fetch only on-screen ratings and never request a complete voter ledger.
const starCache=new Map(),starKey=(type,key)=>type+'\x1f'+key;
function starsMarkup(type,key){
  const state=starCache.get(starKey(type,key))||{mine:0,average:0,votes:0};
  const mine=Math.max(0,Math.min(5,Number(state.mine)||0));
  return `<span class="rating-stars" data-star-type="${esc(type)}" data-star-key="${esc(key)}" role="group" aria-label="Rate ${type} from one to five stars">${Array.from({length:5},(_,i)=>`<button type="button" class="rate-star${i<mine?' filled':''}" data-star-value="${i+1}" aria-pressed="${i+1===mine}" aria-label="Rate ${i+1} of 5 stars" title="${i+1} of 5 stars">${i<mine?'★':'☆'}</button>`).join('')}<small class="rating-avg" title="Average rating across voters">${state.votes?Number(state.average).toFixed(1)+' ('+state.votes+')':''}</small></span>`;
}
let starsTimer=0,starsBusy=false;
function scheduleStarRefresh(){clearTimeout(starsTimer);starsTimer=setTimeout(refreshVisibleStars,250);}
async function refreshVisibleStars(){if(starsBusy)return;const nodes=[...document.querySelectorAll('.rating-stars')].slice(0,115);const entries=[...new Map(nodes.map(el=>[starKey(el.dataset.starType,el.dataset.starKey),{type:el.dataset.starType,key:el.dataset.starKey}])).values()];
 if(!entries.length)return;starsBusy=true;
 try{const res=await fetch('/api/stars/batch',{method:'POST',headers:{'content-type':'application/json','X-Visitor':vid},body:JSON.stringify({targets:entries}),cache:'no-store'});if(!res.ok)return;
 const data=await res.json();const keys=new Map((data.items||[]).map(x=>[starKey(x.type,x.key),x]));
 for(const target of entries)starCache.set(starKey(target.type,target.key),keys.get(starKey(target.type,target.key))||{votes:0,average:0,mine:0});
 for(const el of nodes){const state=starCache.get(starKey(el.dataset.starType,el.dataset.starKey))||{};const mine=Number(state.mine)||0;
  el.querySelectorAll('[data-star-value]').forEach(button=>{const n=Number(button.dataset.starValue);button.classList.toggle('filled',n<=mine);if(button.textContent!==(n<=mine?'★':'☆'))button.textContent=n<=mine?'★':'☆';button.setAttribute('aria-pressed',String(n===mine));});
  const avg=el.querySelector('.rating-avg');if(avg){const next=state.votes?Number(state.average).toFixed(1)+' ('+state.votes+')':'';if(avg.textContent!==next)avg.textContent=next;}
 }
 }catch{}finally{starsBusy=false;}
}
async function setStarVote(button){const host=button.closest('.rating-stars'),type=host?.dataset.starType,key=host?.dataset.starKey;
 if(!type||!key)return;const score=Number(button.dataset.starValue),prev=starCache.get(starKey(type,key))||{};
 const stars=Number(prev.mine)===score?0:score;
 const item={type,key,stars};
 if(type==='track'){
   const t=tracks.find(t=>String(t.id)===key)||peerTrackLookup.get(key)||byId[key];if(t?.origin){item.origin=registeredPeerOrigin(t.origin);item.remote_id=t.remote_id||String(t.id).split('|').at(-1);item.key=item.origin+'|'+item.remote_id;}
 }else if(type==='artist'){const t=tracks.find(t=>t.origin&&artistsOf(t).includes(key));if(t)item.origin=registeredPeerOrigin(t.origin);
 }else if(type==='playlist'){const p=lookupReactedPlaylist(key);if(p?.origin)item.origin=registeredPeerOrigin(p.origin);}
 button.disabled=true;
 try{const res=await fetch('/api/stars',{method:'POST',headers:{'content-type':'application/json','X-Visitor':vid},body:JSON.stringify(item)});const saved=await res.json();if(!res.ok)throw Error(saved.error||'Rating was not saved');starCache.set(starKey(type,key),saved);starRankingCache.delete(type+':most');starRankingCache.delete(type+':least');scheduleStarRefresh();if(parse().a==='stars')void refreshStarRankings(document.querySelector('#list'),parse().arg.split('/')[0]||'songs');
 }catch(e){popup('Rating not saved',e.message||'Please retry.');}finally{button.disabled=false;}
}
document.addEventListener('click',e=>{const star=e.target.closest('[data-star-value]');if(!star)return;e.preventDefault();e.stopPropagation();void setStarVote(star);},true);
const starObserver=new MutationObserver(()=>scheduleStarRefresh());
starObserver.observe(document.querySelector('#list'),{childList:true,subtree:true});
function reactCircles(type, key) {
  const c = ecount(type, key), m = mine[type[0] + ":" + key] || {};
  const one = ([k, icon, label, cnt]) => `<span class="rc"><button type="button" class="circ tip${m[k] ? " on" : ""}" data-ent="${type}" data-key="${esc(key)}" data-r="${k}" data-tip="${m[k] ? "Remove " + label.toLowerCase() : label}" aria-label="${label}" aria-pressed="${!!m[k]}"><svg><use href="#${icon}"/></svg></button><small>${c[cnt] || 0}</small></span>`;
  return `<span class="rcircles" role="group" aria-label="Heart and rate this ${type}" data-type="${type}" data-key="${esc(key)}">${one(["heart","i-heart","Heart","hearts"])}${starsMarkup(type,key)}</span>`;
}
async function reactEntity(type, key, kind) {
  const mk = type[0] + ":" + key, m = (mine[mk] ??= {}), on = !m[kind];
  const previousMine={...m},previousCounts={...ecount(type,key)};
  if (!has(entity[type], key)) entity[type][key] = { hearts: 0, likes: 0, dislikes: 0 };
  const c = entity[type][key], f = { heart: "hearts", like: "likes", dislike: "dislikes" };
  m[kind] = on; c[f[kind]] = Math.max(0, c[f[kind]] + (on ? 1 : -1));
  const other = kind === "like" ? "dislike" : kind === "dislike" ? "like" : null;
  if (on && other && m[other]) { m[other] = false; c[f[other]] = Math.max(0, c[f[other]] - 1); }
  store.set("mine", mine);
  const repaint = () => { const el = [...document.querySelectorAll("#list .rcircles")].find((x) => x.dataset.type === type && x.dataset.key === key); if (el) { const p = type === 'playlist' ? lookupReactedPlaylist(key) : null; el.outerHTML = el.classList.contains('playlist-ratings') && p ? playlistReactControls(p) : reactCircles(type, key); const b = [...document.querySelectorAll("#list [data-ent]")].find((x) => x.dataset.ent === type && x.dataset.key === key && x.dataset.r === kind); if (b) b.focus(); } };
  repaint();
  try {
    const playlist=type==='playlist' ? lookupReactedPlaylist(key) : null;
    const remoteArtist=type==='artist' ? tracks.find(t=>t.origin&&artistsOf(t).some(n=>n.toLowerCase()===key.toLowerCase())) : null;
    const extra=playlist ? {origin:registeredPeerOrigin(playlist.origin||''),name:playlist.name,
      cover_url:playlist.cover_url||'',playlist_kind:playlist.kind||'server',username:playlist.username||'',
      track_count:arr(playlist.tracks).length} : remoteArtist ? {origin:registeredPeerOrigin(remoteArtist.origin)} : {};
    const r = await fetch("/api/react-entity", { method: "POST", headers: { "content-type": "application/json", "X-Visitor": vid }, body: JSON.stringify({ type, key, kind, on, ...extra }) });
    if (!r.ok) { const j=await r.json().catch(()=>({}));throw Error(j.error||'Could not save reaction.'); }
    Object.assign(c, await r.json()); repaint();
  } catch (e) {
    // A failed vote must not remain in the UI or localStorage as a phantom vote.
    Object.assign(m, previousMine);Object.assign(c, previousCounts);store.set('mine',mine);repaint();
    popup('Reaction not saved',e.message||'Please try again.');
  }
}
const actions = (radio, ent) => `<div class="form" style="margin:12px 0"><button class="btn" data-act="play">Play</button><button class="btn ghost" data-act="shuf">Shuffle</button>${radio ? `<button class="btn ghost" data-act="radio" title="Songs from the same genre, to discover more music"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-radio"/></svg>Radio</button>` : ""}${ent ? reactCircles(ent.type, ent.key) : ""}</div>`;
const noView = () => { view = { ids: [], label: "", pl: null }; };

async function paintSpotifyImportStatus(playlistId){
  const place=$('#spotifyImportStatus');if(!place)return;
  try{
    const r=await fetch('/api/user/spotify-imports',{cache:'no-store'});
    if(!r.ok)return;
    const imp=arr(await r.json()).find(x=>x.playlist_id===playlistId);
    if(!imp||(imp.state==='complete'&&!imp.completed_partial)){place.textContent='';return;}
    const knownComplete=imp.state==='complete';
    place.innerHTML=`<section class="spotify-import-status" aria-label="Spotify recreation progress">
      <b>${knownComplete?'Playlist finalized · remaining songs':'Recreating your Spotify playlist'}</b>
      <p class="muted">${imp.matched} of ${Math.max(imp.total,imp.source_total||0)}${imp.partial&&!imp.source_total?'+':''} songs found · <span class="spotify-local">${imp.local} local</span> · <span class="spotify-peer">${imp.peer} on peers</span> · ${imp.missing} known missing${imp.source_total>imp.total?` · ${imp.source_total-imp.total} titles not retrieved`:''}.</p>
      ${imp.partial?`<p class="muted">${imp.user_supplied_count?`${imp.total} known titles (${imp.user_supplied_count} supplied by you).`:`Spotify returned ${imp.total} songs${imp.source_total?` of ${imp.source_total} reported`:""}.`} Full Spotify list is not verified.</p>`:''}
      <div class="spotify-import-progress"><progress max="${Math.max(1,imp.total,imp.source_total||0)}" value="${imp.matched}"></progress></div>
      <div class="spotify-import-actions"><button class="btn ghost" type="button" data-spotify-import="refresh">Refresh matches</button>
        ${knownComplete?'':`<button class="btn" type="button" data-spotify-import="complete">${imp.missing||imp.partial?'Mark as done ANYWAYS':'Mark as done'}</button>`}</div>
      ${imp.missing||imp.partial?'<p class="muted">You can add the remaining missing songs later.</p>':''}
      ${imp.partial?'<details class="spotify-supplement"><summary>Add remaining song list manually</summary><p class="muted">Paste one song per line: title, a tab, then artist. You can copy two columns from a spreadsheet.</p><textarea rows="5" maxlength="500000" aria-label="Track list" data-track-list></textarea><button class="btn ghost" type="button" data-supplement>Add titles and match</button></details>':''}
      ${imp.missing?'<details class="spotify-missing-list"><summary>Show songs not found in HIVE</summary><div data-missing-list class="muted">Loading…</div></details>':''}
      <p class="muted" id="spotifyImportStatusMsg" role="status"></p>
    </section>`;
    const details=place.querySelector('.spotify-missing-list');if(details)details.addEventListener('toggle',async()=>{
      if(!details.open||details.dataset.loaded)return;const target=details.querySelector('[data-missing-list]');
      try{const r=await fetch(`/api/user/spotify-imports/${enc(imp.id)}/missing`);if(!r.ok)throw Error('Unable to read missing songs');const j=await r.json();
        target.innerHTML=arr(j.songs).map(t=>`<div class="spotify-missing-row"><span>${esc(t.t)} <small class="muted">· ${esc(t.a)}</small></span><button type="button" class="btn ghost" data-missing-action="search" data-title="${esc(t.t)}" data-artist="${esc(t.a)}">Search song</button><button type="button" class="btn ghost" data-missing-action="request" data-title="${esc(t.t)}" data-artist="${esc(t.a)}">Request</button></div>`).join('')||'No known missing songs.';details.dataset.loaded='1';
        target.onclick=async e=>{const b=e.target.closest('[data-missing-action]');if(!b)return;const title=b.dataset.title,artist=b.dataset.artist;b.disabled=true;try{if(b.dataset.missingAction==='request'){const res=await fetch(`/api/user/spotify-imports/${enc(imp.id)}/request`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title,artist})});const j=await res.json();if(!res.ok)throw Error(j.error||'Request failed');popup(j.in_library?'Song found':j.requested?'Request added':'Already requested',j.in_library?'Refresh matches to add the song.':j.requested?'Added to the request queue.':'This song is already in the queue.');return;}let offset=0,checked=0,reachable=0,match=false;do{const res=await fetch(`/api/user/spotify-imports/${enc(imp.id)}/search`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title,artist,offset})});const j=await res.json();if(!res.ok)throw Error(j.error||'Search failed');match=!!j.found;checked+=Number(j.refreshed||0);reachable+=Number(j.reachable||0);offset=j.nextOffset;b.textContent=`Searching ${checked}/${j.totalPeers||0}…`;}while(offset!=null&&checked<100&&b.isConnected);if(b.isConnected)popup(match?'Song found':'Search complete',`${match?'A matching song is in the catalogue. Refresh matches to add it.':'No matching song found. You can request it.'} Checked ${checked} connected peer(s); ${reachable} answered. Matches are catalogue-based.`);}catch(e){popup('Unable to complete action',e.message);}finally{b.disabled=false;b.textContent=b.dataset.missingAction==='search'?'Search song':'Request';}};
      }catch(e){target.textContent=e.message;}
    });
    const supplement=place.querySelector('[data-supplement]');if(supplement)supplement.onclick=async()=>{
      supplement.disabled=true;const message=place.querySelector('#spotifyImportStatusMsg');message.textContent='Matching supplied titles…';
      try{const r=await fetch(`/api/user/spotify-imports/${enc(imp.id)}/supplement`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:place.querySelector('[data-track-list]').value})});const j=await r.json();if(!r.ok)throw Error(j.error||'Unable to add song list');await load();render();}catch(e){message.textContent=e.message;supplement.disabled=false;}
    };
    place.querySelectorAll('button[data-spotify-import]').forEach(button=>button.onclick=async()=>{
      const action=button.dataset.spotifyImport;const partial=!!(imp.missing||imp.partial);if(action==='complete'&&partial&&!confirm('Mark as done ANYWAYS? You can add the remaining missing songs later.'))return;place.querySelectorAll('button').forEach(b=>b.disabled=true);
      const message=$('#spotifyImportStatusMsg');message.textContent=action==='refresh'?'Checking peer catalogues…':'Finishing…';
      try{
        const response=await fetch(`/api/user/spotify-imports/${enc(imp.id)}/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirm_partial:action==='complete'&&partial})});
        const j=await response.json();if(!response.ok)throw Error(j.error||'Unable to update playlist');
        if(action==='complete'){message.textContent='Playlist completed. It remains private unless you publish it.';await load();render();}
        else {await load();render();}
      }catch(error){message.textContent=error.message;place.querySelectorAll('button').forEach(b=>b.disabled=false);}
    });
  }catch{}
}

let lastBrowseHash = location.hash && !/^#settings(?:\/|$)/.test(location.hash) ? location.hash : "#home";
function render() {
  // Legacy thumbs-up and thumbs-down bookmarks now show star-vote rankings.
  if(["likes","dislikes"].includes(parse().a)){location.hash="#stars";return;}
  // Old #settings and #settings/publish links still work, but no longer replace
  // the browser view or destroy the current queue/player/scroll position.
  if(parse().a === "settings"){
    const section=parse().arg || "account";
    try { history.replaceState(history.state, "", location.pathname + location.search + lastBrowseHash); }
    catch { /* Opaque-origin preview sandboxes may prohibit History updates. */ }
    // Direct settings bookmarks have no prior music page. Show the normal home
    // library behind the dialog rather than leaving a blank background.
    if(!$('#list').childElementCount){renderNav('');renderSub('',null);landing($('#list'));markRows();}
    void openAccountSettings(section);
    return;
  }
  try { renderPage(); }
  catch (e) { console.error(e); $("#list").innerHTML = errorBox("This page couldn't be shown.", String((e && e.message) || e)); noView(); }
}
function renderPage() {
  releaseArtistGridObserver();
  const { a, arg } = parse();
  if (a === "user") {
    renderNav("user");renderSub("",null);
    const section=arg||"private";
    $("#subbar").hidden=false;
    $("#subbar").innerHTML=`<a href="#user/private" ${section==="private"?'aria-current="page"':""}>Private playlists</a><a href="#user/public" ${section==="public"?'aria-current="page"':""}>Public playlists</a>`;
    $("#list").innerHTML='<h1>My playlists</h1>'+
      (section==='private'?`<form id="spotifyImportForm" class="spotify-import-form" autocomplete="off">
        <h3>Recreate a Spotify playlist</h3>
        <p class="muted">Paste a public Spotify playlist link. WASP creates your private copy from songs held locally or on your connected peers. Missing songs are requested individually across the HIVE.</p>
        <label for="spotifyImportUrl">Spotify playlist URL</label>
        <div class="spotify-import-controls"><input id="spotifyImportUrl" type="url" placeholder="https://open.spotify.com/playlist/..." required maxlength="300"><button class="btn" type="submit">Import to My Playlists</button></div>
        <p id="spotifyImportMsg" class="muted" role="status" aria-live="polite"></p>
      </form>`:'')+'<div id="myLists">Loading…</div>';
    const importForm=$('#spotifyImportForm');
    if(importForm)importForm.onsubmit=async event=>{
      event.preventDefault();const btn=importForm.querySelector('button'),msg=$('#spotifyImportMsg');
      btn.disabled=true;msg.textContent='Reading Spotify songs and checking your WASP peers…';
      try{
        const r=await fetch('/api/user/spotify-import',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({url:$('#spotifyImportUrl').value.trim()})});
        const j=await r.json();if(!r.ok)throw Error(j.error||'Import failed');
        msg.textContent=`${j.local} local, ${j.peer} from peers, ${j.missing} missing song requests.`;
        await load();location.hash='#userplaylist/'+enc(j.playlist_id);render();
      }catch(error){msg.textContent=error.message;}finally{btn.disabled=false;}
    };
    (async()=>{
      const place=$("#myLists");
      try {
        const me=await (await fetch("/api/me")).json();
        if(!me.authenticated){place.textContent="Sign in to view your playlists.";return;}
        const r=await fetch("/api/user/playlists");if(!r.ok){place.textContent="Unable to load playlists.";return;}
        const pls=(await r.json()).filter(p=>!!p.is_public===(section==="public"));
        let imports=[];try{const ir=await fetch('/api/user/spotify-imports');if(ir.ok)imports=arr(await ir.json());}catch{}
        const status=new Map(imports.map(item=>[item.playlist_id,item]));
        const grid=pls.map(p=>{const current=status.get(p.id),extra=current?.state==='draft'?`<span class="spotify-import-pending">Recreating · ${current.matched}/${current.total}${current.partial?'+':''} · ${current.missing} missing</span>`:'';
          return `<div class="tile sq pltile"><div class="covwrap"><a class="covlink" href="#userplaylist/${enc(p.id)}" aria-label="Open ${esc(p.name)}">${ownedPlaylistCover(p)}</a></div><a class="ttl" href="#userplaylist/${enc(p.id)}"><b>${esc(p.name)}</b><span class="muted">${plural((p.tracks||[]).length,"song")}</span>${extra}</a></div>`;
        }).join("");
        if(place.isConnected)place.innerHTML=grid?`<div class="grid s">${grid}</div>`:empty("No playlists yet. Use + in the player to create one.");
      } catch {if(place.isConnected)place.textContent='Unable to load playlists.';}
    })();return;
  }
  if(a==="userplaylist"){
    renderNav("user");renderSub("",null);const el=$("#list");el.innerHTML="Loading playlist…";
    (async()=>{const r=await fetch("/api/user/playlists");if(!r.ok){el.textContent="Sign in required.";return;}const ps=await r.json();for(const candidate of ps)ownedPlaylistIndex.set(candidate.id,candidate);const p=ps.find(x=>x.id===dec(arg));if(!p){el.textContent="Playlist not found.";return;}
      const ids=(p.tracks||[]).map(ref=>typeof ref==='object'?(ref.ref||ref.track_id||ref.id):ref);
      let savedRefs=[];try{const rr=await fetch('/api/user/peer-tracks');if(rr.ok)savedRefs=arr(await rr.json());}catch{}
      if(parse().a!=='userplaylist'||dec(parse().arg)!==p.id)return;
      const savedMap=new Map(savedRefs.map(t=>[t.id,t]));for(const id of ids){const t=savedMap.get(id);if(!t)continue;
        const direct=peerTrackLookup.get(registeredPeerOrigin(t.origin)+'|'+t.remote_id)||peerTrackLookup.get(t.origin+'|'+t.remote_id);
        const cached={...t,id,artists:[t.artist],peer_offline:true};
        if(direct&&!direct.peer_offline)byId[id]={...direct,id};else byId[id]=cached;
      }
      view={ids:ids.filter(id=>byId[id]),label:p.name,pl:p};
      el.innerHTML=`<a class="back" href="#user/${p.is_public?'public':'private'}">← My playlists</a><div class="owned-playlist-header"><div class="playlist-detail-hero"><div class="playlist-detail-cover">${ownedPlaylistCover(p)}</div><h1>${esc(p.name)}</h1><p class="muted">${p.is_public?'Public playlist':'Private playlist'}</p><div class="playlist-detail-actions">${playlistReactControls(p)}</div></div><button type="button" class="playlist-cog" id="playlistCog" aria-label="Edit playlist settings" title="Edit playlist">⚙</button><button type="button" class="btn ghost playlist-duplicate-trigger" id="playlistDuplicateScan">Find duplicates</button></div><div id="playlistDuplicatePanel" class="playlist-duplicate-panel" hidden></div><p role="alert" class="msg err" id="playlistDraftError"></p><div id="spotifyImportStatus"></div><div class="playlist-draft-toolbar" id="playlistDraftToolbar" hidden><button class="btn ghost" type="button" id="playlistUndo" title="Undo the last five removals">↶ Undo</button><button class="btn" type="button" id="playlistCommit">Save changes</button><span class="muted" id="playlistDraftCount"></span></div><div class="playlist-track-list" id="ownedTrackList"></div>`;
      el.querySelector('#playlistCog').onclick=()=>openEditPlaylist(p);
      void paintSpotifyImportStatus(p.id);
      initOwnedTrackEditor(el,p,ids);
    })();return;
  }
  if (a === "home") { renderNav(""); renderSub("", null); landing($("#list")); markRows(); return; }
  const tab = a === "artist" || a === "similar" ? "artists" : a === "playlist" ? "playlists" : a === "album" ? "recent" : has(TABS, a) ? a : "recent";
  const sm = SUBMAPS[tab];
  const head = arg.split("/")[0];
  const sub = !sm ? null : a === "album" ? "albums" : has(sm.items, head) ? head : sm.def;
  renderNav(tab);
  renderSub(tab, sub);
  const el = $("#list");
  // v17: telemetry/rankings use a lazy same-origin document. The fixed #audio
  // element, queue and control handlers in index.html are NEVER replaced.
  if(tab==='top'||RX.includes(tab)){
    renderTelemetryMount(el,tab,sub);
    if(tab==='stars')void refreshStarRankings(el,sub);
    return;
  }
  if (tab === "request") { if (sub === "new") requestForm(el); else if (sub === "previous") requestPrevious(el, arg.split("/")[1]); else requestQueue(el); return; }
  if (tab === "radio") { radioPage(el);return; }
  // Reaction charts may contain locally cached peer songs even if the remote
  // catalogue is temporarily offline (and this installation has no uploads).
  const hasChartData = (tab === "listened") || RX.includes(tab) && (
    (sub === 'songs' && peerReactionTracks.size) ||
    (sub === 'artists' && Object.keys(entity.artist).length) ||
    (sub === 'playlists' && (ratedPlaylistCache.length || playlists.length || peerPlaylists.length || userPublicPlaylists.length))
  );
  if (!tracks.length && !hasChartData) {
    el.innerHTML = loadError ? errorBox("The music library couldn't be loaded.", loadError) : empty("No music yet. Check back soon."); noView(); return;
  }
  if (a === "artist") artistPage(el, dec(arg));
  else if (a === "similar") similarPage(el, dec(arg));
  else if (a === "playlist") playlistPage(el, dec(arg));
  else if (a === "album") albumPage(el, ...arg.split("/").map(dec));
  else if (tab === "recent") {
    if (sub === "artists") artistGrid(el, true);
    else if (sub === "albums") albumGrid(el);
    else if (sub === "playlists") playlistGrid(el, true);
    else songList(el);
  }
  else if (tab === "artists") artistGrid(el, false);
  else if (tab === "playlists") {
    if(sub==="users") {
      noView();el.innerHTML=userPublicPlaylists.length?`<div class="grid s">${userPublicPlaylists.filter(p=>!query||p.name.toLowerCase().includes(query)).map(p=>playlistTile(p,`by ${p.username || 'Unknown user'} · ${plural(arr(p.tracks).length, 'song')}`)).join("")}</div>`:empty("No public user playlists yet.");
    }else if(sub==="peer") {
      noView();el.innerHTML=peerPlaylists.length?`<div class="grid s">${peerPlaylists.filter(p=>!query||p.name.toLowerCase().includes(query)).map(p=>playlistTile(p,`from ${new URL(p.origin).hostname}`)).join("")}</div>`:empty("No peer playlists yet.");
    }else playlistGrid(el,false);
  }
  else if (tab === "listened") {recentListView(el);refreshRecentListens();}
  else if (RX.includes(tab) && sub === "artists") reactedArtists(el, tab);
  else if (RX.includes(tab) && sub === "playlists") reactedPlaylists(el, tab);
  else listView(el, tab);
  markRows();
}

const shuffle = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
function pickMix(items, newer, hotter) {
  const used = new Set();
  const take = (ordered, n) => {
    const out = [];
    for (const x of ordered) {
      if (used.has(x.id)) continue;
      used.add(x.id); out.push(x);
      if (out.length === n) break;
    }
    return out;
  };
  const fresh = take([...items].sort((a, b) => newer(b) - newer(a)), 5);
  const hot = take([...items].sort((a, b) => hotter(b) - hotter(a)), 5);
  const rest = shuffle(items.filter((x) => !used.has(x.id)));
  return shuffle([...fresh, ...hot, ...take(rest, 10)]);
}
function artistPool() {
  return getArtistIndex().alphabetical;
}
const moreTile = (href, label) => `<a class="simtile" href="${href}"><span class="art round dots" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></span><b>Show more</b><span class="muted">${esc(label)}</span></a>`;
function landing(el) {
  noView();
  if (loadError && !tracks.length) { el.innerHTML = errorBox("The music library couldn't be loaded.", loadError); return; }
  if (!tracks.length) { el.innerHTML = empty("No music yet. Check back soon."); return; }
  const qOk = (s) => !query || String(s).toLowerCase().includes(query);
  const artists = pickMix(artistPool().filter((a) => qOk(a.name)), (a) => a.created, (a) => a.plays);
  const songs = pickMix(tracks.filter(match).map((t) => ({ id: t.id, t, created: t.created_at || 0, plays: t.plays || 0 })), (s) => s.created, (s) => s.plays);
  const pls = pickMix(playlists.filter((p) => qOk(p.name)).map((p) => ({
    id: p.id, p, created: p.updated_at || p.created_at || 0,
    plays: (p.tracks || []).reduce((n, id) => n + ((byId[id] && byId[id].plays) || 0), 0),
  })), (p) => p.created, (p) => p.plays);
  const ad = query ? "" : adSlot();
  const row = (title, inner) => `<section class="hsec"><h2>${title}</h2><div class="hscroll"><button class="hnav hnav-left" data-scroll="-1" aria-label="Scroll ${title} left">‹</button><div class="hrow">${inner}</div><button class="hnav hnav-right" data-scroll="1" aria-label="Scroll ${title} right">›</button></div></section>`;
  el.innerHTML =
    (ad ? `<div class="home-ad">${ad}</div>` : "")
    + row("Artists", artists.map((a) => `<a class="tile" href="#artist/${enc(a.name)}">${art(artistArt(a.name), a.name)}<b>${sourceTitle(a.name,artistSources(a.name))}</b><span class="muted">${plural(a.songs, "song")}</span></a>`).join("") + moreTile("#artists", "All artists"))
    + row("Songs", songs.map((s) => `<button class="tile sq song" data-id="${s.t.id}">${art(albumArt(s.t), albumName(s.t) || s.t.title)}<b>${sourceTitle(s.t.title,sourcesForTrack(s.t))}</b><span class="muted">${esc(artistLine(s.t))}</span></button>`).join("") + moreTile("#recent", "All songs"))
    + row("Playlists", pls.map((x) => playlistTile(x.p)).join("") + moreTile("#playlists", "All playlists"));
  view = { ids: songs.map((s) => s.t.id), label: "Home", pl: null };
}

// Recently added > Songs: every song as a tile, newest first
function songList(el) {
  const l = tracks.filter(match).sort((x, y) => y.created_at - x.created_at);
  view = { ids: l.map((t) => t.id), label: "Recently added", pl: null };
  el.innerHTML = l.length ? songTiles(l) : empty("Nothing matches your search.");
}

// A persistent player lives in index.html. The separate telemetry document
// receives display-only rows and sends explicit, origin-checked play/navigation
// messages to this existing player. No iframe is allowed to own audio.
function telemetryRankRows(tab,sub,sort='most'){
  const field=tab;
  if(tab==='top' && sub==='telemetry')return [];
  if(tab==='top'||sub==='songs'){
    let rows=(tab==='top'?tracks:reactedSongPool()).filter(match);
    const totals=tab==='top'?null:peerRankingTotals();
    const score=t=>tab==='top'?(Number(t.plays)||0):chartScore(t,field,totals);
    if(tab!=='top')rows=rows.filter(t=>score(t)>0);
    rows.sort((a,b)=>(sort==='least'?score(a)-score(b):score(b)-score(a))||(Number(b.created_at)||0)-(Number(a.created_at)||0));
    rows=rows.slice(0,LIMIT[tab]);
    view={ids:rows.map(t=>t.id),label:TABS[tab],pl:null};
    return rows.map(t=>({kind:'song',id:t.id,title:t.title,subtitle:artistLine(t),
      cover:albumArt(t),score:score(t),scoreLabel:tab==='top'?'plays':field}));
  }
  noView();
  if(sub==='artists')return Object.keys(entity.artist).map(name=>({name,score:Number(entity.artist[name]?.[field])||0}))
    .filter(r=>r.score>0&&(!query||r.name.toLowerCase().includes(query)))
    .sort((a,b)=>(sort==='least'?a.score-b.score:b.score-a.score)||String(a.name||'').localeCompare(String(b.name||''))).slice(0,LIMIT[tab])
    .map(r=>({kind:'artist',title:r.name,id:r.name,cover:artistArt(r.name),score:r.score,scoreLabel:field}));
  return allRatedPlaylists().map(p=>({p,score:Number(ecount('playlist',p.id)[field])||0}))
    .filter(r=>r.score>0&&(!query||r.p.name.toLowerCase().includes(query)))
    .sort((a,b)=>(sort==='least'?a.score-b.score:b.score-a.score)||String(a.p.name||'').localeCompare(String(b.p.name||''))).slice(0,LIMIT[tab])
    .map(r=>({kind:'playlist',id:r.p.id,title:r.p.name,cover:playlistCoverUrl(r.p),
      subtitle:r.p.username?`By ${r.p.username}`:'WASP',score:r.score,scoreLabel:field}));
}
// Most starred is driven by real five-star votes, not the old thumbs-up counts.
// Keep a short client-side snapshot to avoid repeated Cloudflare D1 reads while
// switching Songs / Artists / Playlists. No voter identities are requested.
const starRankingCache=new Map();
async function refreshStarRankings(el,sub,sort='most'){
  sort=sort==='least'?'least':'most';
  if(!el||!['songs','artists','playlists'].includes(sub))return;
  const type={songs:'track',artists:'artist',playlists:'playlist'}[sub];
  const cacheKey=type+':'+sort;
  let cached=starRankingCache.get(cacheKey);
  if(!cached||Date.now()-cached.at>15000){
    try{
      const res=await fetch('/api/stars/rankings?type='+encodeURIComponent(type)+'&sort='+sort,{cache:'no-store'});
      if(!res.ok)throw Error('Star rankings unavailable');
      const data=await res.json();cached={at:Date.now(),rows:Array.isArray(data.items)?data.items:[]};starRankingCache.set(cacheKey,cached);
    }catch(e){
      const current=parse();if(current.a==='stars'&&(current.arg.split('/')[0]||'songs')===sub){
        const frame=el.querySelector(':scope > iframe.wasp-telemetry-frame');
        if(frame)frame.contentWindow?.postMessage({type:'wasp:telemetry-data',mode:'stars',sub,query,items:[],error:'Unable to load star rankings; please retry.'},location.origin);
      }
      return;
    }
  }
  const current=parse();if(current.a!=='stars'||(current.arg.split('/')[0]||'songs')!==sub)return;
  let rows=[];
  for(const r of cached.rows){
    const key=String(r.key||'');if(!key)continue;
    let item;
    if(type==='track'){
      const t=byId[key]||peerTrackLookup.get(key)||tracks.find(x=>x.id===key);
      if(!t||query&&!(`${t.title} ${artistLine(t)} ${albumName(t)}`.toLowerCase().includes(query)))continue;
      item={kind:'song',id:t.id,title:t.title,subtitle:artistLine(t),cover:albumArt(t)};
    }else if(type==='artist'){
      if(query&&!key.toLowerCase().includes(query))continue;
      item={kind:'artist',id:key,title:key,subtitle:'Artist',cover:artistArt(key)};
    }else{
      const p=lookupReactedPlaylist(key);
      if(!p||query&&!p.name.toLowerCase().includes(query))continue;
      item={kind:'playlist',id:p.id,title:p.name,subtitle:p.username?`By ${p.username}`:'WASP playlist',cover:playlistCoverUrl(p)};
    }
    rows.push({...item,score:Number(r.score)||0,scoreLabel:'stars',average:Number(r.average)||0,votes:Number(r.votes)||0});
  }
  if(type==='track')view={ids:rows.map(r=>r.id),label:TABS.stars,pl:null};else noView();
  const frame=el.querySelector(':scope > iframe.wasp-telemetry-frame');
  if(frame)frame.contentWindow?.postMessage({type:'wasp:telemetry-data',mode:'stars',sub,query,items:rows},location.origin);
}
function sendTelemetryRows(frame,tab,sub,sort='most'){
  if(!frame?.contentWindow)return;
  frame.contentWindow.postMessage({type:'wasp:telemetry-data',mode:tab,sub,
    query,items:tab==='stars'?[]:telemetryRankRows(tab,sub,sort)},location.origin);
}
function renderTelemetryMount(el,tab,sub){
  // Preserve the already-loaded feature document when changing telemetry tabs.
  // The parent audio player is never removed or re-instantiated.
  const existing=el.querySelector(':scope > iframe.wasp-telemetry-frame');
  if(existing){sendTelemetryRows(existing,tab,sub);return;}
  const frame=document.createElement('iframe');
  frame.className='wasp-telemetry-frame';frame.title='WASP HIVE Telemetry and charts';
  frame.setAttribute('referrerpolicy','same-origin');
  frame.setAttribute('loading','lazy');
  frame.style.height='540px';
  // Build the same-origin feature view only after the navigation actually opens it.
  frame.src='/telemetry.html?v=18.1.5d';
  el.replaceChildren(frame);
  noView();
  frame.addEventListener('load',()=>sendTelemetryRows(frame,tab,sub));
}
window.addEventListener('message',event=>{
  const frame=document.querySelector('#list .wasp-telemetry-frame');
  if(!frame||event.source!==frame.contentWindow||event.origin!==location.origin)return;
  const data=event.data;
  if(!data||typeof data!=='object'||typeof data.type!=='string')return;
  if(data.type==='wasp:telemetry-ready'){
    const {a,arg}=parse();
    if(a==='top'||RX.includes(a)){const sub=arg.split('/')[0]||(a==='top'?'ranked':'songs');if(a==='stars')void refreshStarRankings(document.querySelector('#list'),sub);else sendTelemetryRows(frame,a,sub);}
  } else if(data.type==='wasp:telemetry-rank-sort'){
    const {a,arg}=parse(),sub=arg.split('/')[0]||'songs';
    if(['stars','hearts'].includes(a)&&['songs','artists','playlists'].includes(sub)){
      const sort=data.sort==='least'?'least':'most';
      if(a==='stars')void refreshStarRankings(document.querySelector('#list'),sub,sort);
      else sendTelemetryRows(frame,a,sub,sort);
    }
  } else if(data.type==='wasp:telemetry-height'){
    const h=Number(data.height);
    if(Number.isFinite(h))frame.style.height=Math.max(250,Math.min(15000,h+8))+'px';
  } else if(data.type==='wasp:telemetry-play'){
    const id=String(data.id||'');
    if(byId[id])play(id); // Never create a second audio element.
  } else if(data.type==='wasp:telemetry-navigate'){
    const allowed=/^#(?:artist|album|playlist|top|hearts|stars)(?:\/[^?#]*)?$/;
    if(typeof data.href==='string'&&data.href.length<=500&&allowed.test(data.href))location.hash=data.href;
  }
});

// Most listened / hearted / liked / disliked
function listView(el, tab) {
  let l = (tab === "top" ? tracks : reactedSongPool()).filter(match), extra;
  if (tab === "top") { l.sort((x, y) => y.plays - x.plays || y.created_at - x.created_at); extra = (t) => plural(t.plays, "play"); }
  else {
    const totals=peerRankingTotals(), score=t=>chartScore(t,tab,totals);
    l = l.filter((t) => score(t) > 0).sort((x, y) => score(y) - score(x) || y.created_at - x.created_at);
    extra = (t) => plural(score(t), tab.slice(0, -1));
  }
  l = l.slice(0, LIMIT[tab]);
  view = { ids: l.map((t) => t.id), label: TABS[tab], pl: null };
  const head = tab === "top" ? "" : `<p class="muted" style="margin:0 0 12px">Top ${LIMIT[tab]} ${TABS[tab].toLowerCase()}</p>`;
  el.innerHTML = l.length ? head + songTiles(l, extra)
    : empty(tab === "top" ? "Nothing matches your search." : "Nothing here yet. Songs show up once someone reacts to them.");
}

// Read-only community listening timeline. No usernames or IP addresses are shared.
function listenKey(event){
  const origin=registeredPeerOrigin(event.origin||event.source_server||location.origin);
  return origin+'|'+(event.remote_id||event.track_id||'');
}
function relativeListenTime(playedAt,now=Date.now()){
  const t=Number(playedAt);
  if(!Number.isFinite(t)||t<=0)return 'Time unknown';
  const seconds=Math.max(0,Math.floor((now-t)/1000));
  if(seconds<60)return 'Just now';
  const mins=Math.floor(seconds/60);
  if(mins<60)return mins===1?'1 min ago':mins+' mins ago';
  const hrs=Math.floor(mins/60);
  if(hrs<24)return hrs===1?'1 hr ago':hrs+' hrs ago';
  const days=Math.floor(hrs/24);
  if(days<30)return days===1?'1 day ago':days+' days ago';
  const months=Math.floor(days/30);
  if(months<12)return months===1?'1 month ago':months+' months ago';
  const years=Math.floor(days/365);
  return years<=1?'1 year ago':years+' years ago';
}
function updateRelativeListenTimes(){
  if(parse().a!=='listened')return;
  document.querySelectorAll('#list .recent-played-at[data-played-at]').forEach(el=>{
    el.textContent=relativeListenTime(el.dataset.playedAt);
    el.setAttribute('aria-label','Last played '+el.textContent);
  });
}
function normalizeLiveStream(row,server){
  if(!row?.track_id)return null;
  const origin=registeredPeerOrigin(row.origin||server);
  return {origin,track_id:String(row.track_id),started_at:Number(row.started_at)||0,
    listeners:Math.max(1,Number(row.listeners)||1)};
}
// Consolidate identical songs sourced from more than one server. The list is
// capped to 30 ONLY after merging; listener totals are independent of this cap.
function summarizeLiveStreams(sources){
  const songs=new Map();
  let listenerCount=0,partial=false;
  for(const source of sources){
    partial ||= source.partial;
    if(!source.liveOk)continue;
    listenerCount+=source.listenerCount;
    partial ||= source.partial;
    for(const row of source.live){
      const stream=normalizeLiveStream(row,source.origin);
      if(!stream)continue;
      const key=listenKey(stream);
      const old=songs.get(key);
      if(old){old.started_at=Math.max(old.started_at,stream.started_at);old.listeners+=stream.listeners;}
      else songs.set(key,{...stream,key});
    }
  }
  return {listenerCount,partial,tracks:[...songs.values()].sort((a,b)=>
    b.started_at-a.started_at||a.key.localeCompare(b.key)).slice(0,MAX_CURRENTLY_STREAMING),
    keys:new Set(sources.flatMap(source=>(source.liveKeys||source.live)
      .map(row=>normalizeLiveStream(row,source.origin)).filter(Boolean).map(stream=>listenKey(stream))))};
}
async function refreshRecentListens(){
  if(recentBusy||document.hidden)return;
  recentBusy=true;
  try{
    const peers=arr(await (await fetch('/api/network/peers',{cache:'no-store'})).json());
    peers.forEach(registerPeerRelay);
    const sources=[{base:'',origin:location.origin},...peers.map(p=>({base:p.relay_base||p.url,origin:p.url}))];
    const responses=await Promise.all(sources.map(async source=>{
      const get=async path=>{
        try{
          const r=await fetch(source.base+path,{cache:'no-store',signal:AbortSignal.timeout(6500)});
          return r.ok?await r.json():null;
        }catch{return null;}
      };
      const [events,liveRaw]=await Promise.all([get('/api/recent-listens'),get('/api/active-streams?summary=1')]);
      
      // Older WASP peers still return the legacy array. Their count is only a
      // lower bound; mark the displayed total with a + until they upgrade.
      const legacy=Array.isArray(liveRaw);
      const live=legacy?liveRaw:arr(liveRaw?.tracks);
      return {events:arr(events).map(e=>({...e,source_server:source.origin})),
        origin:source.origin,live,liveKeys:legacy?live:arr(liveRaw?.keys).length?arr(liveRaw.keys):live,
        liveOk:liveRaw!==null,partial:legacy||liveRaw===null,
        listenerCount:legacy?live.length:Math.max(0,Number(liveRaw?.listener_count)||0)};
    }));
    const all=responses.flatMap(x=>x.events);
    // A peer listen forwarded to its source server can produce two events.
    const seen=new Set();recentListens=all.sort((x,y)=>Number(y.played_at)-Number(x.played_at)).filter(x=>{
      const key=listenKey(x)+'|'+Math.round(Number(x.played_at)/15000);
      if(seen.has(key))return false;seen.add(key);return true;
    }).slice(0,50);
    const live=summarizeLiveStreams(responses);
    activeListeningKeys=live.keys;
    activeStreamTracks=live.tracks;
    activeListenerCount=live.listenerCount;
    activeListenerCountPartial=live.partial;
    if(parse().a==='listened'){recentListView($('#list'));markRows();}
  }catch{}finally{recentBusy=false;}
}
function activeStreamSong(row){
  const server=registeredPeerOrigin(row.origin);
  const id=row.track_id;
  const t=server===location.origin
    ? byId[id]||tracks.find(t=>!t.origin&&t.id===id)
    : peerTrackLookup.get(server+'|'+id)||byId[server+'|'+id]||tracks.find(t=>t.origin&&registeredPeerOrigin(t.origin)===server&&(t.remote_id||t.id)===id);
  const recent=recentListens.find(e=>listenKey(e)===row.key);
  return {row,t,title:t?.title||recent?.title||'Unknown song',
    artist:t?artistLine(t):recent?.artist||'Unknown artist',
    cover:t?albumArt(t):recent?.cover_url||''};
}
function liveSongCard(data){
  const {row,t,title,artist,cover}=data;
  const count=row.listeners>1?` title="${row.listeners} active playback sessions"`:'';
  return `<${t?'button':'div'} class="tile sq song live-track"${t?` data-id="${esc(t.id)}"`:''}>${art(cover,title)}
    <b>${esc(title)}</b><span class="muted">${esc(artist)}</span>
    <span class="live-track-status"${count}><img src="/streaming.png" alt="" aria-hidden="true">Streaming</span></${t?'button':'div'}>`;
}
function listenerBadge(){
  const label=activeListenerCount.toLocaleString()+ (activeListenerCountPartial?'+':'');
  const explanation=activeListenerCountPartial?'At least ':' ';
  return `<span class="live-listeners" role="status" aria-label="${explanation.trim()}${activeListenerCount} active playback sessions" title="${activeListenerCountPartial?'At least ':' '}${activeListenerCount} active playback sessions across connected WASP servers${activeListenerCountPartial?' (a peer is running an older version)':''}"><span>${label}</span><svg aria-hidden="true" viewBox="0 0 24 24"><use href="#i-user"/></svg></span>`;
}
function liveSectionHeader(showListeners){
  return `<div class="live-section-heading"><div><h2>Currently Streaming</h2><p class="muted">Songs being played across connected WASP servers</p></div>
    <div class="live-stats">${showListeners?listenerBadge():''}<span class="live-badge">LIVE</span></div></div>`;
}
function livePreview(){
  const songs=activeStreamTracks.filter(row=>{
    if(!query)return true;
    const data=activeStreamSong(row);
    return `${data.title} ${data.artist}`.toLowerCase().includes(query);
  }).map(activeStreamSong);
  // Reserve one last cell for the overflow button when the full active list
  // doesn't fit a row. The number of cells adapts to available screen width.
  const width=Math.max(300,$('#list').clientWidth||window.innerWidth-250);
  const cols=Math.max(2,Math.floor((width+14)/(170+14)));
  const more=songs.length>cols;
  const display=more?songs.slice(0,cols-1):songs;
  const overflow=more?`<a class="live-more-tile" href="#listened/streaming" aria-label="View currently streaming"><span class="live-more-circle" aria-hidden="true"><span>•••</span></span><b>View currently streaming</b></a>`:'';
  return `<section class="live-preview" aria-label="Currently Streaming">${liveSectionHeader(false)}
    ${songs.length?`<div class="live-preview-grid" style="--live-cols:${cols}">${display.map(liveSongCard).join('')}${overflow}</div>`:
      '<p class="muted live-empty">No songs are being streamed right now.</p>'}</section>`;
}
function streamingView(){
  const songs=activeStreamTracks.filter(row=>{
    if(!query)return true;
    const data=activeStreamSong(row);
    return `${data.title} ${data.artist}`.toLowerCase().includes(query);
  }).map(activeStreamSong);
  view={ids:songs.filter(x=>x.t).map(x=>x.t.id),label:'Currently streaming',pl:null};
  return `<section class="live-full" aria-label="Currently Streaming">${liveSectionHeader(true)}
    ${songs.length?`<div class="grid s live-all-grid">${songs.map(liveSongCard).join('')}</div>`:
      '<p class="muted live-empty">No songs are being streamed right now.</p>'}
    </section>`;
}
function recentSongsGrid(){
  const l=recentListens.filter(x=>!query||`${x.title} ${x.artist} ${x.album}`.toLowerCase().includes(query));
  const resolved=l.map(event=>{
    const server=registeredPeerOrigin(event.origin||event.source_server);
    let t=tracks.find(t=>(t.origin||location.origin)===server && (t.remote_id||t.id)===(event.remote_id||event.track_id));
    if(!t)t=tracks.find(t=>!t.origin&&server===location.origin&&t.id===event.track_id);
    return {event,t};
  });
  view={ids:resolved.filter(x=>x.t).map(x=>x.t.id),label:'Recently listened',pl:null};
  return resolved.length?`<div class="grid s">${resolved.map(({event:e,t})=>{
    const cover=t?albumArt(t):e.cover_url||'';
    const info=esc(e.title||'Unknown song');
    const live=activeListeningKeys.has(listenKey(e));
    const played=Number(e.played_at)||0;
    const time=`<time class="recent-played-at muted" data-played-at="${played}" aria-label="Last played ${esc(relativeListenTime(played))}">${esc(relativeListenTime(played))}</time>`;
    const streaming=live?'<span class="recent-streaming" role="img" aria-label="Streaming now" title="Someone is listening right now"><img src="/streaming.png" alt=""></span>':'';
    return `<${t?'button':'div'} class="tile sq song" ${t?`data-id="${esc(t.id)}"`:''}>${art(cover,e.album||e.title)}<b>${info}</b><span class="muted">${esc(e.artist||'Unknown artist')}</span><div class="recent-listen-meta"><span class="muted">${plural(Number(e.plays)||1,'play')}</span>${time}${streaming}</div></${t?'button':'div'}>`;
  }).join('')}</div>`:empty('No listening activity recorded yet.');
}
function recentListView(el){
  if(!el)return;
  const streaming=parse().arg.split('/')[0]==='streaming';
  // Keep these subtabs below the heading, as in the approved mockup, rather
  // than in the global sticky search bar.
  $('#subbar').hidden=true;
  const tabs=`<nav class="listened-tabs" aria-label="Listening activity"><a href="#listened"${streaming?'':' aria-current="page"'}>Recently listened</a><a href="#listened/streaming"${streaming?' aria-current="page"':''}>Currently streaming</a></nav>`;
  el.innerHTML=`<h1>Recently listened</h1><p class="muted" style="margin-top:0">Latest 50 confirmed plays across this WASP server and connected peers · updates every 5 seconds</p>`+
    tabs+(streaming?streamingView():livePreview()+'<div class="recent-list-divider"></div>'+recentSongsGrid());
}
setInterval(()=>{if(parse().a==='listened')refreshRecentListens();},5000);
setInterval(updateRelativeListenTimes,30000);
window.addEventListener('resize',()=>{if(parse().a==='listened' && parse().arg!=='streaming'){
  // A resize changes how many covers fit in the single-row preview.
  recentListView($('#list'));markRows();
}});
// A song with several artists is listed under each of them.
// Render a bounded first batch immediately, then append more as the viewer
// scrolls (or clicks Load more). The player and queue are never remounted.
const ARTIST_BATCH_SIZE = 48;
let artistGridObserver = null;
function releaseArtistGridObserver() {
  if (artistGridObserver) {artistGridObserver.disconnect();artistGridObserver=null;}
}
function artistGrid(el, recent) {
  releaseArtistGridObserver();
  const index=getArtistIndex();
  const searchTokens=!recent ? artistSearchTokens(query).map(normal) : [];
  let entries;
  if (recent && query) {
    // Recently added > Artists is song-search-based, unlike Artists tab's
    // artist-name search. Keep this old behavior without an N×N scan.
    const subset=buildArtistIndex(tracks.filter(match),[],artistsOf,normalizeRecording);
    entries=subset.newest;
  } else entries=recent?index.newest:index.alphabetical;
  if (searchTokens.length) entries=entries.filter(e=>searchTokens.some(token=>normal(e.name).includes(token)));
  noView();
  if (!entries.length) { el.innerHTML=empty("Nothing matches your search.");return; }
  const card=(entry)=>`<a class="tile" href="#artist/${enc(entry.name)}">${art(artistArt(entry.name),entry.name)}<b>${sourceTitle(entry.name,artistSources(entry.name))}</b><span class="muted">${plural(entry.songs,"song")}</span></a>`;
  el.innerHTML='<div class="grid artist-progressive-grid"></div><div class="artist-more-holder"><button type="button" class="btn artist-more" aria-label="Load more artists">Load more artists</button></div>';
  const grid=el.querySelector('.artist-progressive-grid');
  const holder=el.querySelector('.artist-more-holder');
  const button=holder.querySelector('button');
  let count=0;
  const addMore=()=>{
    if(!grid.isConnected)return;
    const until=Math.min(entries.length,count+ARTIST_BATCH_SIZE);
    if(until<=count)return;
    grid.insertAdjacentHTML('beforeend',entries.slice(count,until).map(card).join(''));
    count=until;
    if(count===entries.length){holder.remove();releaseArtistGridObserver();}
    else button.textContent=`Show more artists (${entries.length-count} remaining)`;
  };
  button.addEventListener('click',addMore);
  addMore();
  if(count<entries.length && typeof IntersectionObserver!=='undefined'){
    artistGridObserver=new IntersectionObserver(items=>{
      if(items.some(item=>item.isIntersecting)&&holder.isConnected)addMore();
    },{rootMargin:'240px 0px'});
    artistGridObserver.observe(holder);
  }
}

// The album name belongs to the release, not always to the track performer.
// Soundtracks and compilations are frequently credited to different artists;
// grouping only by shared artist split one record into many duplicate cards.
// Keep generic, collision-prone titles (e.g. "Greatest Hits") artist-scoped.
const albumIdentity = name => normalizeRecording(name).replace(/\b([a-z0-9]+) s\b/g,'$1s').replace(/\s+/g, ' ').trim();
const ambiguousAlbum = name => /^(greatest hits|the greatest hits|best of|the best of|live|singles|unknown album|demo|unplugged|collection|the collection|essentials)$/i.test(albumIdentity(name));
function buildAlbums(ts) {
  const grouped = new Map();
  for (const t of ts) {
    const name=albumName(t), key=albumIdentity(name);
    if (!key) continue;
    const bucket=grouped.get(key)||[];
    bucket.push(t); grouped.set(key,bucket);
  }
  const out=[];
  for (const group of grouped.values()) {
    // Artist overlap matters only for ambiguous titles shared by unrelated
    // releases. Most album titles, including multi-artist game soundtracks,
    // identify one record even when each track has different performers.
    let clusters=[group];
    if (ambiguousAlbum(albumName(group[0]))) {
      const parent=group.map((_,i)=>i);
      const find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));
      const owner=new Map();
      group.forEach((t,i)=>artistsOf(t).forEach(artist=>{
        const k=normalizeRecording(artist),prior=owner.get(k);
        if(prior!==undefined)parent[find(i)]=find(prior);
        else owner.set(k,i);
      }));
      const found=new Map();group.forEach((t,i)=>{
        const k=find(i);if(!found.has(k))found.set(k,[]);found.get(k).push(t);
      });
      clusters=[...found.values()];
    }
    for (const songs of clusters) {
      const counts=new Map();
      songs.forEach(t=>{const artist=primaryArtist(t);counts.set(artist,(counts.get(artist)||0)+1);});
      const [artist,count]=[...counts].sort((a,b)=>b[1]-a[1])[0];
      // Preserve the credited artist when it owns the majority of the record.
      const displayArtist=counts.size>1 && count <= songs.length/2?'Various Artists':artist;
      out.push({name:albumName(songs[0]),artist:displayArtist,tracks:songs});
    }
  }
  return out;
}

function albumGrid(el) {
  const l=buildAlbums(tracks.filter(match)).sort((x,y)=>latest(y.tracks)-latest(x.tracks)||x.name.localeCompare(y.name));
  noView();
  el.innerHTML=l.length?`<div class="grid s">${l.map(al=>
    `<a class="tile sq" href="#album/${enc(al.artist)}/${enc(al.name)}">${art(albumArt(al.tracks[0]),al.name)}<b>${esc(al.name)}</b><span class="muted">${esc(al.artist)}</span></a>`).join('')}</div>`
    :empty('No albums yet. Albums appear when songs have an album tag.');
}

function albumPage(el, artist, album) {
  // Resolve using the same grouping as the album grid, so opening a
  // soundtrack includes its other performers, not just the tile's artist.
  const wanted=albumIdentity(album);
  const group=buildAlbums(tracks).find(x=>albumIdentity(x.name)===wanted &&
    normalizeRecording(x.artist)===normalizeRecording(artist));
  const l=(group?.tracks||[]).slice().sort(byTrack);
  if(!l.length){el.innerHTML=`<a class="back" href="#recent/albums">← Albums</a>`+empty('Album not found.');noView();return;}
  view={ids:l.map(t=>t.id),label:group.name,pl:null};
  el.innerHTML=`<a class="back" href="#recent/albums">← Albums</a>
    <div class="hero">${art(albumArt(l[0]),group.name)}<div><h1>${esc(group.name)}</h1><span class="muted">${esc(group.artist)} · ${plural(l.length,'song')}</span>${actions()}</div></div>
    ${l.map((t,i)=>row(t,numLabel(t,i,l))).join('')}`;
}

function artistPage(el, name) {
  // A peer-only artist can also arrive through a public playlist or a copied
  // track reference, even when deduplication hides its catalogue entry.
  let ts = getArtistIndex().tracksByNormalized.get(normalizeRecording(name)) || [];
  if (!ts.length) ts = [...peerTrackLookup.values()].filter((t) => artistsOf(t).some(a=>normalizeRecording(a)===normalizeRecording(name)));
  if (!ts.length) { el.innerHTML = `<a class="back" href="#artists">← All artists</a>` + empty("Artist not found."); noView(); return; }
  const groups = dict();
  ts.forEach((t) => (groups[albumName(t)] ??= []).push(t));
  const names = Object.keys(groups).sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  const ids = [];
  const body = names.map((g) => {
    const l = groups[g].sort(byTrack);
    l.forEach((t) => ids.push(t.id));
    return `<section><h2 class="sec">${art(albumArt(l[0]), g || "S")}${esc(g || "Singles")} <span class="muted" style="font-size:14px;font-weight:400">${plural(l.length, "song")}</span><button class="album-add" data-album-ids="${esc(l.map(t=>t.id).join(","))}" title="Add entire album to playlist">＋</button></h2>${rowHeading()}${l.map((t, i) => row(t, g ? numLabel(t, i, l) : i + 1)).join("")}</section>`;
  }).join("");
  view = { ids, label: name, pl: null };
  const albums = names.filter((g) => g).length;
  el.innerHTML = `<a class="back" href="#artists">← All artists</a>
    <div class="hero">${art(artistArt(name), name, "round")}<div><h1>${sourceTitle(name,artistSources(name))}</h1><span class="muted">${plural(ts.length, "song")}${albums ? " · " + plural(albums, "album") : ""}<span id="genre"></span></span>${actions(true, { type: "artist", key: name })}</div></div>
    <div class="tabs" id="atabs" role="group" aria-label="About ${esc(name)}"></div><div class="apanel" id="apanel" aria-live="polite"></div>${body}`;
  artistView = { name, tab: "bio", bio: undefined, similar: undefined };
  paintArtist();
  loadBio(name); loadSimilar(name);
}
let artistView = null;
const genreLine = (g) => g.slice(0, 3).map((x) => x.replace(/\b\p{L}/gu, (c) => c.toUpperCase())).join(", ");
const genreCache = {};
// A peer's tracks are playable here, but they are not files hosted by this server.
// Keep this distinction on both Similar Artists views (including the full page).
function artistAvailability(name) {
  const wanted=normalizeRecording(name);
  const catalogue=[...tracks,...peerTrackLookup.values()];
  let peer=null;
  for (const track of catalogue) {
    const matched=artistsOf(track).find(a=>normalizeRecording(a)===wanted);
    if (!matched) continue;
    if (!track.origin || track.origin===primaryPeerOrigin) return {kind:"local", name:matched, origin:track.origin||null};
    if (!peer) peer={kind:"peer",name:matched,origin:track.origin};
  }
  return peer || {kind:"absent",name,origin:null};
}
// tabs: Biography first; Lineup only for bands; Similar artists last
function paintArtist() {
  const v = artistView;
  if (!v || !$("#atabs")) return;
  const tabs = [["bio", "Biography"], ...(v.bio && v.bio.kind === "band" ? [["lineup", "Lineup"]] : []), ["similar", "Similar artists"]];
  if (!tabs.some(([k]) => k === v.tab)) v.tab = "bio";
  $("#atabs").innerHTML = tabs.map(([k, label]) => `<button type="button" class="tab" data-atab="${k}" aria-pressed="${k === v.tab}">${label}</button>`).join("");
  let html = "";
  if (v.tab === "bio") {
    html = v.bio === undefined ? `<p class="muted">Loading biography…</p>` : v.bio && v.bio.text
      ? `<p class="bio">${esc(v.bio.text)} <a href="${esc(v.bio.url)}" target="_blank" rel="noopener">${esc(v.bio.source)}</a></p>` : `<p class="muted">No biography found for this artist.</p>`;
  } else if (v.tab === "lineup") {
    const m = (v.bio && v.bio.members) || [];
    if (m.some((p) => !("image" in p)) && !v.lineupAsked) { v.lineupAsked = true; loadLineup(v.name); }
    html = m.length ? `<div class="sim">${m.map(memberTile).join("")}</div><p class="muted" style="font-size:13px">Current members, from Wikipedia. Pictures from Wikipedia or Deezer when available.</p>` : `<p class="muted">No lineup information found.</p>`;
  } else {
    const list = v.similar;
    if (list === undefined) html = `<p class="muted">Loading similar artists…</p>`;
    else if (!list.length) html = `<p class="muted">No similar artists found.</p>`;
    else {
      const more = list.length > 10, shown = more ? list.slice(0, 9) : list;
      html = `<div class="sim">${shown.map((s) => simTile(s)).join("")}${more ? `<a class="simtile" href="#similar/${enc(v.name)}"><span class="art round dots" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></span><b>Show more</b><span class="muted">${list.length - 9} more</span></a>` : ""}</div>`;
    }
  }
  $("#apanel").innerHTML = html;
}
const memberTile = (p) => {
  const inner = `${art(p.image || "", p.name, "round")}<b>${esc(p.name)}</b>${p.role ? `<span class="muted">${esc(p.role)}</span>` : ""}`;
  return p.url ? `<a class="simtile" href="${esc(p.url)}" target="_blank" rel="noopener" title="Open on Wikipedia">${inner}</a>` : `<div class="simtile">${inner}</div>`;
};
function artistInfoEndpoints(name, endpoint) {
  const local = `${endpoint}?name=${enc(name)}`;
  const origins = [...new Set(tracks.filter(t => t.origin && artistsOf(t).includes(name)).map(t => t.origin))];
  const remote = origins.map(origin => peerResourceUrl(origin, local));
  const hasLocal = tracks.some(t => !t.origin && artistsOf(t).includes(name));
  return hasLocal ? [local, ...remote] : [...remote, local];
}
async function fetchArtistInfo(name, endpoint) {
  for (const url of artistInfoEndpoints(name, endpoint)) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
      if (r.ok) return await r.json();
    } catch { /* try another connected source */ }
  }
  return null;
}
async function loadLineup(name) {
  let members = null;
  const details = await fetchArtistInfo(name, "/api/lineup");
  if (details) members = arr(details.members);
  if (!members || !artistView || artistView.name !== name || !artistView.bio) return;
  artistView.bio.members = members;
  paintArtist();
}
function simTile(s, big) {
  const available=artistAvailability(s.name);
  const image = available.kind!=="absent" ? artistArt(available.name,available.origin) : s.image || "";
  const label=available.kind==="local" ? "In your library" : available.kind==="peer" ? "Peer Library" : "Not in the library";
  const inner=`${art(image,s.name,"round")}<b>${sourceTitle(s.name,artistSources(s.name))}</b><span class="muted">${label}</span>`;
  return available.kind!=="absent"
    ? `<a class="${big ? "tile" : "simtile"}" href="#artist/${enc(available.name)}" title="Open ${esc(available.name)}">${inner}</a>`
    : `<button type="button" class="${big ? "tile" : "simtile"}" data-req="${esc(s.name)}" title="Request this artist">${inner}</button>`;
}
async function loadBio(name) {
  let b = null;
  b = await fetchArtistInfo(name, "/api/bio");
  const cur = parse();
  if (!artistView || artistView.name !== name || cur.a !== "artist" || dec(cur.arg) !== name) return; // the page changed while we waited
  artistView.bio = b;
  if (b && b.genres && b.genres.length) { genreCache[name] = b.genres; const g = $("#genre"); if (g) g.textContent = " · " + genreLine(b.genres); }
  paintArtist();
}
// The full Similar Artists page must use the same Docker peer relay as the
// artist detail panel. An empty answer is not final: another peer may have a
// populated recommendation cache even if the first source has none.
async function fetchSimilarArtists(name) {
  for (const url of artistInfoEndpoints(name,"/api/similar")) {
    try {
      const r=await fetch(url,{signal:AbortSignal.timeout(11000)});
      if (!r.ok) continue;
      const items=arr((await r.json()).artists).filter(x=>x&&typeof x.name==="string"&&x.name.trim());
      if (items.length) return items;
    } catch { /* retry using the next connected peer */ }
  }
  return [];
}
async function loadSimilar(name) {
  const list=await fetchSimilarArtists(name);
  if (!artistView || artistView.name !== name) return;
  artistView.similar=list;
  paintArtist();
}
// the page with every similar artist
async function similarPage(el, name) {
  noView();
  const back = `<a class="back" href="#artist/${enc(name)}">← Back to artist</a>`;
  el.innerHTML = `${back}<h1 style="margin:0 0 4px">Similar to ${esc(name)}</h1><p class="muted">Loading…</p>`;
  const list=await fetchSimilarArtists(name);
  const cur = parse();
  if (cur.a !== "similar" || dec(cur.arg) !== name) return;
  el.innerHTML = `${back}<h1 style="margin:0 0 4px">Similar to ${esc(name)}</h1><p class="muted" style="margin-top:0">${plural(list.length, "artist")}. Local and peer artists open their artist pages; unavailable artists can be requested.</p>`
    + (list.length ? `<div class="grid">${list.map((s) => simTile(s, true)).join("")}</div>` : empty("No similar artists found."));
}

// Radio: 30+ songs from the same genre (from your library), starting with a song by this artist
async function startRadio(name) {
  let genres = {};
  try { genres = await (await fetch("/api/genres")).json(); } catch {}
  genres = { ...genres, ...genreCache };
  const { ids, matched } = radioIds(tracks, genres, name);
  if (!ids.length) return;
  startQueue(ids, ids[0], `Radio · ${name}`, null, "radio");
  if (!matched) popup("Radio is mixing your whole library", `We don't have genre information for ${name} yet, or nothing else in the library matches it, so this radio mixes songs from everywhere.`);
}
// "Surprise me" on the front-page slider: a random song and 9 more that follow its genre
async function surpriseMe() {
  if (!tracks.length) return;
  let genres = {};
  try { genres = await (await fetch("/api/genres")).json(); } catch {}
  genres = { ...genres, ...genreCache };
  const known = (t) => artistsOf(t).some((a) => (genres[a] || []).length);
  const withGenre = tracks.filter(known), pool = withGenre.length ? withGenre : tracks;
  const first = pool[Math.floor(Math.random() * pool.length)];
  const seed = artistsOf(first).find((a) => (genres[a] || []).length) || primaryArtist(first);
  const { ids } = radioIds(tracks, genres, seed, { target: 10, min: 10, seedCount: 1, first });
  startQueue(ids, ids[0], `Surprise mix · ${genreLine(genres[seed] || []) || "random songs"}`, null, "radio");
}
const adStats = () => {
  const sum = (k) => tracks.reduce((n, t) => n + (t[k] || 0), 0), out = {};
  if (sum("hearts")) out["heart-count"] = sum("hearts").toLocaleString();
  if (sum("likes")) out["like-count"] = sum("likes").toLocaleString();
  out["song-count"] = tracks.length.toLocaleString();
  return out;
};
window.addEventListener("message", (e) => { // the slider (a sandboxed frame) asks the app to play something
  const f = document.querySelector(".spframe");
  if (f && e.source === f.contentWindow && e.data && (e.data.type === "ad:shuffle" || e.data.type === "wasp:featured-shuffle")) surpriseMe();
});

// v18.0.6: Public, anonymous HIVE Radio. Generates an ephemeral player queue,
// never writes a playlist until an authenticated user explicitly saves it.
let radioMode='artist',radioSession=null,radioKnownGenres={},radioGenresLoaded=false,radioGenresLoading=false;
let radioCount='20',radioCustomCount='20',radioArtist='',radioDecade='1980',radioSelections=new Set(),radioGenrePage=0,radioGenreWheelAt=0;
const RADIO_GENRE_PAGE_SIZE=24;
async function fetchRadioGenres(){
  if(radioGenresLoaded||radioGenresLoading)return;
  radioGenresLoading=true;
  try{const r=await fetch('/api/genres');if(r.ok){const g=await r.json();if(g&&typeof g==='object')radioKnownGenres=g;}}
  catch{}finally{radioGenresLoaded=true;radioGenresLoading=false;if(parse().a==='radio')radioPage($('#list'));}
}
function radioGenreOptions(){
  const genres=new Set();for(const t of tracks)trackGenres(t,radioKnownGenres).forEach(g=>genres.add(g));
  return [...genres].sort((a,b)=>a.localeCompare(b));
}
function radioOptions(){
  if(radioMode==='artist'){
    return `<div class="radio-artist-picker"><label class="radio-field" for="radioArtist">Artist</label><input id="radioArtist" type="search" role="combobox" aria-autocomplete="list" aria-controls="radioArtistSuggestions" aria-expanded="false" maxlength="160" value="${esc(radioArtist)}" placeholder="Search an artist" autocomplete="off" required><div id="radioArtistSuggestions" class="radio-artist-suggestions" role="listbox" aria-label="Matching artists" hidden></div></div><p class="muted radio-hint">Starts with this artist, then includes available songs from related artists where supported by HIVE metadata.</p>`;
  }
  if(radioMode==='decade')return `<label class="radio-field">Decade<select id="radioDecade"><option value="pre" ${radioDecade==='pre'?'selected':''}>Pre-1960</option>${Array.from({length:Math.floor(new Date().getFullYear()/10)*10/10-1960/10+1},(_,i)=>1960+i*10).map(y=>`<option value="${y}" ${radioDecade===String(y)?'selected':''}>${y}s</option>`).join('')}</select></label><p class="muted radio-hint">Only songs with verified release years are eligible.</p>`;
  if(radioMode==='genre'){
    const options=radioGenreOptions();const pages=Math.max(1,Math.ceil(options.length/RADIO_GENRE_PAGE_SIZE));radioGenrePage=Math.min(radioGenrePage,pages-1);
    const visible=options.slice(radioGenrePage*RADIO_GENRE_PAGE_SIZE,(radioGenrePage+1)*RADIO_GENRE_PAGE_SIZE);
    return `<fieldset class="radio-genres"><legend>Choose one or more genres</legend><div class="radio-genre-page" role="group" aria-label="Genre page ${radioGenrePage+1} of ${pages}">${visible.length?visible.map(g=>`<label class="radio-genre-pill${radioSelections.has(g)?' selected':''}"><input type="checkbox" name="radioGenre" value="${esc(g)}" ${radioSelections.has(g)?'checked':''}><span>${esc(g)}</span></label>`).join(''):'<p class="muted">No tagged genres found. Try another mode or refresh the music catalogue.</p>'}</div><div class="radio-genre-pages" role="group" aria-label="Genre pages">${Array.from({length:pages},(_,i)=>`<button type="button" class="radio-genre-dot${i===radioGenrePage?' on':''}" aria-label="Genre page ${i+1}" aria-current="${i===radioGenrePage?'page':'false'}" data-radio-genre-page="${i}"></button>`).join('')}</div></fieldset>`;
  }
  return `<p class="muted radio-hint">All-time most-played tracks from the HIVE's confirmed, deduplicated telemetry. Unavailable catalogue tracks are excluded.</p>`;
}
function radioPage(el){
  if(!el)return;
  void fetchRadioGenres();
  renderNav('radio');renderSub('',null);
  const options=[['artist','Artist'],['genre','Genre'],['decade','Decade'],['top','Top songs']];
  const ids=radioSession?.ids.filter(id=>byId[id]&&!byId[id].peer_offline)||[];
  if(ids.length)view={ids,label:radioSession.label,pl:null};else noView();
  el.innerHTML=`<section class="radio-page"><div class="radio-heading"><img src="/nav-icons/radio.png" alt="" class="radio-logo"><div><span class="eyebrow">WASP · HIVE listening</span><h1>HIVE Radio</h1><p class="muted">Build a music mix from songs currently available across your connected HIVE.</p></div></div>
    <form id="radioBuilder" class="radio-builder">
      <div class="radio-mode-row"><div class="radio-modes" role="group" aria-label="Radio selection">${options.map(([key,title])=>`<button class="radio-mode${radioMode===key?' on':''}" type="button" data-radio-mode="${key}" aria-pressed="${radioMode===key}">${title}</button>`).join('')}</div><div class="radio-selected-genres" id="radioSelectedGenres" aria-label="Selected radio genres" ${radioMode==='genre'?'':'hidden'}></div></div>
      <div class="radio-options" id="radioOptions">${radioOptions()}</div>
      <label class="radio-field radio-count">Songs in radio<select id="radioCount"><option value="20" ${radioCount==='20'?'selected':''}>20 songs</option><option value="30" ${radioCount==='30'?'selected':''}>30 songs</option><option value="50" ${radioCount==='50'?'selected':''}>50 songs</option><option value="custom" ${radioCount==='custom'?'selected':''}>Custom (up to 100)</option></select></label>
      <label class="radio-field radio-custom" id="radioCustomLabel" ${radioCount==='custom'?'':'hidden'}>Custom number<input id="radioCustom" type="number" min="1" max="100" value="${esc(radioCustomCount)}"></label>
      <button class="btn radio-generate" type="submit" id="radioGenerate">Generate radio</button>
      <p class="msg" id="radioError" role="status" aria-live="polite"></p>
    </form>
    <div class="radio-output" id="radioOutput">${radioSession?`<div class="radio-result-head"><div><h2>${esc(radioSession.label)}</h2><p class="muted">${ids.length} available songs in this temporary radio queue · ${radioSession.requested} requested</p></div><div class="radio-actions"><button class="btn" type="button" id="radioPlay" ${!ids.length?'disabled':''}>▶ Play</button><button class="btn ghost" type="button" id="radioSave" ${!ids.length?'disabled':''}>+ Save as playlist</button></div></div>${ids.length?rowHeading()+ids.map((id,i)=>row(byId[id],i+1)).join(''):empty('No available songs for this radio.')}`:''}</div>
  </section>`;
  // The selected genre chips sit beside the mode buttons and allow one-click removal.
  // All controls use the same radioSelections state and underlying checkboxes.
  const genreContainer=el.querySelector('#radioSelectedGenres');
  const paintRadioGenres=()=>{
    if(!genreContainer||radioMode!=='genre')return;
    const selections=[...radioSelections];
    genreContainer.innerHTML=selections.map(genre=>`<button type="button" class="radio-genre-chip" data-selected-genre="${esc(genre)}" aria-label="Remove ${esc(genre)} from radio"><span>${esc(genre)}</span><span class="radio-chip-x" aria-hidden="true">×</span></button>`).join('');
    genreContainer.hidden=!selections.length;
  };
  el.querySelector('#radioOptions').addEventListener('change',event=>{
    if(event.target.matches('input[name="radioGenre"]')){
      event.target.checked?radioSelections.add(event.target.value):radioSelections.delete(event.target.value);
      event.target.closest('.radio-genre-pill')?.classList.toggle('selected',event.target.checked);paintRadioGenres();
    }
  });
  genreContainer.addEventListener('click',event=>{
    const chip=event.target.closest('[data-selected-genre]');if(!chip)return;
    const genre=chip.dataset.selectedGenre;
    const input=[...el.querySelectorAll('input[name="radioGenre"]')].find(x=>x.value===genre);
    if(input){input.checked=false;input.closest(".radio-genre-pill")?.classList.remove("selected");}
    radioSelections.delete(genre);paintRadioGenres();
  });
  el.querySelector('#radioOptions').addEventListener('click',event=>{
    const dot=event.target.closest('[data-radio-genre-page]');if(!dot)return;
    radioGenrePage=Number(dot.dataset.radioGenrePage)||0;radioPage(el);
  });
  // Wheel over the genre pills moves one page per gesture. Keep normal page
  // scrolling at the first/last genre page, and throttle trackpad momentum.
  const genrePage=el.querySelector('.radio-genre-page');
  genrePage?.addEventListener('wheel',event=>{
    if(radioMode!=='genre'||event.ctrlKey)return;
    const delta=Math.abs(event.deltaY)>=Math.abs(event.deltaX)?event.deltaY:event.deltaX;
    if(!delta)return;
    const pageCount=el.querySelectorAll('[data-radio-genre-page]').length;
    const next=Math.max(0,Math.min(pageCount-1,radioGenrePage+(delta>0?1:-1)));
    if(next===radioGenrePage)return;
    const now=Date.now();
    event.preventDefault();
    if(now-radioGenreWheelAt<450)return;
    radioGenreWheelAt=now;
    radioGenrePage=next;radioPage(el);
  },{passive:false});
  paintRadioGenres();
  // Native datalist popups may open beside the input. Use an accessible, limited
  // listbox anchored directly below the search field instead.
  const artistInput=el.querySelector('#radioArtist'),artistBox=el.querySelector('#radioArtistSuggestions');
  if(artistInput&&artistBox){
    const names=[...new Set(tracks.flatMap(artistsOf).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    let matches=[],selected=-1;
    const close=()=>{artistBox.hidden=true;artistBox.innerHTML='';artistInput.setAttribute('aria-expanded','false');artistInput.removeAttribute('aria-activedescendant');selected=-1;};
    const update=(open=true)=>{
      const query=artistInput.value.trim().toLocaleLowerCase();
      if(!open||!query){close();return;}
      matches=names.filter(n=>n.toLocaleLowerCase().includes(query)).sort((a,b)=>{
        const aStart=a.toLocaleLowerCase().startsWith(query),bStart=b.toLocaleLowerCase().startsWith(query);
        return Number(bStart)-Number(aStart)||a.localeCompare(b);
      }).slice(0,8);
      if(!matches.length){close();return;}
      selected=-1;
      artistBox.innerHTML=matches.map((n,i)=>`<button type="button" class="radio-artist-option" id="radioArtistOption${i}" role="option" aria-selected="false" data-artist-option="${esc(n)}">${esc(n)}</button>`).join('');
      artistBox.hidden=false;artistInput.setAttribute('aria-expanded','true');
    };
    const choose=(n)=>{artistInput.value=n;radioArtist=n;close();artistInput.focus();};
    artistInput.addEventListener('focus',()=>update());
    artistInput.addEventListener('input',()=>{radioArtist=artistInput.value;update();});
    artistInput.addEventListener('keydown',e=>{
      if(e.key==='Escape'){if(!artistBox.hidden){e.preventDefault();close();}return;}
      if(e.key==='Enter'&&!artistBox.hidden&&selected>=0){e.preventDefault();choose(matches[selected]);return;}
      if(!['ArrowDown','ArrowUp'].includes(e.key))return;
      if(artistBox.hidden){update();if(artistBox.hidden)return;}
      e.preventDefault();selected=e.key==='ArrowDown'?(selected+1)%matches.length:(selected-1+matches.length)%matches.length;
      artistBox.querySelectorAll('[data-artist-option]').forEach((option,i)=>option.setAttribute('aria-selected',String(i===selected)));
      artistInput.setAttribute('aria-activedescendant',`radioArtistOption${selected}`);
      artistBox.querySelector(`#radioArtistOption${selected}`)?.scrollIntoView({block:'nearest'});
    });
    // Prevent input blur on pointer selection; support touchscreen and mouse.
    artistBox.addEventListener('pointerdown',e=>{if(e.target.closest('[data-artist-option]'))e.preventDefault();});
    artistBox.addEventListener('click',e=>{const option=e.target.closest('[data-artist-option]');if(option)choose(option.dataset.artistOption);});
    artistInput.addEventListener('blur',close);
  }
  el.querySelectorAll('[data-radio-mode]').forEach(b=>b.onclick=()=>{
    const f=el.querySelector('#radioBuilder');if(f){if(f.querySelector('#radioArtist'))radioArtist=f.querySelector('#radioArtist').value.trim();radioDecade=f.querySelector('#radioDecade')?.value||radioDecade;/* radioSelections persists across genre pages */}
    radioMode=b.dataset.radioMode;radioPage(el);
  });
  el.querySelector('#radioCount').onchange=e=>{radioCount=e.target.value;el.querySelector('#radioCustomLabel').hidden=radioCount!=='custom';};
  el.querySelector('#radioBuilder').onsubmit=async e=>{
    e.preventDefault();const btn=el.querySelector('#radioGenerate'),message=el.querySelector('#radioError');
    const count=radioCount==='custom'?Number(el.querySelector('#radioCustom').value):Number(radioCount);
    if(!Number.isInteger(count)||count<1||count>100){message.textContent='Custom radio size must be between 1 and 100.';return;}
    radioCustomCount=String(count);if(el.querySelector('#radioArtist'))radioArtist=el.querySelector('#radioArtist').value.trim();
    radioDecade=el.querySelector('#radioDecade')?.value||radioDecade;
    /* radioSelections persists across genre pages */
    if(radioMode==='artist'&&!radioArtist){message.textContent='Choose an artist.';return;}
    if(radioMode==='genre'&&!radioSelections.size){message.textContent='Choose at least one genre.';return;}
    btn.disabled=true;message.textContent='Selecting eligible songs from HIVE…';
    try{
      let similar=[],top=[];
      if(radioMode==='artist')similar=(await fetchSimilarArtists(radioArtist)).map(x=>x.name);
      if(radioMode==='top'){
        const response=await fetch('/api/radio/top',{cache:'no-store'});
        if(!response.ok)throw Error('All-time HIVE telemetry is unavailable. Try again later.');top=arr(await response.json());
      }
      const selection=createRadioSelection({tracks,mode:radioMode,artist:radioArtist,decade:radioDecade==='pre'?'pre':Number(radioDecade),selectedGenres:[...radioSelections],knownGenres:radioKnownGenres,similarArtists:similar,topTracks:top,count});
      const selected=radioMode==='artist'?radioArtist:radioMode==='decade'?(radioDecade==='pre'?'Pre-1960':radioDecade+'s'):radioMode==='genre'?[...radioSelections].join(' + '):'All-time top songs';
      radioSession={...selection,label:'HIVE Radio · '+selected,created:Date.now()};
      if(!selection.ids.length){radioPage(el);popup('No matching songs','No currently available HIVE tracks match this selection. Try a different artist, genre or decade.');return;}
      startQueue(selection.ids,selection.ids[0],radioSession.label,null,'radio');
      radioPage(el);
      if(selection.limited)popup('Limited HIVE availability',`You requested ${count} songs, but only ${selection.available} matching songs are available right now. You can expand HIVE by connecting more WASP servers. If you own a server, sign in and check Account Settings → Publish for contributing a server link.`);
    }catch(error){message.textContent=error.message||'Unable to generate radio.';}finally{if(btn.isConnected)btn.disabled=false;}
  };
  const play=el.querySelector('#radioPlay');if(play)play.onclick=()=>{
    const playable=radioSession?.ids.filter(id=>byId[id]&&!byId[id].peer_offline)||[];
    if(playable.length)startQueue(playable,playable[0],radioSession.label,null,'radio');
  };
  const save=el.querySelector('#radioSave');if(save)save.onclick=async()=>{
    if(requireUserForPlaylist())return;
    const p={name:('Radio · '+radioSession.label.replace(/^HIVE Radio · /,'').slice(0,42)+' · '+new Date().toLocaleDateString()+' '+makeId().slice(0,4)).slice(0,80),tracks:radioSession.ids};
    save.disabled=true;save.textContent='Saving songs…';
    try{
      const refs=await registerPlaylistTracks(p);
      const response=await postJSON('/api/user/playlists/copy',{name:p.name,tracks:refs});const data=await response.json().catch(()=>({}));
      if(!response.ok)throw Error(data.error||'Could not save your radio as a playlist.');
      await load();location.hash='#userplaylist/'+enc(data.id);popup('Playlist saved',`Saved ${refs.length} radio songs to your account. Audio files have not been copied or deleted.`);
    }catch(error){popup('Could not save radio',error.message||'Please retry.');}finally{save.disabled=false;save.textContent='+ Save as playlist';}
  };
}

// Owned playlists share one cover rendering path for details, cards, and the editor.
// A missing cover is rendered as a 3 x 3 grid of nine album artworks.
// Track removals are in-memory until Save. Navigating away or refreshing discards them.
function initOwnedTrackEditor(el,p,original){
  let draft=[...original], history=[];const toolbar=el.querySelector('#playlistDraftToolbar');
  const list=el.querySelector('#ownedTrackList'),count=el.querySelector('#playlistDraftCount');
  const undo=el.querySelector('#playlistUndo'),save=el.querySelector('#playlistCommit'),error=el.querySelector('#playlistDraftError');
  const dupButton=el.querySelector('#playlistDuplicateScan'),dupPanel=el.querySelector('#playlistDuplicatePanel');
  const changed=()=>draft.length!==original.length||draft.some((id,i)=>id!==original[i]);
  const duplicates=()=>duplicateCandidates(draft,byId);
  function paintDuplicates(){
    const groups=duplicates();dupButton.textContent=groups.length?`Possible duplicates (${groups.length})`:'Find duplicates';
    if(dupPanel.hidden)return;
    dupPanel.innerHTML=`<div class="playlist-dup-title"><h3>Possible duplicate tracks</h3><p class="muted">Suggestions only. Similar titles by overlapping artists can be different recordings. Review each before removal.</p></div>`+
      (groups.length?groups.map((g,index)=>`<div class="playlist-dup-group"><b>Group ${index+1}</b><p class="muted">${g.map(i=>`#${i+1}: ${esc(byId[draft[i]]?.title||'Unavailable')} — ${esc(artistLine(byId[draft[i]]||{}))}`).join(' · ')}</p><div class="playlist-dup-controls"><label>Candidate to remove <select aria-label="Duplicate candidate to remove">${g.map(i=>`<option value="${i}">#${i+1} ${esc(byId[draft[i]]?.title||'Track')}</option>`).join('')}</select></label><button class="btn ghost" type="button" data-dup-remove>Stage removal</button><button class="btn ghost" type="button" data-dup-undo ${history.length?'':'disabled'}>↶ Undo</button></div></div>`).join(''):'<p class="muted">No possible duplicates found in this playlist.</p>');
  }
  function stageRemoval(index){if(!Number.isInteger(index)||index<0||index>=draft.length)return;history.push({index,ref:draft[index]});if(history.length>5)history.shift();draft.splice(index,1);error.textContent='';paint();}
  function undoRemoval(){const last=history.pop();if(!last)return;draft.splice(last.index,0,last.ref);error.textContent='';paint();}
  dupButton.onclick=()=>{dupPanel.hidden=!dupPanel.hidden;dupButton.setAttribute('aria-expanded',String(!dupPanel.hidden));paintDuplicates();};
  dupPanel.onclick=e=>{if(e.target.closest('[data-dup-undo]'))return undoRemoval();if(e.target.closest('[data-dup-remove]')){const group=e.target.closest('.playlist-dup-group');stageRemoval(Number(group.querySelector('select').value));}};
  function paint(){
    list.innerHTML=draft.map((id,i)=>{
      const t=byId[id],available=t&&!t.peer_offline;
      return `<div class="owned-track-line"><button type="button" class="owned-remove" data-remove-index="${i}" title="Remove ${esc(t?.title||'track')}" aria-label="Remove ${esc(t?.title||'track')} from playlist">×</button>${available?row(t,i+1):`<div class="owned-missing-track"><span class="muted">${i+1}.</span> <span><b>${esc(t?.title||'Unavailable track')}</b>${t?.artist?`<small class="muted"> · ${esc(t.artist)}</small>`:''}${t?.album?`<small class="muted"> · ${esc(t.album)}</small>`:''} <small class="muted">Unavailable</small></span>${!t?.title||!t?.artist?`<span class="owned-recovery-inputs"><input data-recovery-title placeholder="Song title" aria-label="Song title" maxlength="200"><input data-recovery-artist placeholder="Artist" aria-label="Artist" maxlength="200"></span>`:""}<span class="owned-recovery-actions"><button type="button" class="btn ghost" data-recover="search" data-ref="${esc(id)}">Search song</button><button type="button" class="btn ghost" data-recover="request" data-ref="${esc(id)}">Request</button></span><div data-recover-result="${esc(id)}" class="muted"></div></div>`}</div>`;
    }).join('')||empty('This playlist is empty. Add music using + in the player.');
    toolbar.hidden=!changed();count.textContent=`${original.length-draft.length} removal${original.length-draft.length===1?'':'s'} pending`;
    undo.disabled=!history.length;view.ids=draft.filter(id=>byId[id]&&!byId[id].peer_offline);paintDuplicates();markRows();
  }
  list.onclick=async e=>{
    const action=e.target.closest('[data-recover]');if(action){e.preventDefault();e.stopPropagation();if(changed()){popup('Save or undo changes','Save or undo pending track removals before searching for replacements.');return;}
      const ref=action.dataset.ref,t=byId[ref],mode=action.dataset.recover;const target=action.closest('.owned-missing-track').querySelector('[data-recover-result]');
      const missingRow=action.closest('.owned-missing-track'),title=missingRow.querySelector('[data-recovery-title]')?.value.trim(),artist=missingRow.querySelector('[data-recovery-artist]')?.value.trim();if((!t?.title||!t?.artist)&&(!title||!artist)&&mode!=='reload'){target.textContent='Enter the song title and artist first. This older playlist reference has no saved metadata.';return;}
      action.disabled=true;target.textContent=mode==='search'?'Searching connected peers…':'Submitting request…';
      try{
        if(mode==='reload'){await load();render();return;}
        const call=async(payload)=>{const res=await fetch('/api/user/playlist-track-search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({playlist_id:p.id,ref,title,artist,...payload})});const j=await res.json();if(!res.ok)throw Error(j.error||'Unable to search');return j;};
        if(mode==='replace'){await call({replace:action.dataset.candidate});await load();render();return;}
        if(mode==='request'){const j=await call({request:true});target.textContent=j.in_library?'Song found in the catalogue. Use Search song.':j.requested?'Request added.':'Already requested.';return;}
        let offset=0,checked=0,reachable=0,j={candidates:[]};do{j=await call({deep:true,offset});checked+=Number(j.refreshed||0);reachable+=Number(j.reachable||0);offset=j.nextOffset;target.textContent=`Searching connected peers… ${checked}/${j.totalPeers||0}`;}while(offset!=null&&checked<100&&target.isConnected);
        if(!target.isConnected)return;
        const candidates=arr(j.candidates);target.innerHTML=`<small>Checked ${checked} connected peer(s); ${reachable} answered. Matches use catalogue metadata, not audio playback checks.</small>`+(candidates.length?candidates.map(c=>`<div>${esc(c.title)} · ${esc(c.artist)} · ${c.peer?'Peer':'Local'} <button type="button" class="btn ghost" data-recover="${c.existing?'reload':'replace'}" data-ref="${esc(ref)}" data-candidate="${esc(c.id)}">${c.existing?'Reload playlist':'Use this song'}</button></div>`).join(''):`<div>No alternate catalogue match found. Try again later or request the song.</div>`);
      }catch(e){target.textContent=e.message;}finally{action.disabled=false;}return;
    }
    const b=e.target.closest('[data-remove-index]');if(!b)return;
    e.preventDefault();e.stopPropagation();const index=Number(b.dataset.removeIndex);
    if(!Number.isInteger(index)||index<0||index>=draft.length)return;
    stageRemoval(index);
  };
  undo.onclick=undoRemoval;
  save.onclick=async()=>{
    if(!changed())return;save.disabled=true;error.textContent='';
    try{
      const r=await fetch(`/api/user/playlists/${enc(p.id)}/tracks`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({tracks:draft})});
      const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'Unable to save playlist tracks.');
      original=[...draft];history=[];paint();popup('Playlist saved','Your track removals were saved. The songs remain in their original storage.');
    }catch(e){error.textContent=e.message||'Save failed.';}finally{save.disabled=false;}
  };
  paint();
}

function albumCollage9(p) {
  const covers=[], seen=new Set();
  for (const raw of p.tracks||[]) {
    const ref=typeof raw==='object'?(raw.ref||raw.track_id||raw.id):raw;
    const t=byId[ref]||peerTrackLookup.get(ref);
    if (!t) continue;
    const u=albumArt(t);
    if (u && !seen.has(u)) {seen.add(u);covers.push({url:u,label:albumName(t)||t.title||'?'});}
    if (covers.length===9) break;
  }
  if (!covers.length) return `<span class="playlist-cover-empty" aria-label="No album artwork"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l12-2v13M9 9l12-2M5 21a4 3 0 1 0 0-6 4 3 0 0 0 0 6zm12-2a4 3 0 1 0 0-6 4 3 0 0 0 0 6z" fill="currentColor"/></svg></span>`;
  return `<span class="playlist-album-collage" aria-label="Nine album covers from playlist songs">${Array.from({length:9},(_,i)=>{const cover=covers[i%covers.length];return `<i class="album-grid-tile" data-letter="${esc(cover.label.charAt(0).toUpperCase())}"><img loading="lazy" alt="" src="${esc(cover.url)}"></i>`;}).join('')}</span>`;
}
function ownedPlaylistCover(p){
  const fallback=albumCollage9(p);
  const source=playlistCoverUrl(p);
  if(!source)return fallback;
  return `<span class="owned-cover-image"><img class="playlist-cover" loading="lazy" src="${esc(source)}" alt="${esc(p.name)} cover" onerror="this.parentElement.hidden=true;this.parentElement.nextElementSibling.hidden=false"></span><span class="owned-cover-fallback" hidden>${fallback}</span>`;
}

function openEditPlaylist(p){
  document.getElementById('editOwnedPlaylistDlg')?.remove();
  const modal=document.createElement('dialog');
  modal.id='editOwnedPlaylistDlg';modal.className='playlist-edit-dialog';
  modal.innerHTML=`<div class="playlist-edit-modal-content">
    <div class="playlist-edit-modal-header"><h2>Edit playlist</h2><button class="playlist-modal-close" type="button" id="closePlaylistEdit" aria-label="Close">×</button></div>
    <div class="playlist-edit-preview">${ownedPlaylistCover(p)}</div>
    <div class="playlist-edit-line"><div><span class="playlist-edit-label">Name</span><strong>${esc(p.name)}</strong></div><button class="btn ghost" type="button" id="changePlaylistName">Change name</button></div>
    <label class="playlist-rename hidden" id="playlistRename">New name<input id="editPlaylistName" maxlength="80" value="${esc(p.name)}"></label>
    <div class="playlist-cover-options"><strong>Playlist image</strong><p class="muted playlist-cover-note">By default, your cover displays nine album artworks in a 3 × 3 grid.</p>
      <div class="playlist-cover-choice-actions"><button type="button" class="btn ghost" id="useAlbumGrid">Use album-art grid</button><button type="button" class="btn ghost" id="chooseTrackCover" aria-expanded="false" aria-controls="playlistCoverTrackPicker">Choose from playlist tracks</button></div>
      <div id="playlistCoverTrackPicker" class="playlist-cover-track-picker hidden"><label for="playlistCoverTrackSearch">Find artwork in this playlist</label><input id="playlistCoverTrackSearch" type="search" autocomplete="off" placeholder="Search song, artist or album"><div id="playlistCoverTrackChoices" class="playlist-cover-track-choices" role="group" aria-label="Playlist track artwork"></div><p id="playlistCoverTrackSelected" class="muted" aria-live="polite"></p></div></div>
    <label class="playlist-upload-label">Upload a custom image<input type="file" id="editPlaylistCover" accept="image/jpeg,image/png,image/webp"></label>
    <label class="playlist-choice playlist-public-choice"><input type="checkbox" id="editPlaylistPublic" ${p.is_public?'checked':''}>Public playlist</label>
    <p id="editPlaylistMsg" class="msg err" role="alert"></p>
    <div class="playlist-edit-actions"><button class="btn ghost" type="button" id="cancelPlaylistEdit">Cancel</button><button class="btn" type="button" id="savePlaylist">Save changes</button></div>
    <div class="playlist-delete-zone"><p class="muted">Deleting removes only this playlist and its cover; songs and source files are never deleted.</p><button type="button" class="btn danger" id="deleteOwnedPlaylist">Delete playlist</button></div>
  </div>`;
  document.body.append(modal);modal.showModal();
  const fileInput=modal.querySelector('#editPlaylistCover');
  const preview=modal.querySelector('.playlist-edit-preview');
  const msg=modal.querySelector('#editPlaylistMsg');
  let previewUrl=null, selectedTrack=null, forceGrid=p.cover_mode==='mosaic'||!p.cover_url;
  const chooser=modal.querySelector('#playlistCoverTrackPicker');
  const search=modal.querySelector('#playlistCoverTrackSearch');
  const choices=modal.querySelector('#playlistCoverTrackChoices');
  const selectedCaption=modal.querySelector('#playlistCoverTrackSelected');
  // These are only tracks belonging to this playlist; never offer the entire
  // HIVE catalogue or a custom URL as a selected cover source.
  const coverTracks=(p.tracks||[]).map(raw=>{
    const ref=typeof raw==='object'?(raw.ref||raw.track_id||raw.id):raw;
    const track=byId[ref]||peerTrackLookup.get(ref);
    return track?{ref,track,src:albumArt(track)}:null;
  }).filter(Boolean);
  function renderChoices(){
    const q=search.value.trim().toLocaleLowerCase();
    const matches=coverTracks.filter(x=>!q||[x.track.title,x.track.artist,x.track.album].some(v=>String(v||'').toLocaleLowerCase().includes(q)));
    choices.innerHTML=matches.slice(0,72).map(x=>`<button type="button" class="playlist-cover-track-option${selectedTrack?.ref===x.ref?' selected':''}" data-cover-ref="${esc(x.ref)}" aria-pressed="${selectedTrack?.ref===x.ref}"><img src="${esc(x.src)}" loading="lazy" alt=""><span><b>${esc(x.track.title||'Untitled track')}</b><small>${esc(x.track.artist||'Unknown artist')}</small></span></button>`).join('')||'<p class="muted">No matching playlist tracks with artwork available.</p>';
    selectedCaption.textContent=matches.length>72?`Showing 72 of ${matches.length} matches. Refine your search to find another track.`:'';
  }
  function renderPreview(){
    if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;}
    if(fileInput.files[0]){previewUrl=URL.createObjectURL(fileInput.files[0]);preview.innerHTML=`<img class="playlist-cover" src="${esc(previewUrl)}" alt="Cover preview">`;return;}
    if(selectedTrack){preview.innerHTML=`<img class="playlist-cover" src="${esc(selectedTrack.src)}" alt="Selected song artwork preview">`;return;}
    preview.innerHTML=forceGrid?albumCollage9(p):ownedPlaylistCover(p);
  }
  modal.querySelector('#chooseTrackCover').onclick=()=>{
    chooser.classList.toggle('hidden');const shown=!chooser.classList.contains('hidden');
    modal.querySelector('#chooseTrackCover').setAttribute('aria-expanded',String(shown));
    if(shown){renderChoices();search.focus();}
  };
  search.oninput=renderChoices;
  choices.onclick=e=>{
    const button=e.target.closest('[data-cover-ref]');if(!button)return;
    const found=coverTracks.find(t=>t.ref===button.dataset.coverRef);if(!found)return;
    selectedTrack=found;fileInput.value='';forceGrid=false;msg.textContent='';renderChoices();renderPreview();
    selectedCaption.textContent=`Selected artwork from: ${found.track.title||'Untitled track'}`;
  };
  fileInput.onchange=()=>{if(fileInput.files[0]){selectedTrack=null;forceGrid=false;}renderChoices();renderPreview();};
  modal.querySelector('#useAlbumGrid').onclick=()=>{fileInput.value='';selectedTrack=null;forceGrid=true;renderPreview();renderChoices();};
  modal.querySelector('#changePlaylistName').onclick=()=>{modal.querySelector('#playlistRename').classList.toggle('hidden');modal.querySelector('#editPlaylistName').focus();};
  modal.addEventListener('close',()=>{if(previewUrl)URL.revokeObjectURL(previewUrl);modal.remove();},{once:true});
  modal.querySelector('#closePlaylistEdit').onclick=()=>modal.close();
  modal.querySelector('#cancelPlaylistEdit').onclick=()=>modal.close();
  modal.querySelector('#savePlaylist').onclick=async()=>{
    const save=modal.querySelector('#savePlaylist');const name=modal.querySelector('#editPlaylistName').value.trim();
    if(!name){msg.textContent='Playlist name cannot be empty.';return;}
    const file=fileInput.files[0];
    if(file&&(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>5*1024*1024)){msg.textContent='Choose a JPEG, PNG or WebP under 5 MB.';return;}
    save.disabled=true;msg.textContent='';
    try{
      let coverFile=file;
      if(selectedTrack&&!file){
        // The browser retrieves the image already displayed for this playlist
        // track and uploads only image bytes (not the audio) to WASP's existing
        // authenticated cover endpoint. A failed cross-origin art read is not
        // silently replaced by the wrong image.
        let response;
        try{response=await fetch(selectedTrack.src,{mode:'cors',credentials:'omit'});}catch{throw Error('Artwork cannot be read from this peer. Connect the peer relay or upload the artwork manually.');}
        if(!response.ok)throw Error(`Track artwork is not available (HTTP ${response.status}).`);
        const type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
        if(!['image/jpeg','image/png','image/webp'].includes(type))throw Error('Selected track has no usable JPEG, PNG or WebP artwork.');
        const blob=await response.blob();if(!blob.size||blob.size>5*1024*1024)throw Error('Selected track artwork must be under 5 MB.');
        coverFile=blob;
      }
      if(coverFile){const r=await fetch(`/api/user/playlists/${enc(p.id)}/cover`,{method:'PUT',headers:{'content-type':coverFile.type},body:coverFile});if(!r.ok)throw Error((await r.json().catch(()=>({}))).error||'Cover upload failed.');}
      const r=await fetch(`/api/user/playlists/${enc(p.id)}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({name,is_public:modal.querySelector('#editPlaylistPublic').checked,cover_mode:coverFile?'copied':forceGrid?'mosaic':'copied'})});
      if(!r.ok)throw Error((await r.json().catch(()=>({}))).error||'Unable to save.');
      modal.close();await load();location.hash='#userplaylist/'+enc(p.id);render();popup('Playlist updated','Your changes were saved.');
    }catch(e){msg.textContent=e.message||'Unable to save.';}finally{save.disabled=false;}
  };
  modal.querySelector('#deleteOwnedPlaylist').onclick=async()=>{
    const button=modal.querySelector('#deleteOwnedPlaylist');
    if(button.dataset.confirm!=='yes'){button.dataset.confirm='yes';button.textContent='Confirm: delete this playlist only';msg.textContent='Click again to permanently delete this playlist. Your music files will stay intact.';return;}
    button.disabled=true;
    try{const r=await fetch(`/api/user/playlists/${enc(p.id)}`,{method:'DELETE'});if(!r.ok)throw Error((await r.json().catch(()=>({}))).error||'Delete failed.');
      modal.close();location.hash='#user/private';await load();popup('Playlist deleted','Only the playlist was deleted. Your songs have not been affected.');
    }catch(e){msg.textContent=e.message;button.disabled=false;}
  };
}

// Resolve covers relative to the server that owns the playlist, not the viewer's
// origin. Public user playlists expose /art/user-playlist/<id>; system playlists
// expose cover_v and serve their custom cover from /art/playlist?id=<id>.
function playlistCoverUrl(p) {
  if (p.cover_mode === 'mosaic') return '';
  const raw=String(p.cover_url || p.image || '').trim();
  if (raw) {
    try {
      const u=new URL(raw,p.origin || location.origin);
      if (u.protocol === 'https:' || u.protocol === 'http:') {
        if (p.origin && (u.origin===new URL(p.origin).origin || u.pathname.startsWith('/art/')))
          return peerResourceUrl(p.origin,u.pathname+u.search);
        return u.href;
      }
    } catch {}
  }
  // Only the server-managed playlist collection uses the /art/playlist route.
  // User playlists use /art/user-playlist and supply their own cover_url.
  if (p.cover_v && !p.user_id && !p.username && p.kind !== 'user') {
    const rawId=String(p.id || '').startsWith((p.origin || '') + '|')
      ? String(p.id).slice(p.origin.length + 1) : String(p.id || '');
    const origin=p.origin || location.origin;
    return p.origin ? peerResourceUrl(p.origin,`/art/playlist?id=${enc(rawId)}&v=${enc(p.cover_v)}`) : `${origin}/art/playlist?id=${enc(rawId)}&v=${enc(p.cover_v)}`;
  }
  return '';
}
// Always leave a cover-sized fallback in the DOM. This is important for older
// peers, missing R2 objects and mixed-content-blocked HTTP artwork: the tile
// still has an image area and its hover Play control remains accessible.
function mosaic(p) {
  return ownedPlaylistCover(p);
}

// A playlist tile: the picture opens the playlist; the round play button (lower-right ninth of the picture, on hover) plays it.
function playlistTile(p, subtext) {
  const n = p.tracks.filter((i) => byId[i]).length;
  return `<div class="tile sq pltile"><div class="covwrap"><a class="covlink" href="#playlist/${enc(p.id)}" aria-label="Open ${esc(p.name)}">${mosaic(p)}</a><span class="fabcell"><button type="button" class="fab" data-playpl="${esc(p.id)}" aria-label="Play ${esc(p.name)}"><svg class="fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg></button></span></div><a class="ttl" href="#playlist/${enc(p.id)}"><b>${esc(p.name)}</b><span class="muted">${esc(subtext || plural(n, "song"))}</span></a></div>`;
}
function playlistGrid(el, recent) {
  let l = playlists.filter((p) => !query || p.name.toLowerCase().includes(query));
  if (recent) l = [...l].sort((x, y) => (y.updated_at || y.created_at) - (x.updated_at || x.created_at));
  noView();
  el.innerHTML = l.length ? `<div class="grid s">${l.map((p) => playlistTile(p)).join("")}</div>` : empty("No playlists yet.");
}

// Most hearted / liked / disliked: artists and playlists
function reactedArtists(el, tab) {
  // Entity reactions are local to this WASP host and may refer to artists
  // from connected peers. Do not require a local track or the removed libNames helper.
  const rows = Object.keys(entity.artist).map((n) => ({ n, c: entity.artist[n][tab] || 0 }))
    .filter((x) => x.c > 0 && (!query || x.n.toLowerCase().includes(query)))
    .sort((x, y) => y.c - x.c || x.n.localeCompare(y.n)).slice(0, LIMIT[tab]);
  noView();
  el.innerHTML = rows.length ? `<p class="muted" style="margin:0 0 12px">Top ${LIMIT[tab]} ${TABS[tab].toLowerCase()} artists</p><div class="grid">${rows.map((x) =>
    `<a class="tile" href="#artist/${enc(x.n)}">${art(artistArt(x.n), x.n)}<b>${esc(x.n)}</b><span class="muted">${plural(x.c, tab.slice(0, -1))}</span></a>`).join("")}</div>`
    : empty("Nothing here yet. Artists show up once someone reacts to them on their page.");
}
function allRatedPlaylists() {
  const all = new Map();
  // Prefer currently available playlists for accurate artwork and playback links.
  for (const p of ratedPlaylistCache) if (p?.id) all.set(p.id, { ...p, tracks: arr(p.tracks) });
  for (const p of [...playlists, ...userPublicPlaylists, ...peerPlaylists]) if (p?.id) all.set(p.id, p);
  return [...all.values()];
}
function lookupReactedPlaylist(key) {
  return ownedPlaylistIndex.get(key) || allRatedPlaylists().find(p=>p.id===key);
}
function reactedPlaylists(el, tab) {
  const rows = allRatedPlaylists().map((p) => ({ p, c: ecount("playlist", p.id)[tab] || 0 }))
    .filter((x) => x.c > 0 && (!query || x.p.name.toLowerCase().includes(query)))
    .sort((x, y) => y.c - x.c || x.p.name.localeCompare(y.p.name)).slice(0, LIMIT[tab]);
  noView();
  el.innerHTML = rows.length ? `<p class="muted" style="margin:0 0 12px">Top ${LIMIT[tab]} ${TABS[tab].toLowerCase()} playlists</p><div class="grid s">${rows.map((x) => playlistTile(x.p, plural(x.c, tab.slice(0, -1)))).join("")}</div>`
    : empty("Nothing here yet. Playlists show up once someone reacts to them on their page.");
}

// On playlist detail pages keep the original Heart icon + word, with
// icon-only thumbs-up and thumbs-down. All votes belong to this server.
function playlistReactControls(p) {
  const type='playlist',key=p.id,c=ecount(type,key),m=mine['p:'+key]||{};
  const heart=`<span class="rc"><button type="button" class="circ tip${m.heart?' on':''}" data-ent="playlist" data-key="${esc(key)}" data-r="heart" aria-label="Heart playlist" aria-pressed="${!!m.heart}"><svg><use href="#i-heart"/></svg></button><small>${c.hearts||0}</small></span>`;
  return `<span class="rcircles playlist-ratings" role="group" aria-label="Heart and rate playlist" data-type="playlist" data-key="${esc(key)}">${heart}${starsMarkup(type,key)}</span>`;
}

function playlistHero(p,ids,subtitle){
 // Use the same source-aware cover and failure fallback as playlist cards.
 const cover=mosaic(p);
 return `<div class="playlist-detail-hero"><div class="playlist-detail-cover">${cover}</div><h1>${esc(p.name)}</h1><p class="muted">${esc(subtitle)}</p><div class="playlist-detail-actions">${playlistReactControls(p)}<button class="btn playlist-copy" data-copy-playlist="${esc(p.id)}" title="Copy playlist to your account" aria-label="Copy playlist">＋ Copy to my playlists</button></div></div>`;
}
function playlistPage(el, id) {
  const remote=peerPlaylists.find(p=>p.id===id) || playlists.find(p=>p.id===id && p.origin) || ratedPlaylistCache.find(p=>p.id===id && p.origin);
  const user=userPublicPlaylists.find(p=>p.id===id) || ratedPlaylistCache.find(p=>p.id===id && p.kind==='user');
  if(remote||user){
    const p=remote||user;
    const ids=arr(p.tracks).map(i=>{if(!p.origin)return i;const raw=String(i);if(raw.startsWith("peer:"))return raw;const remoteId=raw.startsWith(p.origin+"|")?raw.slice(p.origin.length+1):raw;return byId[p.origin+"|"+remoteId]?p.origin+"|"+remoteId:remoteId;}).filter(i=>byId[i]);
    noView();
    const target=remote?(p.origin===primaryPeerOrigin?"server":"peer"):"users";
    el.innerHTML=`<a class="back" href="#playlists/${target}">← Playlists</a>${playlistHero(p,ids,remote?(p.origin===primaryPeerOrigin?"Server playlist":"Peer playlist"):"Public user playlist")}${ids.map((i,n)=>row(byId[i],n+1)).join("")||empty("Songs are not available from this server.")}`;
    view={ids,label:p.name,pl:p};return;
  }
  const p = playlists.find((x) => x.id === id);
  if (!p) { el.innerHTML = `<a class="back" href="#playlists">← All playlists</a>` + empty("Playlist not found."); noView(); return; }
  const l = p.tracks.map((i) => byId[i]).filter(Boolean);
  view = { ids: l.map((t) => t.id), label: `Playlist “${p.name}”`, pl: p.id };
  el.innerHTML = `<a class="back" href="#playlists">← All playlists</a>
    ${playlistHero(p,l.map(t=>t.id),plural(l.length,"song"))}
    ${l.map((t, i) => row(t, i + 1, "", true)).join("")}`;
}

// ---------- requests ----------
const KIND = { song: "Song", artist: "Artist", album: "Album", playlist: "Playlist" };
let prefill = "", flash = "", reqKind = "song", picked = null, sugg = [], active = -1, seq = 0, timer = 0;

function prefillRequest(name) { reqKind = "artist"; prefill = name; location.hash = "#request/new"; }
function popup(title, text) { $("#msgT").textContent = title; $("#msgP").textContent = text; $("#msgDlg").showModal(); $("#msgOk").focus(); }

async function requestQueue(el) {
  noView();
  el.innerHTML = `<p class="muted">Loading the queue…</p>`;
  let list = [];
  try { list = arr(await (await fetch("/api/requests")).json()); } catch {}
  const cur = parse();
  if (cur.a !== "request" || cur.arg.split("/")[0] !== "") return;
  const note = flash ? `<p class="msg" role="status">${esc(flash)}</p>` : ""; flash = "";
  const sub = (r) => r.kind === "song" ? [r.artist, r.album].filter(Boolean).join(" · ") : r.kind === "album" ? r.artist
    : r.kind === "artist" && r.matched_local!=null ? `${r.matched_local} local · ${r.matched_peer||0} on peers` : r.kind === "playlist" ? (r.total ? `Spotify playlist · ${r.total}${r.partial ? "+" : ""} songs${r.matched != null ? ` · ${r.matched_local??r.matched} already here${r.matched_peer?` · ${r.matched_peer} found in peer servers`:''}` : ""}` : "Spotify playlist") : "";
  el.innerHTML = note + (list.length ? list.map((r, i) =>
    `<div class="qline"><span class="n muted">${i + 1}</span>${art(r.image, r.title, "lg")}<span class="t">${esc(r.title)}<small>${esc(sub(r))}${r.remote?' · <span title="Requested on a connected WASP server">HIVE peer</span>':''}</small></span><span class="chip">${KIND[r.kind]}</span></div>`).join("")
    : empty(`The queue is empty. <a href="#request/new">Request something</a>.`));
}

// Previous requests: what has been added already, by kind
async function requestPrevious(el, third) {
  noView();
  const kinds = { songs: "song", albums: "album", artists: "artist", playlists: "playlist" }, names = { songs: "Songs", albums: "Albums", artists: "Artists", playlists: "Playlists" };
  const key = has(kinds, third) ? third : "songs";
  const pills = Object.entries(names).map(([k, v]) => `<a class="tab" href="#request/previous${k === "songs" ? "" : "/" + k}"${k === key ? ' aria-current="page"' : ""}>${v}</a>`).join("");
  el.innerHTML = `<div class="tabs" role="group" aria-label="Previous requests by kind" style="margin-bottom:16px">${pills}</div><p class="muted">Loading…</p>`;
  let list = [];
  try { list = arr(await (await fetch("/api/requests/history")).json()); } catch {}
  const cur = parse();
  if (cur.a !== "request" || cur.arg.split("/")[0] !== "previous") return;
  const rows = list.filter((r) => r.kind === kinds[key]);
  const lower = (s) => String(s).toLowerCase();
  const link = (r) => {
    if (r.kind === "playlist") return playlists.some((p) => p.id === r.playlist_id) ? `#playlist/${enc(r.playlist_id)}` : "";
    if (r.kind === "artist") { const n = tracks.flatMap(artistsOf).find((a) => lower(a) === lower(r.title)); return n ? `#artist/${enc(n)}` : ""; }
    if (r.kind === "album") { const t = tracks.find((x) => lower(albumName(x)) === lower(r.title)); return t ? `#album/${enc(primaryArtist(t))}/${enc(albumName(t))}` : ""; }
    return "";
  };
  const sub = (r) => r.kind === "song" ? [r.artist, r.album].filter(Boolean).join(" · ") : r.kind === "album" ? r.artist : "";
  const body = rows.length ? rows.map((r, i) => {
    const when = new Date(r.done_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    const inner = `<span class="n muted">${i + 1}</span>${art(r.image, r.title, "lg")}<span class="t">${esc(r.title)}<small>${esc(sub(r))}</small></span><span class="chip">${r.local_completion?'Completed locally':'Completed'} ${esc(when)}</span>`;
    const href = link(r);
    return href ? `<a class="qline" href="${href}" style="color:inherit;text-decoration:none">${inner}</a>` : `<div class="qline">${inner}</div>`;
  }).join("") : empty(`No ${names[key].toLowerCase()} have been added from requests yet.`);
  el.innerHTML = `<div class="tabs" role="group" aria-label="Previous requests by kind" style="margin-bottom:16px">${pills}</div>${body}`;
}

// Spotify's official search requires optional server-side API credentials.
let spotifySearchTimer=0,spotifySearchSeq=0,spotifySearchHits=[];
async function searchSpotifyPlaylists() {
  const input=$("#spotifyPlaylistSearch"), area=$("#spotifyPlaylistResults");
  if(!input||!area)return;
  const q=input.value.trim(),token=++spotifySearchSeq;
  if(q.length<2){area.innerHTML="";return;}
  area.innerHTML='<p class="muted">Searching Spotify…</p>';
  try {
    const r=await fetch("/api/spotify/search-playlists?q="+enc(q));
    const j=await r.json();
    if(token!==spotifySearchSeq||!$("#spotifyPlaylistResults"))return;
    if(!r.ok){area.innerHTML=`<p class="muted spotify-error">${esc(j.error||"Spotify search is unavailable.")}</p>`;return;}
    spotifySearchHits=Array.isArray(j)?j:[];
    area.innerHTML=spotifySearchHits.length?spotifySearchHits.map((p,i)=>
      `<button type="button" class="spotify-result" data-spotify-choice="${i}">${art(p.image,p.title)}<span class="t"><b>${esc(p.title)}</b><small>${esc(p.sub||"Spotify playlist")}</small></span></button>`).join("")
      :'<p class="muted">No matching playlists. You can still paste a link.</p>';
  } catch {if(token===spotifySearchSeq&&$("#spotifyPlaylistResults"))area.innerHTML='<p class="muted">Spotify search could not connect. Paste a link instead.</p>';}
}
$("#list").addEventListener("input",e=>{
  if(e.target.id!=="spotifyPlaylistSearch")return;
  clearTimeout(spotifySearchTimer);
  spotifySearchTimer=setTimeout(searchSpotifyPlaylists,350);
});
$("#list").addEventListener("click",e=>{
  const choice=e.target.closest("[data-spotify-choice]");
  if(!choice)return;
  const p=spotifySearchHits[Number(choice.dataset.spotifyChoice)];
  if(!p||!/^https:\/\/open\.spotify\.com\/playlist\/[A-Za-z0-9]+$/.test(p.url))return;
  $("#rq").value=p.url;onType();
  $("#spotifyPlaylistResults").innerHTML=`<p class="muted">Selected: ${esc(p.title)}</p>`;
});

function requestForm(el) {
  noView();
  const pl = reqKind === "playlist";
  el.innerHTML = `<form class="reqform" id="reqForm" autocomplete="off">
    <p class="muted" style="margin-top:0">Ask for a song, artist, album or a Spotify playlist. Requests wait in the queue until they are added.</p>
    <div class="tabs" role="group" aria-label="What are you requesting?">${Object.entries(KIND).map(([k, v]) =>
      `<button type="button" class="tab" data-kind="${k}" aria-pressed="${k === reqKind}">${v}</button>`).join("")}</div>
    ${pl ? `<div class="spotify-search-block"><label class="muted" for="spotifyPlaylistSearch">Search Spotify playlists</label>
      <input id="spotifyPlaylistSearch" type="search" autocomplete="off" placeholder="Search by playlist name or artist" maxlength="80" aria-describedby="spotifySearchHelp">
      <p id="spotifySearchHelp" class="muted">Choose a result to fill the playlist link below.</p>
      <div id="spotifyPlaylistResults" class="spotify-results" role="status" aria-live="polite"></div></div>` : ""}
    <div class="combo">
      <label for="rq" class="muted">${pl ? "Spotify playlist link" : `Search for a ${KIND[reqKind].toLowerCase()}`}</label>
      <input id="rq" type="text" ${pl ? "" : 'role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="rqList"'} placeholder="${pl ? "https://open.spotify.com/playlist/…" : "Start typing a name"}" maxlength="200" style="width:100%;margin-top:6px">
      <ul id="rqList" class="sugg hidden" role="listbox" aria-label="Suggestions"></ul>
    </div>
    <div id="rqPick"></div>
    <button class="btn" id="rqGo" type="submit" disabled>Add to queue</button>
  </form>`;
  picked = null; sugg = []; active = -1;
  if (prefill) { $("#rq").value = prefill; prefill = ""; onType(); }
}
function onType() {
  const v = $("#rq").value.trim();
  picked = null; $("#rqPick").innerHTML = "";
  if (reqKind === "playlist") { $("#rqGo").disabled = !v; return; }
  $("#rqGo").disabled = true; clearTimeout(timer);
  if (v.length < 2) { closeList(); return; }
  const my = ++seq;
  timer = setTimeout(async () => {
    let r;
    try { r = await (await fetch(`/api/suggest?type=${reqKind}&q=${enc(v)}`)).json(); } catch { r = {}; }
    if (my !== seq || !$("#rq")) return;
    sugg = Array.isArray(r) ? r : [];
    showList(sugg, Array.isArray(r) ? "No matches. Try a different spelling." : "Search is unavailable right now.");
  }, 250);
}
function showList(items, none) {
  const ul = $("#rqList"); active = -1;
  ul.innerHTML = items.length ? items.map((s, i) =>
    `<li role="option" id="rqo${i}" data-i="${i}" aria-selected="false">${art(s.image, s.title)}<span class="t">${esc(s.title)}<small>${esc(s.sub)}</small></span></li>`).join("")
    : `<li class="none" role="presentation">${esc(none)}</li>`;
  ul.classList.remove("hidden"); $("#rq").setAttribute("aria-expanded", "true");
}
function closeList() {
  const ul = $("#rqList"); if (!ul) return;
  ul.classList.add("hidden"); $("#rq").setAttribute("aria-expanded", "false"); $("#rq").removeAttribute("aria-activedescendant");
}
function setActive(i) {
  document.querySelectorAll("#rqList li[role=option]").forEach((li, k) => li.setAttribute("aria-selected", k === i));
  active = i;
  const li = $("#rqo" + i);
  if (li) { $("#rq").setAttribute("aria-activedescendant", "rqo" + i); li.scrollIntoView({ block: "nearest" }); }
}
function onKey(e) {
  if (reqKind === "playlist") return;
  const open = !$("#rqList").classList.contains("hidden") && sugg.length;
  if (e.key === "ArrowDown" && open) { e.preventDefault(); setActive((active + 1) % sugg.length); }
  else if (e.key === "ArrowUp" && open) { e.preventDefault(); setActive((active - 1 + sugg.length) % sugg.length); }
  else if (e.key === "Enter" && open && active >= 0) { e.preventDefault(); choose(active); }
  else if (e.key === "Escape") closeList();
}
function choose(i) {
  const s = sugg[i]; if (!s) return;
  picked = s; $("#rq").value = s.title; closeList();
  $("#rqPick").innerHTML = `<div class="pick">${art(s.image, s.title, "lg")}<span class="t">${esc(s.title)}<small>${esc(s.sub)}</small></span><span class="chip">${KIND[reqKind]}</span></div>`;
  $("#rqGo").disabled = false;
}
async function sendRequest() {
  const body = reqKind === "playlist" ? { kind: "playlist", url: $("#rq").value.trim() } : picked ? { kind: reqKind, id: String(picked.id) } : null;
  if (!body) return;
  const go = $("#rqGo"); go.disabled = true; go.textContent = "Adding…";
  let r, j = {};
  try {
    r = await fetch("/api/request", { method: "POST", headers: { "content-type": "application/json", "X-Visitor": vid }, body: JSON.stringify(body) });
    j = await r.json();
  } catch { r = { ok: false }; j = { error: "Couldn't reach the server. Try again." }; }
  go.textContent = "Add to queue"; go.disabled = false;
  if (r.ok) { flash = `Added to the queue${j.position ? ` — you're number ${j.position}` : ""}.`; location.hash = "#request"; return; }
  if (j.code === "in_queue") popup("Already in the queue", "This has already been requested and is waiting in the queue.");
  else if (j.code === "in_library") popup("Already in the library", "This is already here. Search for it, or look under Recently added.");
  else popup("Couldn't add your request", j.error || "Something went wrong.");
}
$("#list").addEventListener("input", (e) => { if (e.target.id === "rq") onType(); });
$("#list").addEventListener("keydown", (e) => { if (e.target.id === "rq") onKey(e); });
$("#list").addEventListener("submit", (e) => { if (e.target.id === "reqForm") { e.preventDefault(); sendRequest(); } });
$("#list").addEventListener("mousedown", (e) => { const li = e.target.closest("#rqList li[role=option]"); if (li) { e.preventDefault(); choose(+li.dataset.i); } });
document.addEventListener("click", (e) => { if (!e.target.closest(".combo")) closeList(); });
$("#msgOk").addEventListener("click", () => $("#msgDlg").close());

// ---------- playback + queue ----------
const shuffled = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const cur = () => byId[audio.dataset.id];

// A playing playlist can come from this server, a public user, or a connected peer.
// Preserve its playable track references when playback begins: remote IDs are already
// namespaced by origin, and another server may reuse the same numeric track ID.
let playlistScope = null;
function findPlaylist(pl) {
  if (!pl) return null;
  if (typeof pl === "object") return pl;
  return [...playlists, ...peerPlaylists, ...userPublicPlaylists].find(p => p.id === pl) || null;
}
function startQueue(ids, id, label, pl, kind = "") {
  const source = findPlaylist(pl);
  playlistScope = source ? {
    id: source.id,
    name: source.name,
    ids: ids.filter(trackId => !!byId[trackId]),
  } : null;
  queue = [...ids]; qLabel = label; ctxPl = pl; shufKind = kind; play(id);
}
const mediaUrl = (t, path) => (t && t.origin ? peerResourceUrl(t.origin,path) : path);
// HIVE Smart Routing: browser-observed health only; no music bytes are probed or cached.
const routingHealth=new Map();
const routeOrigin=t=>t.origin?(peerCanonicalOrigins.get(registeredPeerOrigin(t.origin))||registeredPeerOrigin(t.origin)): '';
let playbackRoute=null,routeSerial=0,routeTimer=0,routingIntent=false;
const routeClock=()=>Date.now();
function routeHealth(origin){return routingHealth.get(origin)||{};}
function routeScore(t,now=routeClock(),random=Math.random){
  const h=routeHealth(routeOrigin(t));
  const preferred=primaryPeerOrigin&&registeredPeerOrigin(t.origin)===primaryPeerOrigin?0:!t.origin?10:18;
  return preferred+(t.peer_offline?450:0)+Math.min(100,(Number(h.latency)||0)/20)+Math.min(100,(Number(h.listeners)||0)*3)+(h.failedUntil>now?180:0)+random()*26;
}
function routeCandidates(t){
  const group=routeRecordingIndex.get(routeRecordingKey(t))||routeCatalogue.get(t.id)||[t];
  const unique=new Map();for(const source of [t,...group])if(samePlayableRecording(t,source))unique.set(routeIdentity(source),source);
  // Canonical aliases of one peer must not masquerade as redundant origins.
  const candidates=new Map();for(const source of unique.values()){
    const origin=source.origin?(peerCanonicalOrigins.get(registeredPeerOrigin(source.origin))||registeredPeerOrigin(source.origin)):'';
    const key=origin+'|'+(source.remote_id||source.id);
    if(!candidates.has(key))candidates.set(key,source);
  }
  return [...candidates.values()].map(source=>({source,score:routeScore(source)})).sort((a,b)=>a.score-b.score).slice(0,6).map(x=>x.source);
}
let routeDemandLast=0,routeDemandBusy=false;
async function refreshRouteDemand(sources){
  if(sources.length<2||routeDemandBusy||routeClock()-routeDemandLast<60000)return;
  routeDemandBusy=true;routeDemandLast=routeClock();
  const origins=[...new Map(sources.filter(t=>t.origin).map(t=>[routeOrigin(t),t])).values()].slice(0,4);
  const get=async base=>{try{const r=await fetch(base+'/api/active-streams?routing=1',{signal:AbortSignal.timeout(3500),cache:'no-store'});const d=r.ok?await r.json():null;return Array.isArray(d?.sources)?d.sources:null;}catch{return null;}};
  try{
    const values=await Promise.all([get(''),...origins.map(t=>get(peerResourceUrl(t.origin,'')))]);
    const local=values[0];
    if(local){for(const t of sources){const o=routeOrigin(t),demand=local.filter(r=>(r.origin?(peerCanonicalOrigins.get(registeredPeerOrigin(r.origin))||registeredPeerOrigin(r.origin)):'')===o).reduce((n,r)=>n+Math.max(0,Number(r.listeners)||0),0);routingHealth.set(o,{...routeHealth(o),localDemand:demand,listeners:demand});}}
    origins.forEach((t,i)=>{const rows=values[i+1];if(!rows)return;const o=routeOrigin(t),h=routeHealth(o);const own=rows.filter(r=>!r.origin).reduce((n,r)=>n+Math.max(0,Number(r.listeners)||0),0);routingHealth.set(o,{...h,listeners:(h.localDemand||0)+own});});
  }finally{routeDemandBusy=false;}
}
function clearRouteTimer(){clearTimeout(routeTimer);routeTimer=0;}
function routeNotice(message){const el=$('#routeStatus');if(el)el.textContent=message;}
function routeUrl(t){return mediaUrl(t,'/audio/'+enc(t.remote_id||(t.origin&&String(t.id).startsWith(t.origin+'|')?String(t.id).slice(t.origin.length+1):t.id)));}
function armRouteTimer(route,delay=10000){
  clearRouteTimer();if(!route||!routingIntent)return;
  const serial=route.serial,attempt=route.attempt;
  routeTimer=setTimeout(()=>{if(playbackRoute?.serial===serial&&playbackRoute.attempt===attempt&&routingIntent&&!audio.ended)recoverRoute('Stream timed out');},delay);
}
function startRouteSource(route,position){
  if(playbackRoute!==route||!routingIntent)return;
  clearRouteTimer();const source=route.sources[route.index];if(!source)return;
  route.source=source;route.attempt++;route.measured=false;route.started=routeClock();route.resume=Math.max(0,Number(position)||0);route.lastTime=route.resume;
  route.loading=true;route.switching=true;const attempt=route.attempt;
  audio.src=routeUrl(source);
  const completeMetadata=()=>{
    if(playbackRoute!==route||route.attempt!==attempt||!route.loading||audio.readyState<1)return;
    if(route.resume>0){try{audio.currentTime=Math.min(route.resume,Number.isFinite(audio.duration)?Math.max(0,audio.duration-.25):route.resume);}catch{}}
    route.loading=false;
  };
  route.onMetadata=completeMetadata;
  audio.play().catch(error=>{
    if(playbackRoute!==route||route.attempt!==attempt)return;
    if(error?.name==='NotAllowedError'){routingIntent=false;clearRouteTimer();routeNotice('Press play to continue.');return;}
    if(error?.name!=='AbortError')recoverRoute('Playback source unavailable');
  });
  armRouteTimer(route);
}
function recoverRoute(reason){
  const route=playbackRoute;if(!route||!routingIntent||route.exhausted)return;
  const position=route.loading?route.resume:(audio.seeking?Number(audio.currentTime)||route.lastTime:route.lastTime);
  const origin=routeOrigin(route.source),h=routeHealth(origin);
  routingHealth.set(origin,{...h,failedUntil:routeClock()+120000});clearRouteTimer();
  if(route.index+1<route.sources.length){route.index++;routeNotice('HIVE: switching source…');startRouteSource(route,position);return;}
  // One bounded retry even if no mirror exists; never skip or loop endlessly.
  if(!route.retried){route.retried=true;routeNotice('HIVE: reconnecting…');startRouteSource(route,position);return;}
  route.exhausted=true;routingIntent=false;audio.pause();routeNotice(reason+'. Press play to retry.');
}
function beginRoute(t,position=0){
  clearRouteTimer();routingIntent=true;routeNotice('');
  playbackRoute={serial:++routeSerial,attempt:0,sources:routeCandidates(t),index:0,retried:false,exhausted:false,lastTime:position,source:null,loading:true};
  startRouteSource(playbackRoute,position);
  void refreshRouteDemand(playbackRoute.sources);
}
audio.addEventListener('loadedmetadata',()=>playbackRoute?.onMetadata?.());
audio.addEventListener('playing',()=>{
  const route=playbackRoute;if(!route||!routingIntent)return;
  route.onMetadata?.();route.switching=false;clearRouteTimer();
  const origin=routeOrigin(route.source),h=routeHealth(origin),latency=Math.max(0,routeClock()-route.started);
  if(!route.measured){routingHealth.set(origin,{...h,latency:h.latency?(h.latency*.75+latency*.25):latency,failedUntil:0});route.measured=true;}routeNotice(route.index||route.retried?'HIVE: playback recovered.':'');
});
audio.addEventListener('waiting',()=>{if(playbackRoute&&routingIntent&&!routeTimer)armRouteTimer(playbackRoute);});
audio.addEventListener('stalled',()=>{if(playbackRoute&&routingIntent&&!routeTimer)armRouteTimer(playbackRoute);});
audio.addEventListener('error',()=>{if(audio.error&&playbackRoute&&routingIntent)recoverRoute('No available playback source');});
audio.addEventListener('seeking',()=>{const route=playbackRoute;if(route&&!route.loading){route.lastTime=Number(audio.currentTime)||0;if(routingIntent&&!routeTimer)armRouteTimer(route);}});
audio.addEventListener('seeked',()=>{if(playbackRoute&&routingIntent&&audio.readyState>=3)clearRouteTimer();});
audio.addEventListener('timeupdate',()=>{const route=playbackRoute;if(route&&!route.loading&&Number.isFinite(audio.currentTime)){
  if(!audio.seeking&&audio.currentTime>route.lastTime+.1)clearRouteTimer();route.lastTime=audio.currentTime;}});
audio.addEventListener('play',()=>{if(playbackRoute){routingIntent=true;if(!playbackRoute.exhausted&&!routeTimer&&audio.readyState<3)armRouteTimer(playbackRoute);}});
audio.addEventListener('pause',()=>{if(playbackRoute&&!playbackRoute.switching&&!audio.error&&!audio.ended){routingIntent=false;clearRouteTimer();}});
function play(id) {
  const t = byId[id];
  if (!t) return;
  qi = queue.indexOf(id);
  if (qi < 0) { queue = [id]; qi = 0; }
  audio.dataset.id = id; counted = false; left = repeat ? repeat - 1 : 0;
  // Peer listens count on this WASP instance without altering the peer's files.
  beginRoute(t);
  // Keep the earlier stream active only until the new audio begins playing.
  $("#pc").innerHTML = art(albumArt(t), albumName(t) || t.title, "lg");
  $("#pt").textContent = t.title;
  $("#pa").textContent = artistLine(t);
  const names=[...new Set(artistsOf(t).flatMap(n=>String(n).split(',').map(x=>x.trim())).filter(Boolean))];$("#pa").href=names.length===1?'#artist/'+enc(names[0]):'#artists';
  $("#pa").dataset.artists=names.join(', ');
  $("#pa").title=names.length>1?'Browse all contributing artists':'Open artist page';
  if (navigator.mediaSession && typeof MediaMetadata === "function") {
    // Broken artwork URLs must never interrupt queue updates or playback controls.
    try {
      const artSrc = albumArt(t);
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title, artist: artistLine(t), album: albumName(t),
        artwork: artSrc ? [{ src: artSrc.startsWith("http") ? artSrc : new URL(artSrc, location.href).href }] : [],
      });
    } catch (e) { console.warn("Unable to set media-session artwork", e); }
  }
  paintReact(); paintShuffle(); markRows(); renderQueue();
  if (!$("#lyrics").classList.contains("hidden")) loadLyrics();
}
const step = (d) => { if (queue.length) play(queue[(Math.max(qi, 0) + d + queue.length) % queue.length]); };

function shuffleIn(kind) {
  const t = cur();
  let ids, label;
  if (kind === "all") { ids = tracks.map(x => x.id); label = "Shuffling all songs"; }
  else if (kind === "artist") {
    if (!t) return;
    const artists = artistsOf(t);
    ids = tracks.filter(x => artistsOf(x).some(a => artists.includes(a))).map(x => x.id);
    label = `Shuffling ${artists.join(", ")}`;
  } else {
    // Do not look up peer/user playlists in the server-only playlist array.
    // Use the exact source-aware playable IDs captured when playback started.
    if (!playlistScope) return;
    ids = playlistScope.ids.filter(id => !!byId[id]);
    label = `Shuffling “${playlistScope.name}”`;
  }
  if (!ids.length) return;
  if (kind !== "playlist") { playlistScope = null; ctxPl = null; }
  queue = shuffled(ids); qLabel = label; shufKind = kind; closeShuf();
  if (queue.length > 1 && queue[0] === audio.dataset.id) [queue[0], queue[1]] = [queue[1], queue[0]];
  play(queue[0]);
}
function paintShuffle() {
  const t = cur(), p = playlistScope;
  $("#sArtist").disabled = !t;
  $("#sList").disabled = !(p && p.ids.some(id => !!byId[id]));
  $("#sArtist").title = t ? "" : "Play a song first";
  $("#sList").title = p ? `Random song from “${p.name}”` : "Play a song from a playlist to use this";
  $("#shuf").classList.toggle("on", !!shufKind);
  setTip("#shuf", shufKind ? qLabel : "Shuffle");
}

// the slide-up menu that lets you choose what to shuffle
const shufBtn = $("#shuf"), shufMenu = $("#shufMenu");
function openShuf(open) {
  shufMenu.classList.toggle("open", open);
  shufBtn.setAttribute("aria-expanded", open);
  if (open) { paintShuffle(); (shufMenu.querySelector(".sitem:not(:disabled)") || shufBtn).focus(); }
}
const closeShuf = () => openShuf(false);
shufBtn.addEventListener("click", (e) => { e.stopPropagation(); openShuf(!shufMenu.classList.contains("open")); });
document.addEventListener("click", (e) => { if (!e.target.closest(".shufwrap")) closeShuf(); });
shufMenu.addEventListener("keydown", (e) => {
  const items = [...shufMenu.querySelectorAll(".sitem:not(:disabled)")], i = items.indexOf(document.activeElement);
  if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); if (items.length) items[(i + 1) % items.length].focus(); }
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); if (items.length) items[(i - 1 + items.length) % items.length].focus(); }
  else if (e.key === "Escape") { closeShuf(); shufBtn.focus(); }
});
function markRows() { document.querySelectorAll("#list [data-id]").forEach((r) => r.classList.toggle("on", r.dataset.id === audio.dataset.id)); }

function renderQueue() {
  const up = [];
  for (let k = 1; k < queue.length && up.length < 50; k++) up.push(byId[queue[(qi + k) % queue.length]]);
  const queueLabel=$("#uql");queueLabel.replaceChildren();
  if(playlistScope?.id){const link=document.createElement('a');link.href='#playlist/'+encodeURIComponent(playlistScope.id);link.textContent=qLabel;link.title='Open playlist';queueLabel.append(link);}else queueLabel.textContent=qLabel;
  $("#uplist").innerHTML = up.length ? up.filter(Boolean).map((t) =>
    `<button class="qrow" data-id="${esc(t.id)}">${art(albumArt(t), albumName(t) || t.title)}<span class="t">${esc(t.title)}<small>${esc(artistLine(t))}</small></span></button>`).join("")
    : empty(queue.length ? "That's the last song." : "Play a song to see what's next.");
}

// Local reaction counts for peer music, never posted to the remote host.
const peerReactionCounts=new Map();
// The cache is not a second library. It only holds metadata for peer songs
// that have received reactions on this WASP instance.
const peerReactionTracks=new Map();
const peerReactionKey=t=>`${registeredPeerOrigin(t.origin)}|${t.remote_id||String(t.id).split("|").at(-1)}`;
function reactionRecordingKey(t) {
  if(!t || !t.title || !(t.artist || t.artists?.length) || !(Number(t.duration)>0)) return "";
  if(/\b(live|remix|remaster|acoustic|instrumental|demo|edit)\b/i.test(t.title)) return "";
  const artist=normalizeRecording(primaryArtist(t)||t.artist), title=normalizeRecording(t.title);
  return artist && title ? `${artist}|${title}|${Math.round(Number(t.duration)/3)}` : "";
}
// Peer votes always reflect THIS server's voters. Remote peers cannot change
// the local chart, and an identical song on two peers must appear only once.
function peerRankingTotals() {
  const byRecording=new Map();
  for(const [key,c] of peerReactionCounts) {
    const t=peerReactionTracks.get(key)||peerTrackLookup.get(key);
    const identity=reactionRecordingKey(t);
    if (!identity) continue;
    const totals=byRecording.get(identity)||{hearts:0,likes:0,dislikes:0};
    for(const field of ["hearts","likes","dislikes"]) totals[field]+=Math.max(0,Number(c[field])||0);
    byRecording.set(identity,totals);
  }
  return byRecording;
}
function chartScore(t,field,totals) {
  const identity=reactionRecordingKey(t);
  if (identity && totals.has(identity)) return (t.origin?0:Number(t[field])||0)+totals.get(identity)[field];
  return t.origin?Number(peerReactionCounts.get(peerReactionKey(t))?.[field]||0):Number(t[field]||0);
}
function reactedSongPool() {
  const all=[...tracks],seen=new Set(all.map(t=>reactionRecordingKey(t)).filter(Boolean));
  const ids=new Set(all.map(t=>t.id));
  for(const t of peerReactionTracks.values()) {
    const identity=reactionRecordingKey(t);
    if (!t.title || ids.has(t.id) || (identity && seen.has(identity))) continue;
    // Never add a second tile for a duplicate recording; prefer the live song.
    all.push(t);ids.add(t.id);if(identity)seen.add(identity);
    if(!byId[t.id]) byId[t.id]=t;
  }
  return all;
}
async function loadPeerReactionCounts(){
 try{const r=await fetch("/api/peer-reactions",{headers:{"X-Visitor":vid}});if(!r.ok)return;
 for(const x of await r.json()){const key=`${x.origin}|${x.remote_id}`;
  peerReactionCounts.set(key,x);
  if(x.title){
   const track={id:key,remote_id:x.remote_id,origin:x.origin,title:x.title,
    artist:x.artist||"Unknown Artist",artists:[x.artist||"Unknown Artist"],
    album:x.album||"",duration:Number(x.duration)||0,cover_url:x.cover_url||"",
    created_at:Number(x.created_at)||0,cached_peer:true};
   peerReactionTracks.set(key,track);
  }
  // Always refresh the local visitor's state; previously unvoted songs may
  // have been voted on another device, or the vote may have been removed.
  mine[key]={heart:!!x.my_heart,like:!!x.my_like,dislike:!!x.my_dislike};
 }
 store.set("mine",mine);
 }catch{}
}
// Reactions are stored on THIS server for peers and local songs. Refresh the
// active song without re-fetching the 1,328-track peer catalogue, so votes
// from other listeners become visible promptly to guests and signed-in users.
let reactionMutationCount=0;
let reactionReadSeq=0;
async function refreshCurrentReaction() {
  const t=cur();
  if (!t || reactionMutationCount || document.hidden) return;
  const isPeer=!!t.origin;
  const key=isPeer?peerReactionKey(t):t.id;
  const args=new URLSearchParams(isPeer
    ? {origin:registeredPeerOrigin(t.origin),remote_id:t.remote_id||String(t.id).split("|").at(-1)}
    : {id:t.id});
  const seq=++reactionReadSeq;
  try {
    const r=await fetch("/api/reaction-state?"+args,{headers:{"X-Visitor":vid},cache:"no-store"});
    if (!r.ok) return;
    const latest=await r.json();
    const now=cur();
    if (!now || reactionMutationCount || seq!==reactionReadSeq || (isPeer?peerReactionKey(now):now.id)!==key) return;
    if (isPeer) peerReactionCounts.set(key,latest);
    else for(const field of ["hearts","likes","dislikes"]) now[field]=Number(latest[field])||0;
    mine[key]={heart:!!latest.my_heart,like:!!latest.my_like,dislike:!!latest.my_dislike};
    store.set("mine",mine);
    paintReact();
  } catch { /* keep the last known counts if temporarily offline */ }
}
setInterval(refreshCurrentReaction,10000);
setInterval(async()=>{
  if(document.hidden || !RX.includes(parse().a) || reactionMutationCount) return;
  try {
    await loadPeerReactionCounts();
    const e=await fetch("/api/entity-reactions",{cache:"no-store"});
    if(e.ok){const data=await e.json();entity={artist:data.artist||{},playlist:data.playlist||{}};ratedPlaylistCache=arr(data.playlist_meta);}
    // v14: a compact, indexed reaction summary instead of downloading and
    // rebuilding the complete 1,328-track catalogue every 15 seconds.
    const r=await fetch("/api/track-reaction-counts",{cache:"no-store"});
    if(r.ok){
      const updates=new Map((await r.json()).map(t=>[t.id,t]));
      for(const t of tracks)if(!t.origin){
        const latest=updates.get(t.id)||{};
        for(const field of ["hearts","likes","dislikes"])t[field]=Number(latest[field])||0;
      }
    }
    if(RX.includes(parse().a))render();
  }catch{}
},15000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)refreshCurrentReaction();});
// ---------- reactions ----------
function paintReact() {
  const t=cur(),remote=!!t?.origin;
  const starEl=$("#playerStars");if(starEl){starEl.innerHTML=t?starsMarkup("track",remote?registeredPeerOrigin(t.origin)+"|"+(t.remote_id||String(t.id).split("|").at(-1)):t.id):"";scheduleStarRefresh();}
  const key=t ? (remote?peerReactionKey(t):t.id):"";
  const m=(t&&mine[key])||{};
  const counts=remote?(peerReactionCounts.get(key)||{hearts:0,likes:0,dislikes:0}):t;
  [["bh","ch","heart"],["bl","cl","like"],["bd","cd","dislike"]].forEach(([b,c,k])=>{
    $("#"+b).disabled=!t;
    $("#"+b).classList.toggle("on",!!m[k]);
    $("#"+b).setAttribute("aria-pressed",!!m[k]);
    $("#"+c).textContent=t ? Number(counts?.[KEY[k]]||0) : 0;
    setTip("#"+b,{heart:["Heart this song","Remove heart"],like:["Like","Remove like"],dislike:["Dislike","Remove dislike"]}[k][m[k]?1:0]+(remote?" (saved on this server)":""));
  });
}
async function react(kind) {
  const t=cur();if(!t)return;
  reactionMutationCount++;
  reactionReadSeq++; // ignore an older refresh racing with the user's click
  const remote=!!t.origin,key=remote?peerReactionKey(t):t.id;
  const m=(mine[key]??={}),prior={...m};
  const counts=remote?(peerReactionCounts.get(key)||{hearts:0,likes:0,dislikes:0}):t;
  const priorCounts={...counts};
  const on=!m[kind];
  const bump=(k,d)=>counts[KEY[k]]=Math.max(0,Number(counts[KEY[k]]||0)+d);
  m[kind]=on;bump(kind,on?1:-1);
  const other=kind==="like"?"dislike":kind==="dislike"?"like":null;
  if(on&&other&&m[other]){m[other]=false;bump(other,-1);}
  if(remote)peerReactionCounts.set(key,counts);
  store.set("mine",mine);paintReact();
  try {
    const endpoint=remote?"/api/peer-react":"/api/react/"+t.id;
    const body=remote?{kind,on,origin:registeredPeerOrigin(t.origin),
      remote_id:t.remote_id||String(t.id).split("|").at(-1),
      title:t.title,artist:primaryArtist(t)||t.artist||"",album:albumName(t)||"",
      duration:Number(t.duration)||0,
      cover_url:t.cover_url||""}:{kind,on};
    const r=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json","X-Visitor":vid},body:JSON.stringify(body)});
    if(!r.ok)throw Error("Reaction wasn't saved");
    const saved=await r.json();
    if(remote){
      peerReactionCounts.set(key,saved);
      peerReactionTracks.set(key,{...t,id:key,origin:registeredPeerOrigin(t.origin),
        remote_id:t.remote_id||String(t.id).split("|").at(-1),
        artist:primaryArtist(t)||t.artist||"",artists:artistsOf(t)});
    }else Object.assign(t,saved);
  }catch{mine[key]=prior;if(remote)peerReactionCounts.set(key,priorCounts);else Object.assign(t,priorCounts);store.set("mine",mine);popup("Couldn't save reaction","Please try again.");}
  finally {reactionMutationCount=Math.max(0,reactionMutationCount-1);}
  paintReact();
  // Update the Most hearted/liked/disliked chart without requiring navigation.
  if (RX.includes(parse().a)) render();
}
$("#bh").addEventListener("click", () => react("heart"));
$("#bl").addEventListener("click", () => react("like"));
$("#bd").addEventListener("click", () => react("dislike"));

// ---------- controls ----------
$("#list").addEventListener("click", (e) => {
  const ent = e.target.closest("[data-ent]");
  if (ent) { reactEntity(ent.dataset.ent, ent.dataset.key, ent.dataset.r); return; }
  const pp = e.target.closest("[data-playpl]");
  if (pp) {
    const p=[...playlists,...peerPlaylists,...userPublicPlaylists].find(x=>x.id===pp.dataset.playpl);
    const ids=p ? arr(p.tracks).map(raw=>{
      const id=typeof raw==='object' ? (raw.ref||raw.track_id||raw.id) : raw;
      if(byId[id])return id;
      const remote=p.origin && !String(id).startsWith('peer:') ? `${p.origin}|${id}` : null;
      return remote && byId[remote] ? remote : null;
    }).filter(Boolean) : [];
    if(ids.length)startQueue(ids,ids[0],`Playlist “${p.name}”`,p.id);
    else if(p)popup('No playable songs','This playlist has no tracks available from its connected server.');
    return;
  }
  const at = e.target.closest("[data-atab]");
  if (at && artistView) { artistView.tab = at.dataset.atab; paintArtist(); return; }
  const rq = e.target.closest("[data-req]");
  if (rq) { prefillRequest(rq.dataset.req); return; }
  const k = e.target.closest("[data-kind]");
  if (k) { reqKind = k.dataset.kind; requestForm($("#list")); return; }
  const b = e.target.closest("[data-act]");
  if (b && b.dataset.act === "retry") { load(); return; }
  if (b) {
    if (b.dataset.act === "radio") { startRadio(dec(parse().arg)); return; }
    if (!view.ids.length) return;
    if (b.dataset.act === "play") startQueue(view.ids, view.ids[0], view.label, view.pl);
    else { const q = shuffled(view.ids); startQueue(q, q[0], `Shuffling ${view.label}`, view.pl, "list"); }
    return;
  }
  const r = e.target.closest(".row, .tile[data-id]");
  if (r) startQueue(view.ids, r.dataset.id, view.label, view.pl);
});
$("#uplist").addEventListener("click", (e) => { const r = e.target.closest(".qrow"); if (r) play(r.dataset.id); });
window.addEventListener("hashchange", () => {
  if(parse().a === "settings"){render();return;}
  lastBrowseHash = location.hash || "#home";
  if($("#accountSettingsDialog")?.open)$("#accountSettingsDialog").close();
  render();window.scrollTo(0, 0);
});
$("#pa").addEventListener('click',e=>{
  const names=artistSearchTokens(e.currentTarget.dataset.artists);
  if(names.length<2)return;
  e.preventDefault();$("#q").value=names.join(', ');query=names.join(', ').toLowerCase();
  if(parse().a==='artists')render();else location.hash='#artists';
});
$("#q").addEventListener("input", (e) => { query = e.target.value.trim().toLowerCase(); if (parse().a !== "request") render(); });
$("#pp").addEventListener("click", () => {
  if (audio.src) {
    if(playbackRoute?.exhausted&&cur())return beginRoute(cur(),playbackRoute.lastTime);
    if(routingIntent&&!audio.ended){routingIntent=false;if(playbackRoute)playbackRoute.switching=false;clearRouteTimer();return audio.pause();}
    if(audio.paused){routingIntent=true;if(playbackRoute)armRouteTimer(playbackRoute);return audio.play().catch(()=>{});}
    return audio.pause();
  }
  if (view.ids.length) startQueue(view.ids, view.ids[0], view.label, view.pl); else shuffleIn("all");
});
$("#prev").addEventListener("click", () => { if (audio.currentTime > 3) audio.currentTime = 0; else step(-1); });
$("#next").addEventListener("click", () => step(1));
$("#sAll").addEventListener("click", () => shuffleIn("all"));
$("#sArtist").addEventListener("click", () => shuffleIn("artist"));
$("#sList").addEventListener("click", () => shuffleIn("playlist"));
$("#seek").addEventListener("input", (e) => { if (audio.duration) audio.currentTime = (e.target.value / 100) * audio.duration; });

function paintRepeat() {
  $("#repT").textContent = repeat ? String(repeat) : "";
  $("#rep").classList.toggle("on", !!repeat);
  setTip("#rep", repeat ? `Repeat: each song ${repeat} times` : "Repeat: off");
}
$("#rep").addEventListener("click", () => {
  repeat = repeat === 0 ? 2 : repeat === 2 ? 3 : 0;
  store.set("rep", repeat); left = repeat ? repeat - 1 : 0; paintRepeat();
});

const volEl = $("#vol");
audio.volume = volEl.value = store.get("vol", 1);
volEl.addEventListener("input", () => { audio.volume = +volEl.value; audio.muted = false; store.set("vol", +volEl.value); paintVol(); });
$("#mute").addEventListener("click", () => { audio.muted = !audio.muted; paintVol(); });
function paintVol() {
  $("#muteI").innerHTML = `<use href="#i-${audio.muted || audio.volume === 0 ? "mute" : "vol"}"/>`;
  setTip("#mute", audio.muted ? "Unmute" : "Mute");
}

// Lyrics: 1st click opens a side panel, 2nd makes it full screen (everything except the player bar), 3rd closes it.
// Up next opens on the right; next to full-screen lyrics it simply sits beside them and the lyrics make room.
let lyMode = "closed", upOpen = false;
function paintPanels() {
  $("#lyrics").classList.toggle("hidden", lyMode === "closed");
  $("#lyrics").classList.toggle("full", lyMode === "full");
  $("#upnext").classList.toggle("hidden", !upOpen);
  const c = document.body.classList;
  c.toggle("q-open", lyMode === "side" || (upOpen && lyMode !== "full"));
  c.toggle("ly-full", lyMode === "full"); c.toggle("up-open", upOpen);
  $("#lybtn").setAttribute("aria-expanded", lyMode !== "closed");
  setTip("#lybtn", lyMode === "closed" ? "Lyrics" : lyMode === "side" ? "Lyrics full screen" : "Close lyrics");
  $("#qbtn").setAttribute("aria-expanded", upOpen);
}
$("#qbtn").addEventListener("click", () => {
  upOpen = !upOpen;
  if (upOpen && lyMode === "side") lyMode = "closed"; // a side panel and Up next would not fit together
  paintPanels();
});
$("#lybtn").addEventListener("click", () => {
  const was = lyMode;
  lyMode = was === "closed" ? "side" : was === "side" ? "full" : "closed";
  if (lyMode === "side") upOpen = false;
  paintPanels();
  if (was === "closed") loadLyrics(); else if (lyMode === "full") syncLyrics(true);
});
$("#lyx").addEventListener("click", () => { lyMode = "closed"; paintPanels(); });
document.addEventListener("keydown", (e) => { // Esc steps back: full screen -> side panel -> closed
  if (e.key !== "Escape" || lyMode === "closed" || document.querySelector("dialog[open]")) return;
  lyMode = lyMode === "full" ? "side" : "closed"; paintPanels();
});

// ---------- lyrics ----------
const lyrCache = new Map();
let lyr = { id: null, synced: null, line: -1 };
async function loadLyrics() {
  const t = cur(), body = $("#lybody");
  lyr = { id: t ? t.id : null, synced: null, line: -1 };
  $("#lyt").textContent = t ? t.title : "";
  if (!t) { body.innerHTML = empty("Play a song to see its lyrics."); return; }
  body.innerHTML = `<p class="muted">Looking for lyrics…</p>`;
  let d = lyrCache.get(t.id);
  if (d === undefined) {
    try { const r = await fetch(t.origin ? "/api/lyrics?title="+enc(t.title)+"&artist="+enc(primaryArtist(t))+"&album="+enc(albumName(t))+"&duration="+enc(t.duration||0) : "/api/lyrics?id=" + enc(t.id)); d = r.ok ? await r.json() : r.status === 404 ? null : undefined; } catch { d = undefined; }
    if (d !== undefined) lyrCache.set(t.id, d);
  }
  if (lyr.id !== (cur() || {}).id) return; // the song changed while we were waiting
  if (d === undefined) { body.innerHTML = empty("Lyrics are unavailable right now."); return; }
  if (!d || (!d.synced && !d.plain)) { body.innerHTML = empty(d && d.instrumental ? "This song is instrumental." : "No lyrics found for this song."); return; }
  $("#lyt").textContent = `${t.title}${d.source ? " · " + d.source : ""}`;
  if (d.synced) {
    lyr.synced = d.synced;
    body.innerHTML = d.synced.map(([s, l]) => `<button class="ly" data-t="${s}">${l ? esc(l) : "♪"}</button>`).join("");
    syncLyrics(true);
  } else body.innerHTML = `<p class="plain">${esc(d.plain)}</p>`;
}
function syncLyrics(force) {
  if (!lyr.synced || $("#lyrics").classList.contains("hidden")) return;
  const now = audio.currentTime + 0.25;
  let lo = 0, hi = lyr.synced.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (lyr.synced[mid][0] <= now) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  if (idx === lyr.line && !force) return;
  lyr.line = idx;
  const els = $("#lybody").children;
  for (let i = 0; i < els.length; i++) els[i].classList.toggle("now", i === idx);
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (els[idx]) els[idx].scrollIntoView({ block: "center", behavior: force || calm ? "auto" : "smooth" });
}
$("#lybody").addEventListener("click", (e) => { const b = e.target.closest(".ly"); if (b) { audio.currentTime = +b.dataset.t; audio.play(); } });
audio.addEventListener("seeked", () => syncLyrics());

// v15.0.7: a live signal means HTMLAudioElement playback, not a range
// request or a completed play count. The random in-memory ID is not linked to
// a user, visitor cookie, IP, or account and is never returned by the API.
const liveStreamSession=makeId();
let reportedStream=null, lastStreamHeartbeat=0;
let streamPostChain=Promise.resolve();
function streamPayload(t){
  return {origin:t.origin?registeredPeerOrigin(t.origin):'',
    track_id:t.origin?(t.remote_id||String(t.id).split('|').at(-1)):t.id};
}
function streamPost(action,track){
  const body=JSON.stringify({session_id:liveStreamSession,action,...(track||{})});
  // Serialize state changes: an older pause must not outrun a newer play.
  streamPostChain=streamPostChain.catch(()=>{}).then(()=>fetch('/api/active-streams',{
    method:'POST',headers:{'content-type':'application/json'},body,cache:'no-store',keepalive:true
  }).catch(()=>{}));
}
function syncLiveStream(force=false){
  const t=playbackRoute?.source||cur();
  const playing=!!(t&&audio.currentSrc&&!audio.paused&&!audio.ended&&audio.readyState>=2);
  const key=playing?listenKey({...streamPayload(t),source_server:location.origin}):'';
  const now=Date.now();
  if(!playing){
    if(reportedStream){reportedStream=null;lastStreamHeartbeat=0;streamPost('stop');}
    return;
  }
  if(reportedStream!==key||force||now-lastStreamHeartbeat>=25000){
    reportedStream=key;lastStreamHeartbeat=now;streamPost('playing',streamPayload(t));
  }
}
audio.addEventListener('playing',()=>syncLiveStream(true));
audio.addEventListener('play',()=>syncLiveStream());
audio.addEventListener('pause',()=>syncLiveStream());
audio.addEventListener('ended',()=>syncLiveStream());
audio.addEventListener('emptied',()=>syncLiveStream());
setInterval(()=>syncLiveStream(),5000);
window.addEventListener('pagehide',()=>{
  if(reportedStream){
    reportedStream=null;
    // A page being discarded cannot await fetch; the TTL is a fallback.
    try{navigator.sendBeacon('/api/active-streams',new Blob([JSON.stringify({session_id:liveStreamSession,action:'stop'})],{type:'application/json'}));}catch{}
  }
});

// Retry confirmed listen submissions with the original per-play UUID. A short
// server failure must not lose telemetry; session storage survives page reloads.
const pendingPlayKey='wasp:pending-plays:v182';
let pendingPlays=[];try{pendingPlays=JSON.parse(sessionStorage.getItem(pendingPlayKey)||'[]');if(!Array.isArray(pendingPlays))pendingPlays=[];}catch{}
let sendingPlays=false;
function savePendingPlays(){try{sessionStorage.setItem(pendingPlayKey,JSON.stringify(pendingPlays));}catch{}}
async function flushPendingPlays(){
 if(sendingPlays)return;sendingPlays=true;
 try{const now=Date.now();pendingPlays=pendingPlays.filter(p=>p&&now-p.created<86400000).slice(-100);
 for(const p of [...pendingPlays].filter(p=>!p.next||p.next<=now).slice(0,8)){
  try{const headers={'X-WASP-Play-Id':p.id,...(p.body?{'content-type':'application/json'}:{})};const r=await fetch(p.url,{method:'POST',headers,...(p.body?{body:JSON.stringify(p.body)}:{}),signal:AbortSignal.timeout(10000)});if(r.ok||([400,401,403,404].includes(r.status))){pendingPlays=pendingPlays.filter(x=>x.id!==p.id);continue;}}catch{}
  p.tries=(p.tries||0)+1;p.next=Date.now()+Math.min(300000,5000*2**Math.min(p.tries-1,6));
 }
 }finally{sendingPlays=false;savePendingPlays();}
}
function submitConfirmedPlay(url,body){pendingPlays.push({id:makeId(),url,body,created:Date.now(),tries:0});pendingPlays=pendingPlays.slice(-100);savePendingPlays();void flushPendingPlays();}
setInterval(()=>{if(pendingPlays.length)void flushPendingPlays();},5000);
window.addEventListener('online',()=>void flushPendingPlays());
if(pendingPlays.length)void flushPendingPlays();
audio.addEventListener("timeupdate", () => {
  $("#cur").textContent = fmt(audio.currentTime); $("#dur").textContent = fmt(audio.duration);
  syncLyrics();
  if (audio.duration) $("#seek").value = (audio.currentTime / audio.duration) * 100;
  const t = cur();
  if (t && !counted && !playbackRoute?.loading && audio.currentTime >= 10) {
    counted = true; t.plays++;
    const played=playbackRoute?.source||t;
    if(played.origin) submitConfirmedPlay("/api/play-peer",{origin:registeredPeerOrigin(played.origin),remote_id:played.remote_id||String(played.id).split("|").at(-1),title:t.title,artist:artistLine(t),album:albumName(t),cover_url:t.cover_url||"",duration:t.duration||0});
    else submitConfirmedPlay("/api/play/" + played.id);
  }
});
audio.addEventListener("play", () => { setTip("#pp", "Pause"); $("#ppi").innerHTML = '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>'; });
audio.addEventListener("pause", () => { setTip("#pp", "Play"); $("#ppi").innerHTML = '<path d="M7 4v16l13-8z"/>'; });
audio.addEventListener("ended", () => {
  const route=playbackRoute,expected=Number(cur()?.duration)||0;
  if(route&&routingIntent&&expected>0&&Number(audio.duration)>0&&Number(audio.duration)<expected-5&&route.sources.length>1){recoverRoute('Source ended early');return;}
  clearRouteTimer();
  if (left > 0) { left--; counted=false; audio.currentTime = 0; audio.play(); } else step(1);
});
if ("mediaSession" in navigator) {
  try{navigator.mediaSession.setActionHandler('pause',()=>{routingIntent=false;clearRouteTimer();if(playbackRoute)playbackRoute.switching=false;audio.pause();});navigator.mediaSession.setActionHandler('play',()=>{if(playbackRoute?.exhausted&&cur())beginRoute(cur(),playbackRoute.lastTime);else {routingIntent=true;audio.play().catch(()=>{});}});}catch{}
  navigator.mediaSession.setActionHandler("previoustrack", () => step(-1));
  navigator.mediaSession.setActionHandler("nexttrack", () => step(1));
}

// keep page padding and the Up next panel clear of the player bar
new ResizeObserver(() => document.documentElement.style.setProperty("--ph", $("#player").offsetHeight + "px")).observe($("#player"));

// the site name (top left) opens the landing page only
$("#brand").addEventListener("click", (e) => {
  if (location.hash === "#home") { e.preventDefault(); $("#q").value = ""; query = ""; render(); window.scrollTo(0, 0); }
});

// ---------- admin gear + login dialog ----------
$("#gear").addEventListener("click", async () => {
  if (currentAccount?.authenticated && currentAccount.role === "user") return;
  try { if ((await (await fetch("/api/me")).json()).admin) { location.href = "/admin.html"; return; } } catch {}
  $("#dlg").showModal(); $("#lid").focus();
});
$("#lcancel").addEventListener("click", () => $("#dlg").close());
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: $("#lid").value, password: $("#lpw").value }) });
  if (r.ok) { const me=await r.json(); $("#dlg").close(); $("#lpw").value=""; $("#lerr").textContent=""; await refreshAccount(); if(me.role === "admin")location.href="/admin.html";else {location.hash="#user/private";render();} } else $("#lerr").textContent = (await r.json()).error;
});


// User playlists, including remote tracks. All actions are explicitly initiated by the signed-in user.
let currentAccount=null;
async function refreshAccount(){
  try {const r=await fetch("/api/me");currentAccount=await r.json();}catch{currentAccount=null;}
  $("#whoami").textContent=currentAccount?.authenticated?currentAccount.username:"Sign In";
  $("#accountMenu").classList.toggle("signed-in",!!currentAccount?.authenticated);
  if(!currentAccount?.authenticated)$("#accountDrop").classList.add("hidden");
  updatePublishNoticeBadges();
  // Local public announcements belong to every visitor, including guests.
  void pollServerAnnouncements();
  // Keep + visible to guests; it opens a themed sign-in requirement dialog.
  $("#playlistAdd").hidden = false;
  document.querySelectorAll(".album-add").forEach(b=>b.hidden=false);
}
const postJSON=(url,body,method="POST")=>fetch(url,{method,headers:{"content-type":"application/json"},body:JSON.stringify(body)});

// v18.1.1: public server-local announcements, including visitors without accounts.
// Brief shared-edge cached polling provides a near-live feed without a paid
// third-party push service or a long-running Worker/D1 connection. Notices are
// remembered in this origin's browser cache until dismissed/fully displayed.
const ANNOUNCEMENTS_SEEN='wasp-announcements-handled-v1811';
const ANNOUNCEMENTS_STARTED='wasp-announcements-started-v1811';
const ANNOUNCEMENTS_SOUND='wasp-announcements-sound-v1811';
let announcementTimer=null,announcementPollTime=0,announcementPolling=false;
let announcementQueue=[],announcementVisible=false,announcementCurrent=null;
let announcementAudio=null;
function announcementHandled(){return new Set(store.get(ANNOUNCEMENTS_SEEN,[]));}
function finishAnnouncement(id){
  store.set(ANNOUNCEMENTS_SEEN,[...new Set([...announcementHandled(),id])].slice(-150));
  const starts=store.get(ANNOUNCEMENTS_STARTED,{});delete starts[id];store.set(ANNOUNCEMENTS_STARTED,starts);
}
function announcementSoundEnabled(){return store.get(ANNOUNCEMENTS_SOUND,true)!==false;}
function prepareAnnouncementAudio(){
  if(!announcementSoundEnabled()||announcementAudio)return;
  try {const AC=window.AudioContext||window.webkitAudioContext;if(AC)announcementAudio=new AC();}catch{}
}
// Unlock WebAudio only after a user gesture; autoplay policies may suppress
// sound for passive visitors. The separate audio graph never touches playback.
document.addEventListener('pointerdown',()=>{
  prepareAnnouncementAudio();
  if(announcementAudio?.state==='suspended')announcementAudio.resume().catch(()=>{});
},{passive:true});
function dingServerAnnouncement(){
  if(!announcementSoundEnabled()||document.hidden)return;
  try{
    prepareAnnouncementAudio();const ctx=announcementAudio;if(!ctx||ctx.state!=='running')return;
    const now=ctx.currentTime,osc=ctx.createOscillator(),gain=ctx.createGain();
    osc.type='sine';osc.frequency.setValueAtTime(880,now);
    osc.frequency.exponentialRampToValueAtTime(1174.66,now+0.10);
    gain.gain.setValueAtTime(0.0001,now);
    gain.gain.exponentialRampToValueAtTime(0.026,now+0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001,now+0.16);
    osc.connect(gain);gain.connect(ctx.destination);osc.start(now);osc.stop(now+0.17);
  }catch{/* Never interrupt music or announcements if audio is unavailable. */}
}
function suspendAnnouncement(){
  clearTimeout(announcementTimer);announcementTimer=null;
  $('#serverAnnouncements').replaceChildren();announcementVisible=false;
  const previous=announcementCurrent;announcementCurrent=null;return previous;
}
function showNextServerAnnouncement(){
  if(announcementVisible)return;
  const box=$('#serverAnnouncements');
  while(announcementQueue.length){
    const notice=announcementQueue.shift();
    if(!notice?.id||announcementHandled().has(notice.id))continue;
    const starts=store.get(ANNOUNCEMENTS_STARTED,{});
    const began=Number(starts[notice.id])||Date.now();
    if(!starts[notice.id]){starts[notice.id]=began;store.set(ANNOUNCEMENTS_STARTED,starts);}
    const remaining=30000-(Date.now()-began);
    if(remaining<=0){finishAnnouncement(notice.id);continue;}
    const card=document.createElement('div');card.className='wasp-announcement';card.dataset.severity=notice.severity||'info';
    const opacity=Number(notice.opacity);
    card.style.setProperty('--announcement-opacity',String(Number.isFinite(opacity)?Math.max(.5,Math.min(.98,opacity)):.87));
    const titleRow=document.createElement('div');titleRow.className='announcement-heading';
    const title=document.createElement('strong');title.textContent=notice.title;
    const sound=document.createElement('button');sound.type='button';sound.className='announcement-sound';
    const updateSound=()=>{sound.textContent=announcementSoundEnabled()?'♪':'♪̸';sound.title=announcementSoundEnabled()?'Mute announcement ding':'Enable announcement ding';sound.setAttribute('aria-label',sound.title);sound.setAttribute('aria-pressed',String(announcementSoundEnabled()));};
    updateSound();sound.onclick=()=>{store.set(ANNOUNCEMENTS_SOUND,!announcementSoundEnabled());updateSound();};
    const close=document.createElement('button');close.type='button';close.className='announcement-close';close.setAttribute('aria-label','Dismiss announcement');close.textContent='×';
    const body=document.createElement('div');body.className='announcement-body';body.textContent=notice.body;
    titleRow.append(title,sound,close);card.append(titleRow,body);box.replaceChildren(card);
    announcementVisible=true;announcementCurrent=notice;
    const dismiss=()=>{suspendAnnouncement();finishAnnouncement(notice.id);showNextServerAnnouncement();};
    close.onclick=dismiss;
    announcementTimer=setTimeout(dismiss,remaining);
    dingServerAnnouncement();
    return;
  }
}
async function pollServerAnnouncements(force=false){
  if(announcementPolling||document.hidden)return;
  if(!force&&Date.now()-announcementPollTime<2000)return;
  announcementPolling=true;announcementPollTime=Date.now();
  try{
    const r=await fetch('/api/announcements',{cache:'no-store'});
    if(!r.ok)return;
    const data=await r.json(),handled=announcementHandled();
    const queued=new Set(announcementQueue.map(x=>x.id));
    const incoming=(Array.isArray(data.items)?data.items:[]).filter(a=>a?.id&&!handled.has(a.id)&&!queued.has(a.id)&&a.id!==announcementCurrent?.id);
    // New messages take precedence over an older displayed announcement.
    // A preempted message retains its original remaining display time.
    if(incoming.length&&announcementCurrent){
      const previous=suspendAnnouncement();
      if(previous)announcementQueue.push(previous);
    }
    // The feed is newest-first, so place new messages ahead of old backlog.
    announcementQueue=[...incoming,...announcementQueue];
    showNextServerAnnouncement();
  }catch{/* Temporary network errors do not interrupt the music player. */}
  finally{announcementPolling=false;}
}
window.addEventListener('focus',()=>void pollServerAnnouncements(true));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void pollServerAnnouncements(true);});
window.addEventListener('online',()=>void pollServerAnnouncements(true));
// WASP v15.0.8 — settings are an independent HTML-backed dialog. The music
// app, audio element, current page and scroll position are never remounted.
let accountSettingsTemplate = null;
let accountSettingsOpenToken = 0;
let accountSettingsTabToken = 0;
const accountSettingsDialog = $("#accountSettingsDialog");
const accountSettingsMount = $("#accountSettingsMount");
function settingsTab(value){return ["publish","mobile"].includes(value) ? value : "account";}
function settingsFeedback(node,message,error=false){
  if(!node)return;
  node.textContent=message;
  node.classList.toggle('err',Boolean(error));
}
async function renderAccountSettingsSection(which="account"){
  const d=accountSettingsDialog;
  if(!d?.open)return;
  which=settingsTab(which);
  const token=++accountSettingsTabToken;
  const root=d.querySelector('#accountSettingsLayout');
  if(!root)return;
  root.querySelectorAll('[data-settings-tab]').forEach(button=>{
    const selected=button.dataset.settingsTab===which;
    button.setAttribute('aria-selected',String(selected));
    button.tabIndex=selected?0:-1;
  });
  const place=root.querySelector('#accountSettingsContent');
  place.innerHTML='<p class="muted">Loading settings…</p>';
  try {
    const res=await fetch('/api/me',{cache:'no-store'});
    if(!res.ok)throw Error('Unable to check your account session.');
    const me=await res.json();
    if(token!==accountSettingsTabToken || !d.open)return;
    if(!me.authenticated){
      place.innerHTML='<p>Sign in to manage your account.</p><button type="button" class="btn" id="settingsSignIn">Sign in</button>';
      place.querySelector('#settingsSignIn').onclick=()=>{d.close();$('#dlg').showModal();$('#lid').focus();};
      return;
    }
    if(me.role!=='user'){
      place.innerHTML='<p>Administrator account settings are managed in the admin dashboard.</p><a class="btn account-admin-link" href="/admin.html#account">Open admin account settings</a>';
      return;
    }
    if(which==='mobile'){
      const response=await fetch('/api/user/mobile-keys',{cache:'no-store'});
      if(!response.ok)throw Error('Could not load Mobile Bridge access.');
      const mobile=await response.json();
      if(token!==accountSettingsTabToken||!d.open)return;
      place.innerHTML=`<div class="settings-panel"><h3>WASP Mobile Bridge <span class="muted">· v16.0.5 staging</span></h3>
        <p class="muted">Connect Subsonic / OpenSubsonic applications to this WASP server. Use a separate key per device. Do not enter your WASP website password into a mobile player.</p>
        <p><strong>Server URL:</strong> <code>${esc(location.origin)}/mobile</code> <button type="button" class="btn ghost" id="copyMobileUrl">Copy URL</button></p>
        <p class="muted">Server status: ${mobile.enabled?'Enabled':'Disabled by administrator'}. ${mobile.secret_ready?'Mobile credentials available.':'Setup required. Ask an administrator to configure the secret under Admin → Network → Mobile Bridge.'}</p>
        <form id="createMobileKey" class="password-form" autocomplete="off"><label>Device / app name
          <input name="label" required minlength="2" maxlength="64" placeholder="My Android music player"></label>
          <button type="submit" class="btn" ${!mobile.enabled||!mobile.secret_ready?'disabled':''}>Generate mobile app key</button></form>
        <div id="mobileSecretBox" class="hidden" role="status" aria-live="polite"></div>
        <p id="mobileFeedback" class="msg" role="status" aria-live="polite"></p>
        <h3>Connected devices</h3><div id="mobileKeyList">${mobile.keys.length?mobile.keys.map(k=>`<div class="published-peer-row"><div><strong>${esc(k.label)}</strong><p class="muted">Created ${new Date(k.created_at).toLocaleString()}</p></div><button type="button" class="btn ghost" data-revoke-mobile="${esc(k.id)}">Revoke</button></div>`).join(''):'<p class="muted">No mobile keys yet.</p>'}</div>
        <p class="muted">The key is displayed once. Storing it in your chosen music player gives that app access to this WASP server until you revoke it.</p></div>`;
      place.querySelector('#copyMobileUrl').onclick=async()=>{try{await navigator.clipboard.writeText(location.origin+'/mobile');settingsFeedback(place.querySelector('#mobileFeedback'),'Server URL copied.');}catch{settingsFeedback(place.querySelector('#mobileFeedback'),'Copy the server URL shown above.',true);}};
      place.querySelector('#createMobileKey').onsubmit=async e=>{
        e.preventDefault();const form=e.currentTarget,button=form.querySelector('button');button.disabled=true;
        try{
          const res=await postJSON('/api/user/mobile-keys',{label:form.elements.label.value});
          const v=await res.json();if(!res.ok)throw Error(v.error||'Could not create mobile key.');
          const secret=place.querySelector('#mobileSecretBox');secret.classList.remove('hidden');secret.replaceChildren();
          secret.classList.add('mobile-key-reveal');
          const heading=document.createElement('p');heading.className='mobile-key-heading';heading.textContent='Copy this key now — it will not be shown again.';
          const pill=document.createElement('div');pill.className='mobile-key-pill';
          const code=document.createElement('code');code.className='mobile-key-value';code.textContent=v.secret;
          const copy=document.createElement('button');copy.type='button';copy.className='mobile-key-copy';
          copy.setAttribute('aria-label','Copy mobile app key');copy.setAttribute('title','Copy mobile app key');
          copy.innerHTML='<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
          const notice=document.createElement('p');notice.className='mobile-key-notice';notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
          copy.onclick=async()=>{
            try{
              await navigator.clipboard.writeText(v.secret);
              notice.textContent='Mobile app key copied to clipboard!';
              notice.classList.remove('err');
              settingsFeedback(place.querySelector('#mobileFeedback'),'Key copied successfully.');
            }catch{
              notice.textContent='Automatic copy unavailable. Select the key above to copy it.';
              notice.classList.add('err');
              settingsFeedback(place.querySelector('#mobileFeedback'),'Could not copy key automatically.',true);
            }
          };
          pill.append(code,copy);secret.append(heading,pill,notice);
          form.reset();const list=place.querySelector('#mobileKeyList');
          const row=document.createElement('div');row.className='published-peer-row';const label=document.createElement('strong');label.textContent=v.label;
          const revoke=document.createElement('button');revoke.type='button';revoke.className='btn ghost';revoke.textContent='Revoke';revoke.dataset.revokeMobile=v.id;
          row.append(label,revoke);list.querySelector('.muted')?.remove();list.prepend(row);
          settingsFeedback(place.querySelector('#mobileFeedback'),'Mobile key created. Store it securely.');
        }catch(err){settingsFeedback(place.querySelector('#mobileFeedback'),err.message,true);}
        finally{button.disabled=!mobile.enabled||!mobile.secret_ready;}
      };
      place.querySelector('#mobileKeyList').addEventListener('click',async e=>{
        const button=e.target.closest('[data-revoke-mobile]');if(!button)return;
        if(!confirm('Revoke access for this mobile device?'))return;
        button.disabled=true;
        try{const r=await fetch('/api/user/mobile-keys/'+encodeURIComponent(button.dataset.revokeMobile),{method:'DELETE'});if(!r.ok)throw Error('Could not revoke key.');button.closest('.published-peer-row')?.remove();settingsFeedback(place.querySelector('#mobileFeedback'),'Mobile device revoked.');}
        catch(err){settingsFeedback(place.querySelector('#mobileFeedback'),err.message,true);button.disabled=false;}
      });
      return;
    }
    if(which==='publish'){
      const res=await fetch('/api/user/publish',{cache:'no-store'});
      if(!res.ok)throw Error('Unable to load publishing settings.');
      const data=await res.json();
      if(token!==accountSettingsTabToken || !d.open)return;
      if(currentAccount){currentAccount.publish_notice=false;updatePublishNoticeBadges();}
      place.innerHTML=`<div class="settings-panel"><h3>Publish WASP links</h3><p class="muted">Contribute public HTTPS WASP servers to expand the catalogue. Links are added as peers only, never as the administrator's primary server. Publishing requires permission from an administrator.</p>
        ${data.enabled ? `<form id="publishLinkForm" class="form"><input type="url" id="publishUrl" required maxlength="250" placeholder="https://your-wasp.example.org" aria-label="WASP server URL"><button class="btn" type="submit">Add link</button></form>` : `<p class="msg">Publishing has not been enabled for this account.</p>${data.request_pending?'<p class="publish-pending">Your request to publish is pending administrator approval.</p>':'<button class="btn" type="button" id="requestPublish">Request to Publish</button>'}`}
        <p id="publishFeedback" class="msg" role="status" aria-live="polite"></p><h3>Your submitted links</h3>
        <div id="myPublishedLinks">${Array.isArray(data.links) && data.links.length ? data.links.map(l=>`<div class="published-peer-row"><div><b>${esc(l.name||'WASP')}</b><p class="muted">${esc(l.url)} · ${l.online?'Online':'Offline'} · ${Number(l.track_count)||0} tracks</p></div><button class="btn ghost" data-unpublish="${esc(l.id)}" type="button">Remove</button></div>`).join('') : '<p class="muted">No links published yet.</p>'}</div></div>`;
      place.querySelector('#requestPublish')?.addEventListener('click',async e=>{
        const button=e.currentTarget;button.disabled=true;
        try {const r=await postJSON('/api/user/publish/request',{});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'Could not send request.');await renderAccountSettingsSection('publish');}
        catch(err){settingsFeedback(place.querySelector('#publishFeedback'),err.message,true);button.disabled=false;}
      });
      place.querySelector('#publishLinkForm')?.addEventListener('submit',async e=>{
        e.preventDefault();const form=e.currentTarget,button=form.querySelector('button');button.disabled=true;
        try {const r=await postJSON('/api/user/publish',{url:form.querySelector('#publishUrl').value});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'Unable to publish link.');await renderAccountSettingsSection('publish');}
        catch(err){settingsFeedback(place.querySelector('#publishFeedback'),err.message,true);button.disabled=false;}
      });
      place.querySelectorAll('[data-unpublish]').forEach(button=>button.addEventListener('click',async()=>{
        if(!confirm('Remove this WASP link from your published peers?'))return;
        button.disabled=true;
        try {const r=await fetch('/api/user/publish/'+encodeURIComponent(button.dataset.unpublish),{method:'DELETE'});if(!r.ok)throw Error('Could not remove link.');await renderAccountSettingsSection('publish');}
        catch(err){settingsFeedback(place.querySelector('#publishFeedback'),err.message,true);button.disabled=false;}
      }));
      return;
    }
    place.innerHTML=`<div class="settings-panel"><p class="settings-signed-in">Signed in as <strong>${esc(me.username)}</strong></p>
      <h3>Change username</h3><form id="changeUsernameForm" class="password-form"><label>New username<input type="text" name="username" value="${esc(me.username)}" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_-]{3,32}" autocomplete="username"></label><label>Current password<input type="password" name="password" required autocomplete="current-password"></label><button class="btn" type="submit">Update username</button><p id="usernameFeedback" class="msg" role="status" aria-live="polite"></p></form>
      <h3>Change password</h3><form id="changePasswordForm" class="password-form"><label>Current password<input type="password" name="current" required autocomplete="current-password"></label><label>New password<input type="password" name="password" required minlength="8" autocomplete="new-password"></label><label>Confirm new password<input type="password" name="confirm" required minlength="8" autocomplete="new-password"></label><button class="btn" type="submit">Update password</button><p id="passwordFeedback" class="msg" role="status" aria-live="polite"></p></form></div>`;
    place.querySelector('#changeUsernameForm').addEventListener('submit',async e=>{
      e.preventDefault();const form=e.currentTarget,button=form.querySelector('button');button.disabled=true;
      try {const data=Object.fromEntries(new FormData(form));const r=await postJSON('/api/user/username',data,'PUT');const j=await r.json().catch(()=>({}));
        if(!r.ok)throw Error(j.error||'Username change failed.');
        form.elements.password.value='';await refreshAccount();
        if(!form.isConnected)return;
        place.querySelector('.settings-signed-in strong').textContent=currentAccount?.username||data.username;
        form.elements.username.value=currentAccount?.username||data.username;
        settingsFeedback(place.querySelector('#usernameFeedback'),'Username updated.');
      }catch(err){settingsFeedback(place.querySelector('#usernameFeedback'),err.message,true);}
      finally{button.disabled=false;}
    });
    place.querySelector('#changePasswordForm').addEventListener('submit',async e=>{
      e.preventDefault();const form=e.currentTarget,button=form.querySelector('button');button.disabled=true;
      try {const r=await postJSON('/api/user/password',Object.fromEntries(new FormData(form)));const j=await r.json().catch(()=>({}));
        if(!r.ok)throw Error(j.error||'Password change failed.');form.reset();
        settingsFeedback(place.querySelector('#passwordFeedback'),'Password changed successfully.');
      }catch(err){settingsFeedback(place.querySelector('#passwordFeedback'),err.message,true);}
      finally{button.disabled=false;}
    });
  }catch(err){
    if(token===accountSettingsTabToken && d.open){
      place.replaceChildren();const feedback=document.createElement('p');feedback.className='msg err';feedback.setAttribute('role','alert');feedback.textContent=err.message||'Unable to load settings.';place.append(feedback);
      const retry=document.createElement('button');retry.type='button';retry.className='btn ghost';retry.textContent='Retry';retry.onclick=()=>renderAccountSettingsSection(which);place.append(retry);
    }
  }
}
async function openAccountSettings(section='account'){
  if(!accountSettingsDialog)return;
  section=settingsTab(section);
  $('#accountDrop')?.classList.add('hidden');hideSidebarTooltip();
  if(accountSettingsDialog.open && accountSettingsMount.querySelector('#accountSettingsLayout')){
    void renderAccountSettingsSection(section);return;
  }
  const token=++accountSettingsOpenToken;
  if(!accountSettingsDialog.open)accountSettingsDialog.showModal();
  accountSettingsMount.innerHTML='<p class="muted settings-modal-loading">Loading account settings…</p>';
  try{
    if(!accountSettingsTemplate){
      const r=await fetch('/account-settings.html',{cache:'no-store'});
      if(!r.ok)throw Error('Unable to load the account settings interface.');
      const doc=new DOMParser().parseFromString(await r.text(),'text/html');
      const node=doc.querySelector('#accountSettingsLayout');
      if(!node)throw Error('Account settings interface is unavailable.');
      accountSettingsTemplate=node;
    }
    if(token!==accountSettingsOpenToken||!accountSettingsDialog.open)return;
    accountSettingsMount.replaceChildren(accountSettingsTemplate.cloneNode(true));
    accountSettingsMount.querySelector('#accountSettingsClose').onclick=()=>accountSettingsDialog.close();
    accountSettingsMount.querySelectorAll('[data-settings-tab]').forEach(button=>{
      button.onclick=()=>renderAccountSettingsSection(button.dataset.settingsTab);
      button.addEventListener('keydown',e=>{
        if(!['ArrowLeft','ArrowRight'].includes(e.key))return;
        e.preventDefault();const next=button.dataset.settingsTab==='account'?'publish':button.dataset.settingsTab==='publish'?'mobile':'account';
        const target=accountSettingsMount.querySelector(`[data-settings-tab="${next}"]`);
        target.focus();void renderAccountSettingsSection(next);
      });
    });
    void renderAccountSettingsSection(section);
  }catch(err){
    if(token===accountSettingsOpenToken && accountSettingsDialog.open){
      accountSettingsMount.replaceChildren();const msg=document.createElement('p');msg.className='msg err';msg.textContent=err.message||'Unable to load settings.';accountSettingsMount.append(msg);
      const retry=document.createElement('button');retry.type='button';retry.className='btn ghost';retry.textContent='Retry';retry.onclick=()=>openAccountSettings(section);accountSettingsMount.append(retry);
    }
  }
}
accountSettingsDialog?.addEventListener('close',()=>{
  accountSettingsOpenToken++;accountSettingsTabToken++;
  accountSettingsMount.replaceChildren();
});
accountSettingsDialog?.addEventListener('click',e=>{if(e.target===accountSettingsDialog)accountSettingsDialog.close();});
// Capture before the browser changes its hash; do not navigate or repaint the
// music page when settings is opened from the sidebar or the account dropdown.
document.addEventListener('click',e=>{
  const anchor=e.target.closest('a[href="#settings"],a[href^="#settings/"]');
  if(!anchor || e.defaultPrevented || e.button!==0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)return;
  e.preventDefault();void openAccountSettings(anchor.getAttribute('href').split('/')[1]||'account');
},true);

function requireUserForPlaylist() {
  if (currentAccount?.role === "user") return false;
  $("#signinRequiredDlg").showModal();
  return true;
}
$("#signinRequiredCancel").onclick = () => $("#signinRequiredDlg").close();
$("#signinRequiredLogin").onclick = () => {
  $("#signinRequiredDlg").close();
  $("#dlg").showModal();
};
$("#signinRequiredRegister").onclick = () => {
  $("#signinRequiredDlg").close();
  $("#registerDlg").showModal();
};
async function openPlaylistAdd(ids){
  if(requireUserForPlaylist()) return;
  const d=$("#playlistDialog"), list=$("#playlistOptions");
  d.dataset.ids=ids.join(",");
  const r=await fetch("/api/user/playlists");
  if(!r.ok){alert("Please sign in again.");return;}
  const ps=await r.json();
  list.innerHTML=ps.length?ps.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} (${p.is_public?"public":"private"})</option>`).join(""):`<option value="">Create a playlist first</option>`;
  $("#playlistMessage").textContent="";
  d.showModal();
}
async function addToPlaylist(id,ids){
  for(const tid of ids){
    const t=byId[tid];if(!t)continue;
    let ref=tid;
    if(t.origin){const r=await postJSON("/api/peer-track-ref",{origin:registeredPeerOrigin(t.origin),id:t.remote_id || (t.origin && String(t.id).startsWith(t.origin+"|") ? String(t.id).slice(t.origin.length+1) : t.id),title:t.title,artist:primaryArtist(t),album:albumName(t),duration:t.duration,cover_url:t.cover_url || ""});const j=await r.json();if(!r.ok)throw Error(j.error||"Peer unavailable");ref=j.ref;}
    const r=await postJSON(`/api/user/playlists/${enc(id)}/tracks`,{track_id:ref});
    if(!r.ok)throw Error((await r.json()).error||"Could not add track");
  }
}
$("#playlistAdd").addEventListener("click",()=>{const t=cur();if(t)openPlaylistAdd([t.id]);});
// Copy all songs to a private playlist, or append the songs to one you already own.
// The peer URL + original track ID are retained so playback uses the source server.
async function registerPlaylistTracks(p){
  const ids=arr(p.tracks);const refs=new Array(ids.length);
  let cursor=0;
  const worker=async()=>{
    while(cursor<ids.length){const i=cursor++,id=ids[i];const t=byId[id]||peerTrackLookup.get(id);
      if(!t)throw Error(`Track ${i+1} is unavailable from the source. No changes saved.`);
      if(!t.origin){refs[i]=id;continue;}
      const remoteId=t.remote_id||(String(t.id).startsWith(t.origin+'|')?String(t.id).slice(t.origin.length+1):t.id);
      const r=await postJSON('/api/peer-track-ref',{origin:registeredPeerOrigin(t.origin),id:remoteId,title:t.title,artist:primaryArtist(t),album:albumName(t),duration:t.duration,cover_url:t.cover_url||''});
      const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||`Could not register ${t.title||'peer track'}`);refs[i]=j.ref;
    }
  };
  await Promise.all(Array.from({length:Math.min(5,ids.length)},worker));return refs;
}
async function openPlaylistCopy(p){
  document.getElementById('copyPlaylistDlg')?.remove();
  const r=await fetch('/api/user/playlists');if(!r.ok){popup('Session expired','Please sign in again.');return;}
  const owned=arr(await r.json());const d=document.createElement('dialog');d.id='copyPlaylistDlg';d.className='playlist-edit-dialog';
  d.innerHTML=`<form class="playlist-copy-form" method="dialog"><div class="playlist-edit-modal-header"><h2>Save playlist</h2><button class="playlist-modal-close" type="button" id="copyClose" aria-label="Close">×</button></div>
    <p class="muted">${esc(p.name)} · ${p.tracks?.length||0} songs</p>
    <label class="playlist-copy-option"><input type="radio" name="copyMode" value="new" checked> Copy to a new playlist</label>
    <label class="playlist-copy-field" id="copyNameWrap">Playlist name<input id="copyName" maxlength="80" value="${esc(p.name+' (copy)')}"></label>
    <label class="playlist-copy-option"><input type="radio" name="copyMode" value="existing"> Add all songs to an existing playlist</label>
    <label class="playlist-copy-field" id="copyExistingWrap" hidden>Choose your playlist<select id="copyExisting">${owned.map(x=>`<option value="${esc(x.id)}">${esc(x.name)} (${x.is_public?'public':'private'})</option>`).join('')}</select></label>
    <p class="muted">New copies use a 3 × 3 album-art cover. You can upload your own cover later.</p>
    <p class="msg err" id="copyError" role="alert"></p><div class="playlist-edit-actions"><button type="button" class="btn ghost" id="copyCancel">Cancel</button><button type="submit" class="btn" id="copySave">Save playlist</button></div>
  </form>`;
  document.body.append(d);d.showModal();
  d.addEventListener('close',()=>d.remove(),{once:true});
  const mode=()=>d.querySelector('input[name="copyMode"]:checked').value;
  function toggle(){const existing=mode()==='existing';d.querySelector('#copyNameWrap').hidden=existing;d.querySelector('#copyExistingWrap').hidden=!existing;d.querySelector('#copySave').textContent=existing?'Add songs':'Copy playlist';}
  d.querySelectorAll('input[name="copyMode"]').forEach(x=>x.onchange=toggle);
  d.querySelector('#copyClose').onclick=()=>d.close();d.querySelector('#copyCancel').onclick=()=>d.close();
  d.querySelector('form').onsubmit=async e=>{
    e.preventDefault();const save=d.querySelector('#copySave'),err=d.querySelector('#copyError');save.disabled=true;err.textContent='';
    try{
      const name=d.querySelector('#copyName').value.trim();const existing=mode()==='existing';
      if(existing&&!d.querySelector('#copyExisting').value)throw Error('You have no playlists yet. Choose New playlist.');
      if(!existing&&!name)throw Error('Enter a playlist name.');
      const refs=await registerPlaylistTracks(p);
      if(existing){const id=d.querySelector('#copyExisting').value;
        const r=await postJSON(`/api/user/playlists/${enc(id)}/tracks/batch`,{tracks:refs});const j=await r.json().catch(()=>({}));
        if(!r.ok)throw Error(j.error||'Could not add songs.');d.close();await load();location.hash='#userplaylist/'+enc(id);popup('Songs added',`${j.added??refs.length} songs added to your playlist.`);
      }else{const r=await postJSON('/api/user/playlists/copy',{name,tracks:refs});const j=await r.json().catch(()=>({}));
        if(!r.ok)throw Error(j.error||'Could not copy playlist.');if(j.skipped)throw Error(`${j.skipped} songs could not be copied.`);
        d.close();await load();location.hash='#userplaylist/'+enc(j.id);popup('Playlist copied','Your copy includes the source tracks and a nine-tile album-art cover.');}
    }catch(x){err.textContent=x.message||'Unable to save.';}finally{save.disabled=false;}
  };
}

document.addEventListener("click",async e=>{
  const copy=e.target.closest('[data-copy-playlist]');if(copy){
    if(currentAccount?.role!=='user'){popup('Sign in required','Sign in with a user account to save playlists.');return;}
    const p=[...playlists,...peerPlaylists,...userPublicPlaylists].find(x=>x.id===copy.dataset.copyPlaylist);
    if(p)openPlaylistCopy(p);return;
  }
  const b=e.target.closest(".album-add");if(b)openPlaylistAdd(b.dataset.albumIds.split(","));
  const arrow=e.target.closest(".hnav");if(arrow){const sc=arrow.closest(".hsec")?.querySelector(".hrow");sc?.scrollBy({left:Number(arrow.dataset.scroll)*Math.max(240,sc.clientWidth*.8),behavior:"smooth"});}
});
$("#playlistCancel").onclick=()=>$("#playlistDialog").close();
$("#playlistSave").onclick=async()=>{
 const b=$("#playlistSave"), ids=$("#playlistDialog").dataset.ids.split(",");b.disabled=true;
 try{
  let id=$("#playlistOptions").value;
  const name=$("#newPlaylistName").value.trim();
  if(name){const r=await postJSON("/api/user/playlists",{name,is_public:$("#newPlaylistPublic").checked});const j=await r.json();if(!r.ok)throw Error(j.error);id=j.id;}
  if(!id)throw Error("Choose or create a playlist.");
  await addToPlaylist(id,ids);$("#playlistDialog").close();$("#newPlaylistName").value="";
 }catch(e){$("#playlistMessage").textContent=e.message;}finally{b.disabled=false;}
};
$("#lregister").onclick=()=>{$("#dlg").close();$("#registerDlg").showModal();};
$("#regCancel").onclick=()=>$("#registerDlg").close();
$("#registerForm").onsubmit=async e=>{
 e.preventDefault();const r=await postJSON("/api/register",{username:$("#regUser").value,password:$("#regPw").value,confirm:$("#regPw2").value});const j=await r.json();
 if(!r.ok){$("#regErr").textContent=j.error;return;}
 $("#registerDlg").close();$("#dlg").showModal();$("#lid").value=$("#regUser").value;
};
$("#accountMenu").addEventListener("mouseenter",()=>{if(currentAccount?.authenticated)$("#accountDrop").classList.remove("hidden");});
$("#accountMenu").addEventListener("mouseleave",()=>$("#accountDrop").classList.add("hidden"));
$("#gear").addEventListener("click",e=>{if(currentAccount?.authenticated){e.stopPropagation();$("#accountDrop").classList.toggle("hidden");}});
document.addEventListener("click",e=>{if(!e.target.closest("#accountMenu"))$("#accountDrop").classList.add("hidden");});
$("#userLogout").onclick=async()=>{await fetch("/api/logout",{method:"POST"});location.href="/#home";location.reload();};
window.addEventListener("hashchange",()=>{refreshAccount();});
refreshAccount();

paintRepeat(); paintVol(); paintReact(); paintShuffle(); renderQueue();
load();

// The announcement feed remains active for guests and registered users alike.
// A short public shared-edge cache keeps repeated checks from hitting D1 per user.
setInterval(()=>{if(document.visibilityState==='visible')void pollServerAnnouncements();},2000);
// Account approval state is independent of the server-wide announcement feed.
setInterval(()=>{if(document.visibilityState==='visible'&&currentAccount?.role==='user')void refreshAccount();},30000);
