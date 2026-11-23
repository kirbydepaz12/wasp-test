import { readTags } from "/id3.js";
import { renderSidebarBBCode, legacySidebarToBBCode } from "/sidebar-bbcode.js";
import { artistArt, albumArt, albumName, artistsOf, artistLine, adDoc, AD_SANDBOX } from "/art.js";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const post = (url, body, method = "POST") =>
  fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const mode = () => document.querySelector("input[name=mode]:checked").value;
const HINTS = {
  singles: "Songs are sorted by artist. If a song's tags include an album, it is filed under that album too.",
  playlist: "Songs are sorted by artist and album from their tags, and all of them are also added to this playlist. A song already in the library is not uploaded again, just added to the playlist.",
  album: "Songs are filed under the artist's album. Leave a field blank to use each file's own tags.",
};
const KIND = { song: "Song", artist: "Artist", album: "Album", playlist: "Playlist" };
const small = 'style="min-height:36px;padding:0 14px"';
const mini = (src, label) => `<span class="art" data-i="${esc((label || "?").trim().charAt(0).toUpperCase())}">${src ? `<img alt="" src="${esc(src)}">` : ""}</span>`;
document.addEventListener("error", (e) => { if (e.target.tagName === "IMG") e.target.remove(); }, true);

// ---------- sections (left menu) ----------
const PANES = { collection: "Music collection", duplicates: "Duplicate management", add: "Add music", playlists: "Playlists", requests: "Requests", settings: "General settings", account: "Account settings", network: "Network, Metadata, Telemetry", processes: "Running processes", danger: "Danger", users: "Users & Announcements", docs: "Update documentations" };
function showPane() {
  const route = location.hash.slice(1);
  const section = route.split("/")[0];
  const k = has(PANES, section) ? section : "collection";
  $("#anav").innerHTML = Object.entries(PANES).filter(([id])=>id!=="docs").map(([id, label]) =>
    `<a class="nav-item${id === "danger" ? " dng" : ""}" href="#${id}"${id === k ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  adminPublishNotificationBadge(pendingPublishCount);
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("hidden", p.id !== "s-" + k));
  if (k === "settings") showSettingsSubtab(route.split("/")[1] === "release-updates" ? "release-updates" : "general");
  if (k === "duplicates") loadDuplicates();
  if (k === "processes") showOperationsTab(route.split("/")[1] === "logs" ? "logs" : "running");
  if (k === "users") showUsersTab(route.split("/")[1] === "announcements" ? "announcements" : "accounts");
  $("#docsNav").setAttribute("aria-current",k==="docs"?"page":"false");
  if (k === "docs") loadDocs();
  if (k === "requests") showRequestTab(route === "requests/spotify");
  if (k === "network") showNetworkTab(route.split("/")[1] || "peers");
  pollAdminPublishRequests();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", showPane);
// Community publishing: global default, per-account exceptions, searchable/sortable statistics.
function showUsersTab(which='accounts'){
  const announcements=which==='announcements';
  $('#usersAccountsPanel').classList.toggle('hidden',announcements);
  $('#usersAnnouncementsPanel').classList.toggle('hidden',!announcements);
  $('#usersTabAccounts').setAttribute('aria-selected',String(!announcements));
  $('#usersTabAnnouncements').setAttribute('aria-selected',String(announcements));
  if(announcements)void loadAnnouncementHistory();else void loadUsers();
}
$('#usersTabAccounts').onclick=()=>{location.hash='users';showUsersTab('accounts');};
$('#usersTabAnnouncements').onclick=()=>{location.hash='users/announcements';showUsersTab('announcements');};
// Templates use WASP's existing muted backgrounds and severity-colored accents.
const announcementTemplates=[
  {name:'Planned downtime',title:'Scheduled maintenance',body:'WASP may be temporarily unavailable while we deploy an update. Your playlists and music remain preserved.',severity:'maintenance',opacity:0.92},
  {name:'New music uploads',title:'New songs are available',body:'New music has been added to this server. Browse Recently added to discover the latest tracks.',severity:'upload',opacity:0.86},
  {name:'Requests being fulfilled',title:'Your music requests are being processed',body:'We are uploading requested music. Some songs may appear gradually as the catalogue refreshes.',severity:'info',opacity:0.86},
  {name:'Feature update',title:'WASP has been updated',body:'A new WASP update has been deployed. Refresh the page to see the latest improvements.',severity:'update',opacity:0.87},
  {name:'Service restored',title:'Service is back online',body:'WASP maintenance has finished. Music playback and browsing should be available again.',severity:'info',opacity:0.87},
  {name:'Urgent notice',title:'Important server notice',body:'Please check this announcement for important information about server availability.',severity:'critical',opacity:0.95}
];
const templatesContainer=$('#announcementTemplates');
for(const template of announcementTemplates){const button=document.createElement('button');button.type='button';button.className='btn ghost';button.textContent=template.name;button.onclick=()=>{
  $('#announcementTitle').value=template.title;$('#announcementBody').value=template.body;
  $('#announcementSeverity').value=template.severity;$('#announcementOpacity').value=String(template.opacity);paintAnnouncementPreview();
};templatesContainer.append(button);}
function paintAnnouncementPreview(){
  const preview=$('#announcementLivePreview');preview.dataset.severity=$('#announcementSeverity').value;
  preview.style.setProperty('--announcement-opacity',$('#announcementOpacity').value);
  $('#announcementOpacityValue').textContent=Math.round(Number($('#announcementOpacity').value)*100)+'%';
  $('#announcementPreviewTitle').textContent=$('#announcementTitle').value.trim()||'Your announcement title';
  $('#announcementPreviewBody').textContent=$('#announcementBody').value.trim()||'Your message appears here while you type.';
}
for(const id of ['announcementTitle','announcementBody','announcementSeverity','announcementOpacity'])
  $('#'+id).addEventListener('input',paintAnnouncementPreview);
paintAnnouncementPreview();
async function loadAnnouncementHistory(){
 const node=$('#announcementHistory');
 try{const r=await fetch('/api/admin/announcements',{cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error||'Unavailable');
   node.replaceChildren();if(!d.items.length){node.textContent='No announcements sent yet.';return;}
   for(const a of d.items){const item=document.createElement('div');item.className='announcement-history-item';
     const heading=document.createElement('strong');heading.textContent=a.title;
     const meta=document.createElement('small');meta.textContent=new Date(a.created_at).toLocaleString()+' · '+a.severity;
     const body=document.createElement('p');body.textContent=a.body;
     item.append(heading,meta,body);node.append(item);
   }
 }catch(e){node.textContent='Could not load announcements: '+e.message;}
}
$('#announcementForm').onsubmit=async e=>{
  e.preventDefault();const btn=$('#announcementSend'),status=$('#announcementMessage');
  const title=$('#announcementTitle').value.trim(),body=$('#announcementBody').value.trim();
  if(!title||!body){status.textContent='Title and message are required.';return;}
  if(!confirm('Send this announcement to everyone visiting this WASP server?'))return;
  btn.disabled=true;status.textContent='Sending…';
  try{const r=await post('/api/admin/announcements',{title,body,severity:$('#announcementSeverity').value,opacity:Number($('#announcementOpacity').value)});
    const d=await r.json();if(!r.ok)throw Error(d.error||'Could not send');
    status.textContent='Announcement saved. Visitors on this server will receive it when their browser checks for updates.';
    await loadAnnouncementHistory();
  }catch(err){status.textContent='Unable to send: '+err.message;}finally{btn.disabled=false;}
};
let registeredUsers = [], usersSortKey = '', usersSortDescending = false, pendingPublishCount=0;
const USER_COLUMNS = [
  ['username','Username','text'],['heart_songs','Heart songs','number'],
  ['like_songs','Like songs','number'],['dislike_songs','Dislike songs','number'],
  ['private_playlists','Private playlists','number'],['public_playlists','Published playlists','number'],
  ['provided_links','Provided links','number'],['online_links','Online links','number'],
  ['created_at','Registered date','date'],['can_publish','Can publish','number'],
];
function adminPublishNotificationBadge(count){
  pendingPublishCount=Math.max(0,Number(count)||0);
  const nav=document.querySelector('#anav a[href="#users"]');
  if(!nav)return;
  nav.classList.add('nav-has-notices');
  let badge=nav.querySelector('.publish-request-count');
  if(!badge){badge=document.createElement('span');badge.className='publish-request-count';nav.appendChild(badge);}
  badge.textContent=pendingPublishCount>99?'99+':String(pendingPublishCount);
  badge.hidden=pendingPublishCount===0;
  nav.setAttribute('aria-label',pendingPublishCount?`Users · ${pendingPublishCount} pending publish request${pendingPublishCount===1?'':'s'}`:'Users');
}
async function pollAdminPublishRequests(){
  if($('#panel').classList.contains('hidden'))return;
  try{const r=await fetch('/api/admin/users/publish-notifications',{cache:'no-store'});if(!r.ok)return;
    const data=await r.json();const before=pendingPublishCount;
    adminPublishNotificationBadge(data.pending);
    if(before!==pendingPublishCount && location.hash.split('/')[0]==='#users')await loadUsers();
  }catch{}
}
function renderUsersTable(){
  const el=$('#usersList');
  const search=$('#usersSearch').value.trim().toLocaleLowerCase();
  let rows=registeredUsers.filter(u=>String(u.username||'').toLocaleLowerCase().includes(search));
  if(usersSortKey){
    const column=USER_COLUMNS.find(c=>c[0]===usersSortKey);
    rows=[...rows].sort((a,b)=>{
      const av=a[usersSortKey],bv=b[usersSortKey];let difference;
      if(column?.[2]==='text')difference=String(av||'').localeCompare(String(bv||''),undefined,{sensitivity:'base',numeric:true});
      else difference=(Number(av)||0)-(Number(bv)||0);
      if(!difference)difference=String(a.username||'').localeCompare(String(b.username||''),undefined,{sensitivity:'base'});
      return usersSortDescending?-difference:difference;
    });
  }
  const sortControl=(key,title)=>{const active=usersSortKey===key;
    return `<button type="button" class="users-sort" data-sort="${key}" title="Sort by ${title}" aria-label="Sort by ${title}">${title}<span class="users-sort-indicator">${active?(usersSortDescending?' ▼':' ▲'):' ↕'}</span></button>`;};
  const heading=`<th>${sortControl('username','Username')}</th><th>${sortControl('heart_songs','Hearts')}<div class="users-subhead">${sortControl('like_songs','Likes')} / ${sortControl('dislike_songs','Dislikes')}</div></th><th>${sortControl('private_playlists','Private')}<div class="users-subhead">${sortControl('public_playlists','Published')}</div></th><th>${sortControl('provided_links','Provided')}<div class="users-subhead">${sortControl('online_links','Online')}</div></th><th>${sortControl('created_at','Joined')}</th><th>${sortControl('can_publish','Publish')}</th><th>Actions</th>`;
  const content=rows.map(u=>{
    const date=Number(u.created_at)?new Date(Number(u.created_at)).toLocaleDateString(undefined,{year:'2-digit',month:'short',day:'numeric'}):'—';
    const requested=!!u.publish_requested;
    return `<tr data-user-id="${esc(u.id)}">
      <td data-label="Username"><span class="users-name">${requested?'<span class="publish-request-dot" title="Publishing permission requested"></span>':''}<b>${esc(u.username)}</b></span></td>
      <td data-label="Reactions"><b>${Number(u.heart_songs)||0}</b><span class="users-small">L ${Number(u.like_songs)||0} · D ${Number(u.dislike_songs)||0}</span></td>
      <td data-label="Playlists"><b>${Number(u.private_playlists)||0}</b><span class="users-small">Public ${Number(u.public_playlists)||0}</span></td>
      <td data-label="Links"><b>${Number(u.provided_links)||0}</b><span class="users-small">Online ${Number(u.online_links)||0}</span></td>
      <td data-label="Joined"><time datetime="${Number(u.created_at)?new Date(Number(u.created_at)).toISOString():''}">${esc(date)}</time></td>
      <td data-label="Can publish"><label class="check"><input type="checkbox" data-user-publish="${esc(u.id)}" ${u.can_publish?'checked':''} aria-label="Allow ${esc(u.username)} to publish WASP links"><span>Allow</span></label></td>
      <td data-label="Actions"><button class="btn danger" type="button" data-delete-user="${esc(u.id)}" data-delete-name="${esc(u.username)}">Delete</button></td>
    </tr>`;
  }).join('');
  el.innerHTML=registeredUsers.length?`<div class="users-fitted"><table><thead><tr>${heading}</tr></thead><tbody>${content||'<tr><td colspan="7" class="muted">No usernames match the search.</td></tr>'}</tbody></table></div>`:'<p class="muted">No registered users yet.</p>';
}
async function loadUsers(){
  const el=$('#usersList');
  if(!el || $('#panel').classList.contains('hidden'))return;
  el.textContent='Checking registered users and online links…';
  try{
    const [userRes,defaultRes]=await Promise.all([
      fetch('/api/admin/users',{cache:'no-store'}),
      fetch('/api/admin/users/publish-default',{cache:'no-store'}),
    ]);
    if(!userRes.ok||!defaultRes.ok)throw Error('Unable to load publishing permissions');
    registeredUsers=await userRes.json();
    $('#publishAllUsers').checked=!!(await defaultRes.json()).enabled;
    renderUsersTable();
    adminPublishNotificationBadge(registeredUsers.filter(u=>u.publish_requested).length);
  }catch(e){el.textContent='Unable to load users: '+e.message;}
}
$('#usersSearch').addEventListener('input',renderUsersTable);
$('#publishAllUsers').addEventListener('change',async e=>{
  const checkbox=e.currentTarget;checkbox.disabled=true;
  try{
    const r=await post('/api/admin/users/publish-default',{enabled:checkbox.checked},'PUT');
    const data=await r.json();if(!r.ok)throw Error(data.error||'Unable to update global publishing');
    $('#usersMsg').textContent=checkbox.checked?'Publishing enabled by default for all accounts.':'Publishing disabled by default; individual permissions are retained.';
    await loadUsers();
  }catch(err){checkbox.checked=!checkbox.checked;$('#usersMsg').textContent=err.message;}
  finally{checkbox.disabled=false;}
});
$('#usersList').addEventListener('click',e=>{
  const sort=e.target.closest('[data-sort]');if(!sort)return;
  const key=sort.dataset.sort;
  if(!USER_COLUMNS.some(c=>c[0]===key))return;
  usersSortDescending=usersSortKey===key?!usersSortDescending:false;
  usersSortKey=key;renderUsersTable();
});
$("#usersList").addEventListener("change",async e=>{
  const t=e.target.closest("[data-user-publish]");if(!t)return;
  t.disabled=true;
  try {
    const r=await post(`/api/admin/users/${encodeURIComponent(t.dataset.userPublish)}/publish`,{enabled:t.checked},"PUT");
    const j=await r.json();if(!r.ok)throw Error(j.error||"Could not save permission");
    $("#usersMsg").textContent="Publishing permission updated.";
    await loadUsers();
  }catch(err){t.checked=!t.checked;$("#usersMsg").textContent=err.message;}
  t.disabled=false;
});
let pendingDeleteUser=null;
$("#usersList").addEventListener("click",e=>{
  const btn=e.target.closest("[data-delete-user]");if(!btn)return;
  pendingDeleteUser=btn.dataset.deleteUser;
  $("#deleteUserDescription").textContent=`Permanently delete ${btn.dataset.deleteName}, their account, playlists, attributed interactions and submitted links? Music files will remain.`;
  $("#deleteUserForm").reset();$("#deleteUserMsg").textContent="";
  $("#deleteUserDlg").showModal();
});
$("#deleteUserCancel").onclick=()=>$("#deleteUserDlg").close();
$("#deleteUserForm").onsubmit=async e=>{
  e.preventDefault();
  if(!pendingDeleteUser)return;
  if($("#deleteUserWord").value.trim()!=="delete"){$("#deleteUserMsg").textContent='Type exactly "delete".';return;}
  const btn=$("#deleteUserForm button[type=submit]");btn.disabled=true;
  try{
    const r=await post(`/api/admin/users/${encodeURIComponent(pendingDeleteUser)}`,{
      password:$("#deleteUserPassword").value,confirm:$("#deleteUserWord").value},"DELETE");
    const j=await r.json();if(!r.ok)throw Error(j.error||"Unable to delete account");
    $("#deleteUserDlg").close();$("#usersMsg").textContent="User and attributed data deleted.";pendingDeleteUser=null;await loadUsers();
  }catch(err){$("#deleteUserMsg").textContent=err.message;}finally{btn.disabled=false;}
};

// v18.1.2 — processes and administrator audit history.
let operationsTab='running',opsCursor=null,opsLogRows=[],opsPollTimer=null;
function showOperationsTab(which='running'){
  operationsTab=which==='logs'?'logs':'running';
  $('#opsRunningPanel').classList.toggle('hidden',operationsTab!=='running');
  $('#opsLogsPanel').classList.toggle('hidden',operationsTab!=='logs');
  for(const [key,id] of [['running','opsTabRunning'],['logs','opsTabLogs']]){
    const selected=key===operationsTab;const btn=$('#'+id);btn.classList.toggle('active',selected);btn.setAttribute('aria-selected',String(selected));
  }
  if(operationsTab==='logs')void loadOperationsLogs();else void loadOperations();
}
$('#opsTabRunning').onclick=()=>{location.hash='processes';showOperationsTab('running');};
$('#opsTabLogs').onclick=()=>{location.hash='processes/logs';showOperationsTab('logs');};
const opsDate=ms=>Number(ms)?new Date(Number(ms)).toLocaleString():'—';
async function loadOperations(){
  try{const r=await fetch('/api/admin/processes',{cache:'no-store'});if(!r.ok)throw Error('Unable to load processes');const data=await r.json();
    $('#opsObserved').textContent='Last updated '+opsDate(data.observed_at);
    $('#opsProcessList').innerHTML=data.processes?.length?data.processes.map(p=>`<div class="ops-item"><div class="form" style="justify-content:space-between;gap:8px"><strong>${esc(p.name)}</strong><span class="ops-state" data-state="${esc(p.state)}">${esc(p.state)}</span></div><small>${esc(p.category||'Operation')} · ${opsDate(p.started_at||p.updated_at)}</small>${p.message?`<p class="muted">${esc(p.message)}</p>`:''}${p.progress!==null&&p.progress!==undefined?`<progress max="100" value="${Math.max(0,Math.min(100,Number(p.progress)||0))}"></progress>`:''}</div>`).join(''):'<p class="muted">No tracked operations yet. New jobs appear here as they run.</p>';
  }catch(e){$('#opsProcessList').textContent=e.message;}
}
$('#opsRefresh').onclick=loadOperations;
async function loadOperationsLogs(more=false){
  const target=$('#opsLogList');if(!more){opsCursor=null;opsLogRows=[];target.textContent='Loading…';}
  try{const url='/api/admin/processes/logs'+(more&&opsCursor?'?before='+encodeURIComponent(opsCursor):'');const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw Error('Unable to load logs');const data=await r.json();
    opsLogRows.push(...(data.entries||[]));opsCursor=data.next||null;
    target.innerHTML=opsLogRows.length?`<div class="ops-log-list">${opsLogRows.map(x=>`<div class="ops-log"><time>${opsDate(x.happened_at)}</time><span>${esc(x.actor)}</span><code>${esc(x.method)} ${esc(x.action)}</code><b class="${x.status>=400?'ops-error':'ops-ok'}">HTTP ${Number(x.status)||0}</b></div>`).join('')}</div>`:'<p class="muted">No logged actions yet.</p>';
    $('#opsLogsMore').classList.toggle('hidden',!opsCursor);
  }catch(e){$('#opsLogsMessage').textContent=e.message;}
}
$('#opsLogsRefresh').onclick=()=>loadOperationsLogs(false);
$('#opsLogsMore').onclick=()=>loadOperationsLogs(true);
$('#opsLogsClear').onclick=async()=>{
  if(!confirm('Clear this server’s administrative action history? This cannot be undone.'))return;
  const phrase=prompt('Type clear logs to confirm deleting the history:');if(phrase!=='clear logs')return;
  try{const r=await post('/api/admin/processes/logs/clear',{confirm:phrase},'DELETE');if(!r.ok)throw Error((await r.json()).error||'Failed');
    $('#opsLogsMessage').textContent='Logs cleared. This action remains as the first new entry.';await loadOperationsLogs(false);
  }catch(e){$('#opsLogsMessage').textContent=e.message;}
};
$('#opsLogsDownload').onclick=async()=>{
  const btn=$('#opsLogsDownload');btn.disabled=true;$('#opsLogsMessage').textContent='Preparing text export…';
  try{let cursor='',entries=[],pages=0;
    do{const r=await fetch('/api/admin/processes/logs'+(cursor?'?before='+encodeURIComponent(cursor):''),{cache:'no-store'});if(!r.ok)throw Error('Unable to export logs');const data=await r.json();entries.push(...(data.entries||[]));cursor=data.next||'';pages++;if(pages>500)throw Error('Export too large; ask admin to clear old logs or export smaller intervals.');}while(cursor);
    const text=['WASP administrative action log','Exported: '+new Date().toISOString(),'Includes admin actions recorded since v18.1.2; no passwords or request bodies.','',...entries.map(x=>`${new Date(x.happened_at).toISOString()} | ${x.actor} | ${x.method} ${x.action} | HTTP ${x.status}`)].join('\n');
    const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='wasp-admin-logs-'+new Date().toISOString().slice(0,10)+'.txt';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000);
    $('#opsLogsMessage').textContent=`Downloaded ${entries.length} logged actions.`;
  }catch(e){$('#opsLogsMessage').textContent=e.message;}finally{btn.disabled=false;}
};
setInterval(()=>{if(location.hash.split('/')[0]==='#processes'&&operationsTab==='running'&&!document.hidden&&!$('#panel').classList.contains('hidden'))void loadOperations();},5000);

async function show() {
  const { admin } = await (await fetch("/api/me")).json();
  $("#login").classList.toggle("hidden", admin);
  $("#panel").classList.toggle("hidden", !admin);
  if (admin) {
    const me=await(await fetch("/api/me",{cache:"no-store"})).json();
    $("#adminAccountName").textContent=me.username||"admin";
    $("#adminNewName").value=me.username||"admin";
    showPane(); refresh(); loadPlaylists(); loadRequests(); loadSite(); loadNetwork(); syncMode();
    void checkReleases();
    fetch("/api/admin/version",{cache:"no-store"}).then(r=>r.json()).then(v=>{
      $("#adminBuild").textContent=`WASP v${v.version||"?"} · ${v.label||""}`;
    }).catch(()=>{$("#adminBuild").textContent="WASP · Version unavailable";});
  }
}
function syncMode() {
  $("#plField").classList.toggle("hidden", mode() !== "playlist");
  $("#alField").classList.toggle("hidden", mode() !== "album");
  $("#hint").textContent = HINTS[mode()];
}
document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", syncMode));

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await post("/api/login", { id: $("#id").value, password: $("#pw").value });
  if (r.ok) { $("#pw").value = ""; $("#loginMsg").textContent = ""; show(); }
  else $("#loginMsg").textContent = (await r.json()).error;
});
$("#logout").addEventListener("click", async () => { await post("/api/logout", {}); show(); });

// ---------- music collection (30 per page, newest first) ----------
const PAGE = 30;
let page = 1, songQ = "", imgFor = null;
async function refresh() {
  window.__tracks = await (await fetch("/api/tracks")).json().then((x) => (Array.isArray(x) ? x : [])).catch(() => []);
  renderSongs();
}
function renderSongs() {
  const all = (window.__tracks || []).filter((t) => !songQ || `${t.title} ${t.artist} ${albumName(t)}`.toLowerCase().includes(songQ));
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  page = Math.min(Math.max(1, page), pages);
  const from = (page - 1) * PAGE, list = all.slice(from, from + PAGE);
  $("#count").textContent = all.length ? `(${from + 1}–${from + list.length} of ${all.length})` : "(0)";
  $("#rows").innerHTML = list.length ? list.map((t) => `<tr data-id="${t.id}">
    <td>${esc(t.title)}</td><td>${esc(artistLine(t))}</td><td>${esc(albumName(t) || "Single")}</td><td>${t.plays}</td>
    <td style="white-space:nowrap"><button class="btn ghost" data-act="edit" ${small}>Edit</button>
    <button class="btn danger" data-act="del" ${small}>Delete</button></td></tr>`).join("")
    : `<tr><td colspan="5" class="muted">${songQ ? "No songs match your search." : "No songs yet. Add some under Add music."}</td></tr>`;
  $("#pager").innerHTML = pages > 1 ? pagerHtml(page, pages) : "";
}
function pagerHtml(cur, pages) {
  const set = new Set([1, pages]);
  for (let i = cur - 2; i <= cur + 2; i++) if (i >= 1 && i <= pages) set.add(i);
  let out = `<button class="pg" data-p="${cur - 1}" aria-label="Previous page"${cur === 1 ? " disabled" : ""}>‹</button>`, prev = 0;
  for (const n of [...set].sort((a, b) => a - b)) {
    if (n - prev > 1) out += '<span class="muted" aria-hidden="true">…</span>';
    out += `<button class="pg" data-p="${n}" aria-label="Page ${n}"${n === cur ? ' aria-current="page"' : ""}>${n}</button>`;
    prev = n;
  }
  return out + `<button class="pg" data-p="${cur + 1}" aria-label="Next page"${cur === pages ? " disabled" : ""}>›</button>`;
}
$("#pager").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-p]");
  if (b && !b.disabled) { page = +b.dataset.p; renderSongs(); $("#songQ").scrollIntoView({ block: "center" }); }
});
$("#songQ").addEventListener("input", (e) => { songQ = e.target.value.trim().toLowerCase(); page = 1; renderSongs(); });
$("#rows").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const id = b.closest("tr").dataset.id, t = window.__tracks.find((x) => x.id === id);
  if (b.dataset.act === "del") {
    if (confirm(`Delete "${t.title}"? This removes the file and takes it out of every playlist.`)) { await fetch("/api/admin/tracks/" + id, { method: "DELETE" }); refresh(); loadPlaylists(); }
  } else {
    const title = prompt("Title", t.title); if (title === null) return;
    const artist = prompt('Artist(s). Separate several artists with ";". Add a ";" at the end to keep a comma inside one name.', artistsOf(t).join("; ")); if (artist === null) return;
    const album = prompt("Album (leave empty for a single)", albumName(t)); if (album === null) return;
    await post("/api/admin/tracks/" + id, { title, artist, album }, "PATCH"); refresh();
  }
});

// ---------- playlists: 15 per page, search, view / add / remove songs ----------
const PL_PAGE = 15;
let plPage = 1, plQ = "";
const openPl = new Set(), addOpen = new Set(), addQ = new Map();
async function loadPlaylists() {
  const pls = await (await fetch("/api/playlists")).json().then((x) => (Array.isArray(x) ? x : [])).catch(() => []);
  window.__pls = pls;
  $("#plList").innerHTML = pls.map((p) => `<option value="${esc(p.name)}">`).join("");
  renderPlaylists();
}
const songById = () => new Map((window.__tracks || []).map((t) => [t.id, t]));
function foundHtml(p) {
  const q = (addQ.get(p.id) || "").toLowerCase();
  if (!q) return `<p class="muted" style="margin:6px 0">Type to search your library.</p>`;
  const have = new Set(p.tracks);
  const hits = (window.__tracks || []).filter((t) => !have.has(t.id) && `${t.title} ${artistLine(t)} ${albumName(t)}`.toLowerCase().includes(q)).slice(0, 8);
  return hits.length ? `<ul class="missing">${hits.map((t) => `<li style="display:flex;align-items:center;justify-content:space-between;gap:10px"><span>${esc(t.title)} <span class="muted">· ${esc(artistLine(t))}</span></span><button class="btn ghost" data-a="addthis" data-id="${t.id}" ${small}>Add</button></li>`).join("")}</ul>`
    : `<p class="muted" style="margin:6px 0">No songs in the library match that (or they are already in this playlist).</p>`;
}
function detailHtml(p) {
  const by = songById(), songs = p.tracks.map((id) => by.get(id)).filter(Boolean), adding = addOpen.has(p.id);
  return `<div class="form" style="margin:8px 0"><button class="btn ghost" data-a="addsong" aria-expanded="${adding}" ${small}>Add song</button>${adding ? `<label class="hidden" for="plAdd-${p.id}">Search the library</label><input id="plAdd-${p.id}" data-addq="${p.id}" type="search" placeholder="Search the library" value="${esc(addQ.get(p.id) || "")}" style="flex:1;min-width:200px;max-width:360px;height:40px">` : ""}</div>
    ${adding ? `<div id="found-${p.id}">${foundHtml(p)}</div>` : ""}
    ${songs.length ? `<ul class="missing" style="max-height:340px">${songs.map((t) => `<li style="display:flex;align-items:center;justify-content:space-between;gap:10px"><button type="button" class="linkbtn" data-a="playsong" data-id="${t.id}" title="Play">▶ ${esc(t.title)} <span class="muted">· ${esc(artistLine(t))}</span></button><button class="btn danger" data-a="rmsong" data-id="${t.id}" ${small}>Remove</button></li>`).join("")}</ul>` : `<p class="muted" style="margin:8px 0">No songs in this playlist yet.</p>`}`;
}
function renderPlaylists() {
  const all = (window.__pls || []).filter((p) => !plQ || p.name.toLowerCase().includes(plQ));
  const pages = Math.max(1, Math.ceil(all.length / PL_PAGE));
  plPage = Math.min(Math.max(1, plPage), pages);
  const list = all.slice((plPage - 1) * PL_PAGE, plPage * PL_PAGE);
  $("#plRows").innerHTML = list.length ? `<table><tbody>${list.map((p) => {
    const open = openPl.has(p.id);
    return `<tr data-pl="${p.id}">
    <td style="width:56px">${mini(p.cover_v ? `/art/playlist?id=${p.id}&v=${p.cover_v}` : "", p.name)}</td>
    <td>${esc(p.name)}<br><span class="muted">${p.tracks.length} songs · ${p.cover_v ? "custom image" : "automatic album grid"}</span></td>
    <td style="text-align:right;white-space:nowrap"><button class="btn ghost" data-a="view" aria-expanded="${open}" ${small}>${open ? "Collapse" : "View"}</button>
    <button class="btn ghost" data-a="img" ${small}>Change image</button>
    ${p.cover_v ? `<button class="btn ghost" data-a="reset" ${small}>Use automatic</button>` : ""}
    <button class="btn danger" data-a="del" ${small}>Delete</button></td></tr>${open ? `<tr class="reqdetail" data-pd="${p.id}"><td></td><td colspan="2">${detailHtml(p)}</td></tr>` : ""}`;
  }).join("")}</tbody></table>` : plQ ? "No playlists match your search." : "No playlists yet.";
  $("#plPager").innerHTML = pages > 1 ? pagerHtml(plPage, pages) : "";
}
$("#plQ").addEventListener("input", (e) => { plQ = e.target.value.trim().toLowerCase(); plPage = 1; renderPlaylists(); });
$("#plPager").addEventListener("click", (e) => { const b = e.target.closest("button[data-p]"); if (b && !b.disabled) { plPage = +b.dataset.p; renderPlaylists(); $("#plQ").scrollIntoView({ block: "center" }); } });
$("#plRows").addEventListener("input", (e) => { // search while adding a song: only the result list is redrawn, so typing is not interrupted
  const i = e.target.closest("[data-addq]"); if (!i) return;
  addQ.set(i.dataset.addq, i.value.trim());
  const p = (window.__pls || []).find((x) => x.id === i.dataset.addq), box = $(`#found-${i.dataset.addq}`);
  if (p && box) box.innerHTML = foundHtml(p);
});
$("#plRows").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b || !b.dataset.a) return;
  const tr = b.closest("tr"), id = tr.dataset.pl || tr.dataset.pd, act = b.dataset.a;
  const p = (window.__pls || []).find((x) => x.id === id) || {};
  if (act === "view") { openPl.has(id) ? openPl.delete(id) : openPl.add(id); renderPlaylists(); return; }
  if (act === "addsong") { addOpen.has(id) ? addOpen.delete(id) : addOpen.add(id); renderPlaylists(); const i = $(`[data-addq="${id}"]`); if (i) i.focus(); return; }
  if (act === "playsong") {
    const t = songById().get(b.dataset.id), a = $("#plAudio");
    $("#plPlayer").classList.remove("hidden"); $("#plNow").textContent = t ? `Now playing: ${t.title} · ${artistLine(t)}` : "";
    a.src = "/audio/" + b.dataset.id; a.play().catch(() => {}); return;
  }
  if (act === "rmsong") {
    const t = songById().get(b.dataset.id);
    if (!confirm(`Remove "${t ? t.title : "this song"}" from "${p.name}"? The song stays in the library.`)) return;
    await fetch(`/api/admin/playlists/${id}/tracks/${b.dataset.id}`, { method: "DELETE" }); await loadPlaylists(); return;
  }
  if (act === "addthis") {
    await post(`/api/admin/playlists/${id}/tracks`, { track_id: b.dataset.id });
    await loadPlaylists(); const i = $(`[data-addq="${id}"]`); if (i) i.focus(); return;
  }
  if (act === "img") { imgFor = id; $("#plImg").click(); }
  else if (act === "reset") { await fetch(`/api/admin/playlists/${id}/cover`, { method: "DELETE" }); loadPlaylists(); }
  else if (act === "del" && confirm(`Delete the playlist "${p.name}"? The songs stay in the library.`)) { await fetch("/api/admin/playlists/" + id, { method: "DELETE" }); openPl.delete(id); loadPlaylists(); }
});
$("#plImg").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  const msg = $("#plMsg"); msg.className = "msg err"; msg.textContent = "";
  if (!f || !imgFor) return;
  if (!/^image\/(jpeg|png|webp)$/.test(f.type) || f.size > 5 * 1024 * 1024) { msg.textContent = "Choose a JPEG, PNG or WebP image under 5 MB."; return; }
  const r = await fetch(`/api/admin/playlists/${imgFor}/cover`, { method: "PUT", headers: { "content-type": f.type }, body: f });
  if (r.ok) { msg.className = "msg"; msg.textContent = "Playlist image updated."; loadPlaylists(); }
  else msg.textContent = (await r.json().catch(() => ({}))).error || "Upload failed.";
});

// Spotify settings live in Requests, not in public site branding settings.
let spotifyConfigLoaded = false;
function showRequestTab(spotify) {
  $("#spotifyHttpsWarning").classList.toggle("hidden", location.protocol === "https:" || ["localhost", "127.0.0.1", ""].includes(location.hostname));
  $("#reqTabQueue").setAttribute("aria-selected", String(!spotify));
  $("#reqTabSpotify").setAttribute("aria-selected", String(spotify));
  $("#reqQueuePanel").classList.toggle("hidden", spotify);
  $("#reqSpotifyPanel").classList.toggle("hidden", !spotify);
  if (spotify && !spotifyConfigLoaded) loadSpotifyConfig();
}
$("#reqTabQueue").addEventListener("click", () => { location.hash = "requests"; showRequestTab(false); });
$("#reqTabSpotify").addEventListener("click", () => { location.hash = "requests/spotify"; showRequestTab(true); });
async function loadSpotifyConfig() {
  const state = $("#spotifyConfigState"), msg = $("#spotifyConfigMsg");
  state.textContent = "Loading Spotify settings…";
  try {
    const r = await fetch("/api/admin/spotify-config", { headers: { accept: "application/json" }, cache: "no-store" });
    const data = await r.json();
    if (!r.ok) throw Error(data.error || "Unable to load settings.");
    spotifyConfigLoaded = true;
    $("#spotifyClientId").value = data.client_id || "";
    $("#spotifyClientSecret").value = "";
    $("#spotifySecretHint").textContent = data.saved_in_admin
      ? "A secret is saved. Leave this field empty to keep it, or enter a new secret to replace it."
      : (data.secret_configured ? "Credentials are supplied by the server environment. Enter new values to override them." : "Enter the Client ID and Client Secret from your Spotify Developer app.");
    $("#spotifyConfigDelete").disabled = !data.saved_in_admin;
    state.textContent = data.locked
      ? "Saved credentials cannot be decrypted with the current server key. Enter a new secret to repair them."
      : (data.saved_in_admin ? "Spotify credentials saved securely on this server." : data.source === "environment" ? "Using credentials supplied by the server environment." : "Spotify playlist search is not configured.");
    if (!data.storage_ready) {
      state.textContent += " To save credentials in this page, first configure SPOTIFY_SETTINGS_KEY as a server secret.";
    }
    msg.textContent = "";
  } catch (e) {
    spotifyConfigLoaded = false;
    state.textContent = "";
    flashMsg("#spotifyConfigMsg", e.message || "Unable to load settings.", true);
  }
}
$("#spotifySettingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const save = $("#spotifyConfigSave");
  const id = $("#spotifyClientId").value.trim(), secret = $("#spotifyClientSecret").value;
  save.disabled = true;
  try {
    const r = await post("/api/admin/spotify-config", { client_id: id, client_secret: secret }, "PUT");
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(d.error || "Unable to save Spotify credentials.");
    $("#spotifyClientSecret").value = "";
    spotifyConfigLoaded = false;
    await loadSpotifyConfig();
    flashMsg("#spotifyConfigMsg", "Spotify credentials saved. Playlist search will use them if Spotify grants API access.");
  } catch (e) { flashMsg("#spotifyConfigMsg", e.message, true); }
  finally { save.disabled = false; }
});
$("#spotifyConfigDelete").addEventListener("click", async () => {
  if (!confirm("Remove saved Spotify credentials from this server? The paste-link option will still work.")) return;
  const btn = $("#spotifyConfigDelete"); btn.disabled = true;
  try {
    const r = await fetch("/api/admin/spotify-config", { method: "DELETE" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(d.error || "Unable to remove credentials.");
    spotifyConfigLoaded = false;
    await loadSpotifyConfig();
    flashMsg("#spotifyConfigMsg", "Saved Spotify credentials removed.");
  } catch (e) { flashMsg("#spotifyConfigMsg", e.message, true); }
  finally { btn.disabled = false; }
});

// ---------- requests ----------
const openReq = new Set();
const selectedRequests=new Set();let housekeepingBusy=false;
function paintRequestSelection(){
  const list=window.__reqs||[];
  $('#reqRemoveSelected').disabled=housekeepingBusy||!selectedRequests.size;
  $('#reqRefreshSelected').disabled=housekeepingBusy||!selectedRequests.size;
  $('#reqRefreshSelected').textContent=`Refresh selected${selectedRequests.size?' ('+selectedRequests.size+')':''}`;
  $('#reqRemoveSelected').textContent=`Remove selected${selectedRequests.size?' ('+selectedRequests.size+')':''}`;
  $('#reqSelectAll').textContent=list.length&&list.every(r=>selectedRequests.has(r.id))?'Clear selection':'Select visible';
  $('#reqSelectAll').disabled=housekeepingBusy||!list.length;
  $('#reqRemoveRemote').disabled=housekeepingBusy||!list.some(r=>r.remote);
  $('#reqRemoveAll').disabled=housekeepingBusy||!list.length;
}
async function requestHousekeeping(mode,ids=[]){
  if(housekeepingBusy)return;
  const local=mode==='all'||(mode==='selected'&&ids.some(id=>!id.includes('|')));
  if(!confirm(`${mode==='remote'?'Remove all received HIVE requests':mode==='all'?'Remove all active requests':`Remove ${ids.length} selected request(s)`}? Remote requests are permanently dismissed only on this WASP (including offline origins). Use Remove until online for temporary offline removal.${local?' Local requests will be cancelled on HIVE.':''} Music and completed history are kept.`))return;
  housekeepingBusy=true;paintRequestSelection();
  try{
    const batches=mode==='selected'?Array.from({length:Math.ceil(ids.length/8)},(_,i)=>ids.slice(i*8,i*8+8)):[[]];
    let removed=0,more=false;
    for(const batch of batches){
      let rounds=0;do{
        const res=await post('/api/admin/requests/housekeeping',{mode,ids:batch,confirm:true});
        const j=await res.json();if(!res.ok)throw Error(j.error||'Unable to remove requests');
        removed+=Number(j.local||0)+Number(j.remote||0);more=!!j.more;
      }while(more&&++rounds<64);
    }
    selectedRequests.clear();openReq.clear();flashMsg('#reqMsg',`${removed} request(s) removed.${more?' More requests remain; repeat to finish.':''}`);
  }catch(e){flashMsg('#reqMsg',e.message,true);}
  finally{housekeepingBusy=false;await loadRequests();}
}
$('#reqSelectAll').onclick=()=>{const list=window.__reqs||[];const all=list.every(r=>selectedRequests.has(r.id));selectedRequests.clear();if(!all)list.forEach(r=>selectedRequests.add(r.id));document.querySelectorAll('#reqRows [data-request-select]').forEach(x=>x.checked=selectedRequests.has(x.dataset.requestSelect));paintRequestSelection();};
async function reviewRequests(action,ids,confirmDone=false){
  if(housekeepingBusy||!ids.length)return;
  housekeepingBusy=true;paintRequestSelection();
  try{
    let all=[];for(let i=0;i<ids.length;i+=8){const res=await post('/api/admin/requests/review',{action,ids:ids.slice(i,i+8),confirm:confirmDone,live:action==='locate'});const j=await res.json();if(!res.ok)throw Error(j.error||'Review failed');all.push(...j.results);}
    const errors=all.filter(r=>r.error);const done=all.filter(r=>r.status==='done').length;
    if(action==='locate'){const first=all[0];flashMsg('#reqMsg',first.origin_domain?`${first.origin_domain} · ${first.origin_status==='offline'?'Requestee is offline':first.origin_status}`:'Origin not verified from directly connected peers.',!!first.error);}
    else flashMsg('#reqMsg',`${all.length-errors.length} request(s) ${action==='hide-offline'?'temporarily hidden':action==='complete'?'completed':'checked'}${done?` · ${done} moved to Previous requests`:''}${errors.length?' · '+errors.map(r=>r.error).join('; '):''}`,!!errors.length);
    selectedRequests.clear();
  }catch(e){flashMsg('#reqMsg',e.message,true);}finally{housekeepingBusy=false;await loadRequests();}
}
$('#reqRefreshSelected').onclick=()=>reviewRequests('refresh',[...selectedRequests]);
$('#reqRemoveSelected').onclick=async()=>{const ids=[...selectedRequests],offline=ids.filter(id=>(window.__reqs||[]).some(r=>r.id===id&&r.remote&&r.origin_status==='offline')),other=ids.filter(id=>!offline.includes(id));if(offline.length&&confirm(`Temporarily remove ${offline.length} offline request(s) until their origin reconnects?`))await reviewRequests('hide-offline',offline);if(other.length)await requestHousekeeping('selected',other);};
$('#reqRemoveRemote').onclick=()=>requestHousekeeping('remote');
$('#reqRemoveAll').onclick=()=>requestHousekeeping('all');
$('#reqRows').addEventListener('change',e=>{const id=e.target.dataset.requestSelect;if(!id)return;e.target.checked?selectedRequests.add(id):selectedRequests.delete(id);paintRequestSelection();});
async function loadRequests() {
  let list = [];
  try { let res=await fetch('/api/admin/requests',{cache:'no-store'});if(res.status>=500){await new Promise(r=>setTimeout(r,800));res=await fetch('/api/admin/requests',{cache:'no-store'});}if(!res.ok)throw Error(`Request queue temporarily unavailable (HTTP ${res.status}). Retry shortly.`);list=await res.json(); } catch(e) { if(!window.__reqs?.length)$("#reqRows").textContent=e.message;else flashMsg('#reqMsg',e.message,true);return; }
  if (!Array.isArray(list)) list = [];
  window.__reqs = list;
  const visible=new Set(list.map(r=>r.id));for(const id of selectedRequests)if(!visible.has(id))selectedRequests.delete(id);
  paintRequestSelection();
  $("#reqRows").innerHTML = list.length ? `<table><tbody>${list.map((r) => {
    const pl = r.kind === "playlist", has = pl && r.total != null && Array.isArray(r.missing);
    const miss = has ? r.missing.length : 0;
    const sourceCount=Number.isSafeInteger(r.source_total)?r.source_total:null;
    const knownIncomplete=has && sourceCount!==null && sourceCount>r.total;
    const unverifiedBoundary=has && !!r.partial && !knownIncomplete;
    const progress = has ? `${r.matched}/${r.total}${knownIncomplete ? ` of ${sourceCount} reported` : unverifiedBoundary ? "+" : ""} · ${r.matched_local??r.matched} local · ${r.matched_peer||0} in peers · ${miss} missing song${miss === 1 ? "" : "s"}` : pl ? (r.total!=null ? "Availability check pending — refresh or wait for scheduled matching" : "Song list not available") : r.matched_local!=null ? `${r.matched_local} local · ${r.matched_peer||0} on peers` : "";
    const open = openReq.has(r.id);
    return `<tr data-r="${esc(r.id)}">
    <td style="width:76px"><label class="request-pick"><input type="checkbox" data-request-select="${esc(r.id)}" aria-label="Select ${esc(r.title)}" ${selectedRequests.has(r.id)?'checked':''}>${mini(r.image, r.title)}</label></td>
    <td>${esc(r.title)}${r.remote?' <span class="chip" title="Originating WASP retains ownership">HIVE peer</span>':''}<br><span class="muted">${KIND[r.kind]}${r.artist ? " · " + esc(r.artist) : ""}${r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener">Open on Spotify</a>` : ""}</span>${r.remote&&r.origin_status==='offline'?'<br><span class="muted">Requestee is offline</span>':''}${r.remote&&r.origin_domain?`<br><span class="muted">Origin: ${esc(r.origin_domain)} · ${esc(r.origin_status||'unknown')}</span>`:''}${progress ? `<br><span class="muted">${esc(progress)}${r.availability_checked_at?` · Checked ${esc(new Date(r.availability_checked_at).toLocaleString())}`:""}</span>` : ""}</td>
    <td style="text-align:right;white-space:nowrap">${has ? `<button class="btn ghost" data-a="toggle" aria-expanded="${open}" aria-label="Show missing songs" ${small}>${open ? "▴" : "▾"}</button> ` : ""}<button class="btn ghost" data-a="${pl&&!r.remote?'refresh':'review-refresh'}" ${small}>Refresh</button> ${pl&&!r.remote?`<button class="btn ghost" data-a="scan-matches" ${small}>Scan potential matches</button> <button class="btn ghost" data-a="done" ${small}>Mark as done</button>`:''} ${['artist','album'].includes(r.kind)?`<button class="btn ghost" data-a="review-done" ${small}>Mark as done</button> `:''}${r.remote?`<button class="btn ghost" data-a="locate" ${small}>Locate origin</button> `:''}<button class="btn ghost" data-a="${r.remote&&r.origin_status==='offline'?'hide-offline':'remove'}" ${small} title="${r.remote?'Dismiss on this WASP only':'Cancel local request'}">${r.remote&&r.origin_status==='offline'?'Remove until online':'Remove'}</button></td></tr>
    ${has ? `<tr class="reqdetail${open ? "" : " hidden"}" data-d="${r.id}"><td></td><td colspan="2">
      ${miss ? `<ul class="missing req-missing">${r.missing.map((x) => `<li class="req-match-entry" data-req-index="${Number.isInteger(x.request_index)?x.request_index:-1}"><div class="req-miss-header"><span>${esc(x.t)}${x.a ? ` <span class="muted">· ${esc(x.a)}</span>` : ""}</span>${!r.remote?` <button class="btn ghost" data-a="match-scan" ${small}>Find potential match</button> <button class="btn ghost" data-a="match-skip" ${small}>Remove from request</button>`:''}</div><div class="req-match-results"></div></li>`).join("")}</ul>` : `<p class="muted" style="margin:8px 0">Every song we can see is already in the library.</p>`}
      ${!r.remote?`<div class="request-manual-add"><label>Manually add a song to this request</label><input aria-label="Song title to add" data-req-song-title placeholder="Song title"><input aria-label="Artist to add" data-req-song-artist placeholder="Artist"><button type="button" class="btn ghost" data-a="match-add" ${small}>Add and find match</button></div>`:''}
      ${r.skipped?.length?`<details class="request-skipped"><summary>${r.skipped.length} removed request entries (restorable)</summary>${r.skipped.map(x=>`<div data-req-index="${x.request_index}">${esc(x.t)} · ${esc(x.a)} <button type="button" class="btn ghost" data-a="match-restore" ${small}>Undo removal</button></div>`).join('')}</details>`:''}
      ${knownIncomplete ? `<p class="muted" style="margin:4px 0;font-size:13px">Spotify reports ${sourceCount} songs, but only ${r.total} were retrieved. Fetch the full song list before completion; known missing Spotify songs cannot be skipped.</p>` :
        unverifiedBoundary ? `<p class="muted" style="margin:4px 0;font-size:13px">${r.total} Spotify songs retrieved; full playlist length unverified. More songs may exist beyond those retrieved.</p>` :
        r.source_status==='verified' ? `<p class="muted" style="margin:4px 0;font-size:13px">Spotify reports ${r.total} songs; all ${r.total} were retrieved.</p>` : ""}
      ${r.remote ? `<span class="muted">Completion is managed by the originating WASP.</span>` : miss ? `<span class="muted" style="font-size:13px">Waiting for ${miss} missing song${miss===1?'':'s'} before completion.</span>` :
        knownIncomplete ? `<span class="muted" style="font-size:13px">Cannot finish: complete Spotify song list unavailable.</span>` :
        unverifiedBoundary ? `<span class="muted">Review and finish with the Mark as done button above.</span>` :
        `<span class="muted">Use Mark as done above to complete.</span>`}</td></tr>` : ""}`;
  }).join("")}</tbody></table>` : "The queue is empty.";
}
async function requestMatchAction(id,action,index,extra={}){
  try{const response=await post(`/api/admin/requests/${encodeURIComponent(id)}/match`,{action,index,...extra});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Request match failed');
    openReq.add(id);await loadRequests();return result;
  }catch(e){flashMsg('#reqMsg',e.message,true);return null;}
}
async function requestFindCandidates(entry,id,query=''){
  const index=Number(entry.dataset.reqIndex),pane=entry.querySelector('.req-match-results');
  if(index<0){pane.textContent='Refresh the request first to locate its original song index.';return;}
  pane.textContent='Searching local music and connected peer snapshots…';
  try{const res=await fetch(`/api/admin/requests/${encodeURIComponent(id)}/candidates?index=${index}&q=${encodeURIComponent(query)}`,{cache:'no-store'});const data=await res.json();if(!res.ok)throw Error(data.error||'Search unavailable');
    pane.innerHTML=`<div class="req-match-search"><input aria-label="Search song or artist in library" placeholder="Search local music or HIVE peers" value="${esc(query)}"><button type="button" class="btn ghost" data-a="match-query" ${small}>Search</button></div>`+
      (data.candidates.length?data.candidates.map(c=>`<div class="req-candidate" data-origin="${esc(c.origin)}" data-candidate-id="${esc(c.id)}"><button type="button" data-a="match-reject" class="req-reject" title="Reject this suggestion" aria-label="Reject ${esc(c.title)}">❌</button><button type="button" data-a="match-accept" class="req-accept" title="Confirm this match" aria-label="Confirm ${esc(c.title)}">✅</button><span>${esc(c.title)} <small>· ${esc(c.artist)}${c.album?' · '+esc(c.album):''} · ${c.origin?'HIVE peer':'Local'} · ${c.score}% match</small></span></div>`).join(''):`<p class="muted">No possible matches. Try a different search term, or remove this entry from the request.</p>`);
  }catch(e){pane.textContent=e.message;}
}
$("#reqRows").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const tr = b.closest("tr"), id = tr.dataset.r || tr.dataset.d, act = b.dataset.a;
  const r = (window.__reqs || []).find((x) => x.id === id) || {};
  const entry=b.closest('[data-req-index]'),index=entry?Number(entry.dataset.reqIndex):-1;
  if(act==='scan-matches'){
    openReq.add(id);const detail=document.querySelector(`tr[data-d="${CSS.escape(id)}"]`);detail?.classList.remove('hidden');
    for(const item of [...(detail?.querySelectorAll('.req-match-entry')||[])].slice(0,8))await requestFindCandidates(item,id);
    return;
  }
  if(act==='match-scan'||act==='match-query'){
    await requestFindCandidates(entry,id,act==='match-query'?entry.querySelector('.req-match-search input')?.value||'':'');return;
  }
  if(act==='match-reject'||act==='match-accept'){
    const candidate=b.closest('.req-candidate');if(!candidate)return;
    if(act==='match-accept'&&!confirm(`Match this Spotify entry to "${candidate.querySelector('span')?.textContent?.trim()}"? Review carefully before confirming.`))return;
    const saved=await requestMatchAction(id,act==='match-accept'?'accept':'reject',index,{origin:candidate.dataset.origin,id:candidate.dataset.candidateId});
    if(saved)flashMsg('#reqMsg',act==='match-accept'?'Match confirmed. Request counts updated.':'Candidate rejected.');return;
  }
  if(act==='match-skip'||act==='match-restore'){
    if(act==='match-skip'&&!confirm('Remove this Spotify entry from the local requested playlist? It can be restored later. This will not delete any MP3.'))return;
    await requestMatchAction(id,act==='match-skip'?'skip':'restore',index);return;
  }
  if(act==='match-add'){
    const detail=tr.closest('tr.reqdetail'),title=detail.querySelector('[data-req-song-title]')?.value.trim(),artist=detail.querySelector('[data-req-song-artist]')?.value.trim();
    if(!title||!artist){flashMsg('#reqMsg','Enter both song title and artist.',true);return;}
    await requestMatchAction(id,'add',0,{title,artist});return;
  }
  if(act==='review-refresh' ||act==='locate'||act==='hide-offline'||act==='review-done'){
    if(act==='review-done'&&!confirm(`Mark ${r.title} as done?${r.remote?' This completes it on this WASP only; the origin retains ownership.':''}`))return;
    if(act==='hide-offline'&&!confirm('Hide until the verified origin reconnects?'))return;
    await reviewRequests({'review-refresh':'refresh','review-done':'complete',locate:'locate','hide-offline':'hide-offline'}[act],[id],act==='review-done');return;
  }
  if (act === "toggle") {
    const d = $(`tr[data-d="${id}"]`), show = d.classList.contains("hidden");
    d.classList.toggle("hidden", !show); show ? openReq.add(id) : openReq.delete(id);
    b.setAttribute("aria-expanded", show); b.textContent = show ? "▴" : "▾"; return;
  }
  if (act === "refresh" || act === "done" || act === "done-unverified") {
    const isDone=act !== "refresh", unverified=act === "done-unverified";
    if (unverified && !confirm(`Spotify provided ${r.total} retrieved songs for "${r.title}", but WASP cannot verify the full Spotify playlist length.\n\nFinalize ONLY these ${r.total} retrieved songs? Any additional Spotify songs will NOT be included. This moves the request to Previous requests.`)) return;
    if (act === "done" && !confirm(`Finalize "${r.title}" with ${r.matched || 0} available songs and ${r.missing?.length||0} known missing?\n\nMissing songs will not be added now. You can add them later. This moves the request to Previous requests.${r.partial?'\n\nSpotify may have withheld additional songs not in the retrieved list.':''}`)) return;
    b.disabled = true; const label = b.textContent; b.textContent = isDone ? "Working…" : "Refreshing…";
    try {
      const res = await fetch(`/api/admin/requests/${id}/${isDone ? "complete" : "refresh"}`, {
        method: "POST", ...(isDone ? {headers:{"content-type":"application/json"},body:JSON.stringify({confirm_unverified:true,confirm_incomplete:true,confirm_missing:true})} : {})
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { flashMsg("#reqMsg", j.error || `${isDone ? "Completion" : "Refresh"} failed (HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}).`, true); return; }
      if (j.status === "done") {
        openReq.delete(id);
        flashMsg("#reqMsg", `"${r.title}" was added to Playlists with ${j.matched} retrieved songs${j.completed_unverified ? " (full Spotify length unverified)" : ""}, and moved to Previous requests.`);
        loadPlaylists();
      } else flashMsg("#reqMsg", `${j.matched}/${j.total}${j.partial ? "+" : ""} songs found; ${j.missing.length} missing.`);
      loadRequests();
    } catch(err) { flashMsg("#reqMsg", `${isDone ? "Completion" : "Refresh"} failed: ${err.message}`, true); }
    finally { b.disabled = false; b.textContent = label; }
    return;
  }
  if(act==='remove')await requestHousekeeping('selected',[id]);
});

// ---------- add music, with an overall "10 out of 30" progress bar ----------
const jobs = [];
let running = false;
const stat = { total: 0, done: 0, up: 0, dup: 0, fail: 0, cur: "", frac: 0 };
function paintBatch(final) {
  $("#batch").classList.toggle("hidden", !stat.total);
  const pct = stat.total ? Math.round(((stat.done + (final ? 0 : stat.frac)) / stat.total) * 100) : 0;
  $("#batchBar").style.width = pct + "%";
  $("#batchBarWrap").setAttribute("aria-valuenow", pct);
  $("#batchText").textContent = final ? `Finished: ${stat.done} out of ${stat.total}` : `${stat.done} out of ${stat.total} done`;
  $("#batchSub").textContent = final ? "" : stat.cur ? `Now: ${stat.cur}` : "";
  $("#batchSummary").textContent = [`${stat.up} uploaded`, stat.dup ? `${stat.dup} already in the library` : "", stat.fail ? `${stat.fail} failed` : ""].filter(Boolean).join(" · ");
}
window.addEventListener("beforeunload", (e) => { if (running) { e.preventDefault(); e.returnValue = ""; } });

function send(file, meta, hash, pid, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", "/api/admin/upload");
    x.setRequestHeader("X-Meta", encodeURIComponent(JSON.stringify(meta)));
    x.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    x.setRequestHeader("X-Hash", hash);
    if (pid) x.setRequestHeader("X-Playlist", pid);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => x.status < 300 ? resolve(JSON.parse(x.responseText)) : reject(new Error((JSON.parse(x.responseText || "{}")).error || "Upload failed"));
    x.onerror = () => reject(new Error("Network error"));
    x.send(file);
  });
}
const sha = async (file) => {
  if(!globalThis.crypto?.subtle)throw Error('File hashing requires a trusted HTTPS connection (or localhost). Please open WASP using HTTPS with a valid certificate.');
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256",await file.arrayBuffer()))].map(b=>b.toString(16).padStart(2,"0")).join("");
};

async function enqueue(fileList) {
  const m = mode(), msg = $("#upMsg");
  msg.textContent = "";
  let pid = null;
  if (m === "playlist") {
    const name = $("#plName").value.trim();
    if (!name) { msg.textContent = "Enter a playlist name first."; return; }
    const r = await post("/api/admin/playlists", { name });
    if (!r.ok) { msg.textContent = (await r.json()).error; return; }
    pid = (await r.json()).id;
  }
  const ctx = { m, pid, album: $("#alName").value.trim(), artist: $("#alArtist").value.trim() };
  if (!running) Object.assign(stat, { total: 0, done: 0, up: 0, dup: 0, fail: 0, cur: "", frac: 0 });
  const files = [...fileList];
  files.forEach((file, i) => jobs.push({ file, ctx, n: i + 1 }));
  stat.total += files.length;
  paintBatch();
  if (!running) runJobs();
}
async function runJobs() {
  running = true;
  while (jobs.length) {
    await processOne(jobs.shift());
    stat.done++; stat.frac = 0;
    paintBatch();
  }
  running = false; stat.cur = "";
  paintBatch(true);
  page = 1; refresh(); loadPlaylists(); loadRequests();
}
async function processOne({ file, ctx, n }) {
  const { m, pid } = ctx;
  stat.cur = file.name; stat.frac = 0; paintBatch();
  const item = document.createElement("div");
  item.style.margin = "10px 0";
  item.innerHTML = `<div>${esc(file.name)} <span class="muted">reading…</span></div><div class="bar"><i></i></div>`;
  $("#queue").prepend(item);
  const status = item.querySelector("span"), bar = item.querySelector("i");
  if (!/\.mp3$/i.test(file.name)) { status.textContent = "Skipped: only .mp3 files"; stat.fail++; return; }
  try {
    const tags = await readTags(file);
    const hash = await sha(file);
    const found = (await (await post("/api/admin/check", { hash })).json()).id;
    if (found) { // already stored: never upload twice, but still add to the playlist
      if (pid) { await post(`/api/admin/playlists/${pid}/tracks`, { track_id: found }); status.textContent = "Already in the library — added to the playlist"; }
      else status.textContent = "Already in the library — skipped";
      bar.style.width = "100%"; stat.dup++; return;
    }
    if (m === "album") { if (ctx.album) tags.album = ctx.album; if (ctx.artist) tags.artist = ctx.artist; if (!tags.track) tags.track = String(n); }
    status.textContent = `${(tags.artist || "Unknown Artist").replace(/;/g, ", ")} · ${tags.album || "Single"}`;
    const t = await send(file, tags, hash, pid, (p) => { bar.style.width = p * 100 + "%"; stat.frac = p; paintBatch(); });
    bar.style.width = "100%";
    if (tags.cover) await fetch(`/api/admin/tracks/${t.id}/cover`, { method: "PUT", headers: { "content-type": tags.cover.type }, body: tags.cover });
    await warm([t], undefined, true); // fetch artwork and biographies now so listeners see them right away
    status.textContent += pid ? " — uploaded and added to the playlist" : " — uploaded";
    stat.up++;
  } catch (err) { status.textContent = "Failed: " + err.message; status.style.color = "var(--danger)"; stat.fail++; }
}

async function warm(list, onStep = () => {}, withBio = false) {
  const urls = new Set();
  list.forEach((t) => { artistsOf(t).forEach((a) => { urls.add(artistArt(a)); if (withBio && !/^unknown/i.test(a)) urls.add("/api/bio?name=" + encodeURIComponent(a)); }); urls.add(albumArt(t)); });
  urls.delete("");
  let n = 0;
  for (const u of urls) { await fetch(u).catch(() => {}); onStep(++n, urls.size); await new Promise((r) => setTimeout(r, 200)); }
}
$("#refreshArt").addEventListener("click", async (e) => {
  const b = e.target; b.disabled = true;
  await post("/api/admin/art/reset", {});
  await warm(window.__tracks || [], (n, total) => (b.textContent = `Fetching artwork ${n}/${total}…`));
  b.textContent = "Refresh artwork"; b.disabled = false;
});
// Update artist bio: checks Wikipedia for every artist; only artists whose page changed are rewritten.
$("#updateBios").addEventListener("click", async (e) => {
  const b = e.target, msg = $("#bioMsg");
  const names = [...new Set((window.__tracks || []).flatMap((t) => artistsOf(t)))].filter((n) => !/^unknown/i.test(n));
  if (!names.length) { flashMsg("#bioMsg", "There are no artists yet.", true); return; }
  b.disabled = true; msg.className = "msg"; msg.textContent = "";
  const c = { added: 0, updated: 0, unchanged: 0, none: 0, failed: 0 };
  for (let i = 0; i < names.length; i++) {
    b.textContent = `Checking bios ${i + 1}/${names.length}…`;
    try {
      const r = await post("/api/admin/bio/refresh", { name: names[i] });
      const j = await r.json().catch(() => ({}));
      c[r.ok && c[j.status] !== undefined ? j.status : "failed"]++;
    } catch { c.failed++; }
    await new Promise((r) => setTimeout(r, 150));
  }
  b.textContent = "Update artist bio"; b.disabled = false;
  flashMsg("#bioMsg", `Checked ${names.length} artists: ${c.added} added, ${c.updated} updated, ${c.unchanged} unchanged, ${c.none} not found on Wikipedia${c.failed ? `, ${c.failed} could not be checked` : ""}.`, c.failed > 0);
});

const drop = $("#drop");
$("#files").addEventListener("change", (e) => { enqueue(e.target.files); e.target.value = ""; });
["dragenter", "dragover"].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => enqueue(e.dataTransfer.files));

// WASP v16.0.5 Mobile Bridge: managed by Network → Mobile Bridge.
let mobileBridgeLoaded=false;
function mobileSetupMessage(message,error=false){
  const el=$('#mobileSecretFeedback');el.textContent=message||'';el.classList.toggle('err',!!error);
}
function showMobileBridgeState(data){
  const ready=!!data.secret_ready;
  $('#mobileBridgeToggle').checked=!!data.enabled;
  $('#mobileBridgeFeatureState').textContent='Bridge: '+(data.enabled?'Enabled':'Disabled');
  $('#mobileBridgeEncryptionState').textContent='Encryption: '+(ready?'Configured':'Missing');
  $('#mobileBridgeApiState').textContent='Mobile API: '+(ready&&data.enabled?'Ready':'Unavailable');
  const state=$('#mobileSecretState');
  state.textContent=ready?'✓ Encryption configured — mobile credentials can be issued when enabled.':'⚠ Setup required — server encryption secret is missing. Members cannot create mobile keys.';
  state.style.color=ready?'var(--accent, #c8f169)':'var(--danger, #ff6673)';
  $('#mobileSecretSetup').classList.toggle('hidden',ready);
  $('#mobileSecretResetControls').classList.toggle('hidden',!ready);
  $('#mobileSecretMigrateControls').classList.toggle('hidden',!ready||data.secret_source==='wasp');
  if(ready){$('#mobileSecretImportForm').classList.add('hidden');$('#mobileExistingSecret').value='';}
  $('#mobileBridgeAdminStatus').textContent=data.enabled?(ready?'Mobile Bridge is enabled and ready.':'Mobile Bridge enabled but setup is incomplete.'):'Mobile Bridge is disabled.';
  $('#mobileBridgeAdminStatus').classList.toggle('err',!!data.enabled&&!ready);
  $('#mobileBridgeUrl').textContent=location.origin+'/mobile';
}
async function loadMobileBridgeSettings(){
  try{
    const r=await fetch('/api/admin/mobile-bridge',{cache:'no-store'});
    const data=await r.json();if(!r.ok)throw Error(data.error||'Unable to read Mobile Bridge settings.');
    showMobileBridgeState(data);mobileBridgeLoaded=true;
  }catch(e){mobileSetupMessage(e.message,true);}
}
$('#mobileBridgeSave').addEventListener('click',async()=>{
  const button=$('#mobileBridgeSave');button.disabled=true;
  try{
    const r=await post('/api/admin/mobile-bridge',{enabled:$('#mobileBridgeToggle').checked},'PUT');
    const data=await r.json();if(!r.ok)throw Error(data.error||'Unable to save Mobile Bridge settings.');
    showMobileBridgeState(data);mobileSetupMessage('Mobile Bridge settings saved.');
  }catch(e){mobileSetupMessage(e.message,true);}finally{button.disabled=false;}
});
async function configureMobileSecret(payload,button){
  button.disabled=true;
  try{
    const r=await post('/api/admin/mobile-bridge/secret',payload);
    const data=await r.json();if(!r.ok)throw Error(data.error||'Could not configure the secret.');
    showMobileBridgeState(data);
    $('#mobileSecretResetForm').classList.add('hidden');$('#mobileSecretResetWord').value='';
    mobileSetupMessage(payload.action==='rotate'?'Secret reset. All previous mobile app keys have been revoked.':payload.action==='migrate'?'Existing secret moved into WASP storage. Previous mobile keys remain valid.':'Server secret configured. Members can now create mobile keys when Mobile Bridge is enabled.');
  }catch(e){mobileSetupMessage(e.message,true);}finally{button.disabled=false;}
}
$('#mobileSecretGenerate').addEventListener('click',e=>configureMobileSecret({action:'generate'},e.currentTarget));
$('#mobileSecretMigrate').addEventListener('click',e=>configureMobileSecret({action:'migrate'},e.currentTarget));
$('#mobileSecretImportToggle').addEventListener('click',e=>{
  const form=$('#mobileSecretImportForm');form.classList.toggle('hidden');e.currentTarget.setAttribute('aria-expanded',String(!form.classList.contains('hidden')));
});
$('#mobileSecretImportCancel').addEventListener('click',()=>{$('#mobileSecretImportForm').classList.add('hidden');$('#mobileExistingSecret').value='';});
$('#mobileSecretImportForm').addEventListener('submit',async e=>{
  e.preventDefault();const secret=$('#mobileExistingSecret').value.trim();
  await configureMobileSecret({action:'import',secret},e.currentTarget.querySelector('button[type="submit"]'));
});
$('#mobileSecretResetStart').addEventListener('click',()=>{$('#mobileSecretResetForm').classList.remove('hidden');$('#mobileSecretResetWord').focus();});
$('#mobileSecretResetCancel').addEventListener('click',()=>{$('#mobileSecretResetForm').classList.add('hidden');$('#mobileSecretResetWord').value='';});
$('#mobileSecretResetForm').addEventListener('submit',async e=>{
  e.preventDefault();const word=$('#mobileSecretResetWord').value;
  await configureMobileSecret({action:'rotate',confirm:word},e.currentTarget.querySelector('button[type="submit"]'));
});
$('#mobileBridgeCopyUrl').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText(location.origin+'/mobile');mobileSetupMessage('Mobile Bridge URL copied.');}
  catch{mobileSetupMessage('Copy the address displayed above.',true);}
});
// ---------- instance-local GitHub release/update channel ----------
let lastReleaseCheck=null;
let savedReleaseChannel='stable';
// Invalidate in-flight checks when an admin changes or saves a channel. A slow
// response for Stable must never repaint the Test selection with Stable data.
let releaseRequestSerial=0;
const releaseRepos={stable:'https://github.com/KNDPZ/WASP',test:'https://github.com/kirbydepaz12/wasp-test'};
const releaseAcknowledged=key=>{try{return localStorage.getItem('wasp-release-dismissed:'+key)==='1';}catch{return false;}};
const selectedReleaseChannel=()=>document.querySelector('input[name="releaseChannel"]:checked')?.value||'stable';
function paintReleaseRepository(channel){
  const url=releaseRepos[channel]||releaseRepos.stable;
  $('#releaseRepoLink').href=url;
  $('#releaseRepoLink').textContent=url.slice('https://github.com/'.length);
}
function showSettingsSubtab(which='general'){
  const updates=which==='release-updates';
  $('#settingsGeneralPanel').classList.toggle('hidden',updates);
  $('#settingsUpdatesPanel').classList.toggle('hidden',!updates);
  $('#settingsTabGeneral').setAttribute('aria-selected',String(!updates));
  $('#settingsTabUpdates').setAttribute('aria-selected',String(updates));
  if(updates && (!lastReleaseCheck || selectedReleaseChannel()===savedReleaseChannel))void checkReleases();
}
$('#settingsTabGeneral').onclick=()=>{location.hash='settings';showSettingsSubtab('general');};
$('#settingsTabUpdates').onclick=()=>{location.hash='settings/release-updates';showSettingsSubtab('release-updates');};
function paintReleaseAlert(info){
  const node=$('#adminReleaseAlert');const decision=info?.decision;
  const available=!!decision?.available&&!releaseAcknowledged(decision.key);
  node.classList.toggle('hidden',!available);
  if(!available)return;
  const channel=info.channel==='test'?'Test':'Stable';
  $('#adminReleaseAlertChannel').textContent=channel;
  $('#adminReleaseAlertTitle').textContent=decision.kind==='release'?'New WASP release available':'New GitHub commit available';
  $('#adminReleaseAlertInfo').textContent=decision.kind==='release'?`${decision.version} is available · Installed: v${info.installed_version}`:
    `${info.repository} has a newer commit than this server's recorded build/baseline.`;
  $('#adminReleaseAlertLink').href=decision.url;
  $('#adminReleaseAlertLink').textContent=decision.kind==='release'?"See what's new":'View commit';
  $('#adminReleaseDismiss').onclick=()=>{
    try{localStorage.setItem('wasp-release-dismissed:'+decision.key,'1');}catch{}
    node.classList.add('hidden');
  };
}
function paintReleaseStatus(info,failed=false){
  lastReleaseCheck=info;
  const channel=info.channel==='test'?'test':'stable';
  savedReleaseChannel=channel;
  const chosen=document.querySelector(`input[name="releaseChannel"][value="${channel}"]`);
  if(chosen)chosen.checked=true;
  paintReleaseRepository(channel);
  $('#releaseInstalled').textContent='v'+(info.installed_version||'?');
  $('#releaseLatestVersion').textContent=failed?'Unavailable':info.release?.tag||'No published release';
  $('#releaseLatestCommit').href=info.commit?.url||releaseRepos[channel];
  $('#releaseLatestCommit').textContent=failed?'Unavailable':info.commit?.short_sha||'Unavailable';
  $('#releaseLastChecked').textContent=info.checked_at?new Date(info.checked_at).toLocaleString():'—';
  const message=$('#releaseResult');
  if(failed){
    $('#releaseSettingsMsg').textContent=info.error||'Could not check GitHub.';
    message.textContent=`Could not check ${channel==='test'?'Test / Preview':'Stable / Main'}. The selected repository is saved. Existing WASP services are unaffected.`;
  }else if(info.decision?.available){
    message.textContent=info.decision.kind==='release'?`New release: ${info.decision.version}. ${info.decision.title}`:
      `New commit available: ${info.commit?.short_sha||''} · ${info.decision.details||''}`;
  }else message.textContent=info.detection==='first-observed-commit'?
    'No newer release found. Commit-only monitoring is active from this server’s first observed GitHub commit.':'No new updates detected for this channel.';
  if(!failed && info.warning)$('#releaseSettingsMsg').textContent=info.warning;
  paintReleaseAlert(info);
}
for(const option of document.querySelectorAll('input[name="releaseChannel"]'))option.addEventListener('change',()=>{
  ++releaseRequestSerial;
  $('#releaseCheck').disabled=false;
  const channel=selectedReleaseChannel();
  paintReleaseRepository(channel); // Preview the selected channel immediately.
  $('#releaseLatestVersion').textContent='—';
  $('#releaseLatestCommit').href=releaseRepos[channel];
  $('#releaseLatestCommit').textContent='—';
  $('#releaseLastChecked').textContent='—';
  $('#adminReleaseAlert').classList.add('hidden');
  $('#releaseResult').textContent=channel===savedReleaseChannel?'Select Check now to refresh this channel.':
    'Channel change not yet saved. Save channel, or use Check now to save and check it.';
  $('#releaseSettingsMsg').textContent=channel===savedReleaseChannel?'':'Unsaved channel selection.';
});
async function checkReleases(force=false){
  if($('#panel').classList.contains('hidden'))return;
  if(selectedReleaseChannel()!==savedReleaseChannel)return;
  const serial=++releaseRequestSerial;
  $('#releaseCheck').disabled=true;
  if(force)$('#releaseSettingsMsg').textContent='Checking GitHub…';
  try{
    const response=await fetch('/api/admin/release-updates'+(force?'?refresh=1':''),{cache:'no-store'});
    const info=await response.json();
    if(serial!==releaseRequestSerial)return; // Superseded by selection or another check.
    if(info.channel!==savedReleaseChannel)throw Error('Server returned an unexpected release channel.');
    paintReleaseStatus(info,!response.ok);
    if(force&&response.ok)$('#releaseSettingsMsg').textContent=info.warning||'GitHub check complete.';
  }catch(e){
    if(serial!==releaseRequestSerial)return;
    $('#releaseSettingsMsg').textContent=e.message;
    $('#releaseResult').textContent='GitHub check unavailable. Existing WASP services are unaffected.';
    $('#adminReleaseAlert').classList.add('hidden');
  }finally{if(serial===releaseRequestSerial)$('#releaseCheck').disabled=false;}
}
async function saveReleaseChannel(force=false){
  const channel=selectedReleaseChannel();
  ++releaseRequestSerial; // Old checks cannot overwrite the new choice.
  const btn=$('#releaseSave');btn.disabled=true;$('#releaseCheck').disabled=true;
  const options=document.querySelectorAll('input[name="releaseChannel"]');
  for(const option of options)option.disabled=true;
  try{
    const response=await post('/api/admin/release-updates',{channel},'PUT');
    const data=await response.json();
    if(!response.ok)throw Error(data.error||'Could not save the channel');
    savedReleaseChannel=data.channel;
    $('#adminReleaseAlert').classList.add('hidden');lastReleaseCheck=null;
    paintReleaseRepository(savedReleaseChannel);
    $('#releaseSettingsMsg').textContent='Release channel saved for this WASP server. No deployment changes made.';
    await checkReleases(force);
  }catch(e){
    $('#releaseSettingsMsg').textContent=e.message;
    $('#releaseResult').textContent='Channel not saved. Existing WASP services are unaffected.';
  }finally{
    for(const option of options)option.disabled=false;
    btn.disabled=false;$('#releaseCheck').disabled=false;
  }
}
$('#releaseSave').onclick=()=>saveReleaseChannel();
// Check now checks the radio selection, not a previously saved channel.
$('#releaseCheck').onclick=()=>selectedReleaseChannel()===savedReleaseChannel?checkReleases(true):saveReleaseChannel(true);
setInterval(()=>{if(!document.hidden&&!$('#panel').classList.contains('hidden')&&selectedReleaseChannel()===savedReleaseChannel)void checkReleases();},6*60*60*1000);

// ---------- general settings: branding + advertising ----------
let site = null;
function paintFavicon() {
  const on = !!(site && site.favicon);
  $("#favPrev").classList.toggle("hidden", !on); $("#favNone").classList.toggle("hidden", on); $("#favRm").classList.toggle("hidden", !on);
  $("#favicon").href = on ? `/site/favicon?v=${site.favicon}` : "/wasp-icon.png";
  if (on) { $("#favPrev").src = `/site/favicon?v=${site.favicon}`; }
}
async function loadSite() {
  try { site = await (await fetch("/api/site")).json(); } catch { return; }
  $("#siteName").value = site.name; $("#tabTitle").value = site.title; $("#brandIconOn").checked = !!site.show_brand_icon;
  $("#brandMode").value=site.brand_mode||"text";paintBrandImage();
  $("#sidebarOn").checked=!!site.sidebar?.enabled;$("#sidebarCode").value=site.sidebar?.bbcode!==null && site.sidebar?.bbcode!==undefined ? site.sidebar.bbcode : (site.sidebar?.html ? legacySidebarToBBCode(site.sidebar.html) : "");paintSidebarPreview();
  $("#spOn").checked = site.ad.enabled; $("#spH").value = site.ad.height; $("#spCode").value = site.ad.html;
  document.title = `Admin · ${site.title || site.name}`;
  paintFavicon();
}
const flashMsg = (sel, text, err) => { const m = $(sel); m.className = "msg" + (err ? " err" : ""); m.textContent = text; };
async function saveSettings(body, msgSel) {
  const r = await post("/api/admin/settings", body, "PUT");
  if (!r.ok) { flashMsg(msgSel, (await r.json().catch(() => ({}))).error || "Couldn't save.", true); return false; }
  site = await r.json(); flashMsg(msgSel, "Saved."); document.title = `Admin · ${site.title || site.name}`; return true;
}
function paintBrandImage(){
  const on=!!site?.brand_v;
  $("#brandPreview").classList.toggle("hidden",!on);
  if(on)$("#brandPreview").src=`/site/brand?v=${site.brand_v}`;
  $("#brandImageRemove").classList.toggle("hidden",!on);
}
$("#brandSave").addEventListener("click", () => saveSettings({ site_name: $("#siteName").value, tab_title: $("#tabTitle").value, show_brand_icon: $("#brandIconOn").checked,brand_mode:$("#brandMode").value }, "#brandMsg"));
$("#brandImageBtn").onclick=()=>$("#brandImageFile").click();
$("#brandImageFile").onchange=async e=>{
  const f=e.target.files[0];e.target.value="";if(!f)return;
  const r=await fetch("/api/admin/brand-image",{method:"PUT",headers:{"content-type":f.type},body:f});
  const data=await r.json().catch(()=>({}));
  if(r.ok){site.brand_v=data.brand_v;$("#brandMode").value="image";paintBrandImage();flashMsg("#brandMsg","Image uploaded; click Save branding to activate.");}
  else flashMsg("#brandMsg",data.error||"Image upload failed",true);
};
$("#brandImageRemove").onclick=async()=>{
  if(!confirm("Remove the site name image?"))return;
  const r=await fetch("/api/admin/brand-image",{method:"DELETE"});
  if(r.ok){site.brand_v=0;$("#brandMode").value="text";paintBrandImage();flashMsg("#brandMsg","Image removed. Save branding to switch to text.");}
};
function paintSidebarPreview(){
  const preview=$("#sidebarPreview");if(!preview)return;
  renderSidebarBBCode(preview,$("#sidebarCode").value);
}
$("#sidebarCode").addEventListener("input",paintSidebarPreview);
$("#sidebarSave").onclick=()=>saveSettings({sidebar_enabled:$("#sidebarOn").checked,sidebar_bbcode:$("#sidebarCode").value},"#sidebarMsg");
$("#favBtn").addEventListener("click", () => $("#favFile").click());
$("#favFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  const type = f.type || (/\.ico$/i.test(f.name) ? "image/x-icon" : "");
  const r = await fetch("/api/admin/favicon", { method: "PUT", headers: { "content-type": type }, body: f });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { site.favicon = j.favicon; paintFavicon(); flashMsg("#brandMsg", "Browser icon updated."); } else flashMsg("#brandMsg", j.error || "Upload failed.", true);
});
$("#favRm").addEventListener("click", async () => {
  await fetch("/api/admin/favicon", { method: "DELETE" }); site.favicon = 0; paintFavicon(); flashMsg("#brandMsg", "Browser icon removed.");
});

const SAMPLE_FEATURED = `<style>
  .deck{position:relative;height:100%;min-height:240px;overflow:hidden;border-radius:16px;isolation:isolate}
  .slide{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;gap:12px;padding:32px 72px;opacity:0;visibility:hidden;transition:opacity .6s,visibility .6s;color:#fff}
  .slide.on{opacity:1;visibility:visible}
  .kicker{margin:0;font-size:11px;letter-spacing:.18em;text-transform:uppercase;font-weight:800;color:#C8F169}
  .slide h2{margin:0;font-size:clamp(22px,3vw,34px);line-height:1.15;letter-spacing:-.01em}
  .slide p{margin:0;max-width:46ch;font-size:16px;color:rgba(255,255,255,.82)}
  .slide a{align-self:flex-start;margin-top:4px;padding:12px 24px;border-radius:24px;background:#C8F169;color:#131211;font-weight:800;text-decoration:none;transition:transform .15s,filter .15s}
  .slide a:hover{filter:brightness(1.08);transform:translateY(-1px)}
  .slide a:focus-visible,.nav:focus-visible,.pause:focus-visible,.dots button:focus-visible{outline:2px solid #fff;outline-offset:3px}
  .count{font-size:1.35em;font-weight:800;color:#C8F169;font-variant-numeric:tabular-nums}

  .s1{background:linear-gradient(135deg,#3a1010,#120a0a 65%)}
  .s2{background:linear-gradient(135deg,#12303a,#08131a 65%)}
  .s3{background:linear-gradient(135deg,#4a1226,#16070d 65%)}   /* most hearted */
  .s4{background:linear-gradient(135deg,#4a3410,#150f05 65%)}   /* most liked */
  .s5{background:linear-gradient(135deg,#44310d,#171107 65%)}   /* join the HIVE */
  .s6{background:linear-gradient(135deg,#2b1b4d,#0d0819 65%)}   /* random play */
  .s7{background:linear-gradient(135deg,#152b16,#09130a 65%)}   /* HIVE Telemetry */

  .slide .cta-row{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:4px}
  .slide .cta-row a{margin-top:0}
  .slide .cta-row .secondary{background:transparent;color:#C8F169;border:1px solid #C8F169}

  .dots{position:absolute;bottom:14px;left:0;right:0;display:flex;justify-content:center;gap:8px;z-index:2}
  .dots button{width:12px;height:12px;border-radius:50%;border:0;background:rgba(255,255,255,.35);cursor:pointer;padding:0}
  .dots button.on{background:#C8F169}
  .nav,.pause{position:absolute;border:0;background:rgba(0,0,0,.45);color:#fff;cursor:pointer;z-index:2;line-height:1}
  .nav{top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;font-size:22px}
  .prev{left:12px}.next{right:12px}
  .pause{top:12px;right:12px;width:30px;height:30px;border-radius:50%;font-size:11px}
  .pause[hidden]{display:none}
  @media (max-width:560px){
    .slide{padding:24px 50px}
    .slide h2{font-size:22px}
    .slide p{font-size:14px}
    .slide .cta-row a{padding:10px 14px;font-size:13px}
  }
  @media (prefers-reduced-motion:reduce){.slide,.slide a{transition:none}}
</style>

<div class="deck" id="deck" aria-roledescription="carousel" aria-label="Requests, charts and updates">
  <!-- 1 -->
  <div class="slide s1 on">
    <p class="kicker">Request line open</p>
    <h2>You pick what plays next</h2>
    <p>Drop a track and it goes straight into the live queue — no algorithm, no gatekeepers.</p>
    <a href="#request/new" target="_top" data-cta="request">Request a track</a>
  </div>

  <!-- 2 -->
  <div class="slide s2">
    <p class="kicker">Live right now</p>
    <h2>See what's up next</h2>
    <p>Every track in the queue, who asked for it, and how long until it hits the speakers.</p>
    <a href="#request" target="_top" data-cta="queue">See the queue</a>
  </div>

  <!-- 3 — most hearted -->
  <div class="slide s3" data-live="hearts">
    <p class="kicker">Most hearted this week</p>
    <h2>What the pit is loving</h2>
    <p><span class="count" data-fill="heart-count">The community</span> hearts and counting. See the tracks your fellow listeners can't stop hitting.</p>
    <a href="#hearts" target="_top" data-cta="hearts">See most hearted</a>
  </div>

  <!-- 4 — most starred -->
  <div class="slide s4" data-live="stars">
    <p class="kicker">Most starred on WASP</p>
    <h2>The crowd favourites</h2>
    <p>Ranked by real five-star votes from listeners, with no editorial picks or paid placement.</p>
    <a href="#stars" target="_top" data-cta="stars">See most starred</a>
  </div>

  <!-- 5 — become part of the WASP HIVE -->
  <div class="slide s5">
    <p class="kicker">Join the WASP network</p>
    <h2>BE PART OF THE SWARM. EXPAND THE HIVE.</h2>
    <p>Host your own WASP server with Docker or Cloudflare. Already have a public WASP link? Register, request publishing permission, and share your server to grow the HIVE.</p>
    <div class="cta-row">
      <a href="https://github.com/KNDPZ/WASP" target="_blank" rel="noopener noreferrer" data-cta="host">Host a WASP server</a>
      <a class="secondary" href="#settings" target="_top" data-cta="publish">Register &amp; publish</a>
    </div>
  </div>

  <!-- 6 — random play (previously slide 5) -->
  <div class="slide s6">
    <p class="kicker">Can't decide?</p>
    <h2>Shuffle the pit</h2>
    <p>One tap drops a random track from the whole library into your player. No browsing, no picking.</p>
    <a href="#recent/songs" target="_top" data-random data-cta="random">Surprise me</a>
  </div>

  <!-- 7 — WASP HIVE Telemetry; opens within the persistent music player -->
  <div class="slide s7">
    <p class="kicker">Discover HIVE Telemetry</p>
    <h2>ONE HIVE. EVERY BEAT.</h2>
    <p>Explore the listening trends connecting WASP servers. Discover top music, listening hours, favorite periods and the history of the HIVE — by week, month or year.</p>
    <a href="#top/telemetry" target="_top" data-cta="telemetry">Explore HIVE Telemetry</a>
  </div>

  <button class="nav prev" type="button" aria-label="Previous slide">‹</button>
  <button class="nav next" type="button" aria-label="Next slide">›</button>
  <button class="pause" type="button" aria-label="Pause slideshow">❚❚</button>
  <div class="dots"></div>
</div>

<script>
(function () {
  var deck = document.getElementById('deck');
  var slides = [].slice.call(deck.querySelectorAll('.slide'));
  var dots = deck.querySelector('.dots');
  var pauseBtn = deck.querySelector('.pause');
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var DURATION = 6500;
  var i = 0, timer = null, paused = false;

  slides.forEach(function (_, k) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', 'Slide ' + (k + 1) + ' of ' + slides.length);
    b.onclick = function () { go(k); restart(); };
    dots.appendChild(b);
  });

  function go(n) {
    i = (n + slides.length) % slides.length;
    slides.forEach(function (el, k) {
      var on = k === i;
      el.classList.toggle('on', on);
      el.setAttribute('aria-hidden', on ? 'false' : 'true');
    });
    [].forEach.call(dots.children, function (b, k) {
      b.classList.toggle('on', k === i);
      b.setAttribute('aria-current', k === i ? 'true' : 'false');
    });
  }

  function start() { if (paused || reduce) return; stop(); timer = setInterval(function () { go(i + 1); }, DURATION); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function restart() { stop(); start(); }

  deck.querySelector('.prev').onclick = function () { go(i - 1); restart(); };
  deck.querySelector('.next').onclick = function () { go(i + 1); restart(); };

  function setPaused(p) {
    paused = p;
    pauseBtn.textContent = p ? '▶' : '❚❚';
    pauseBtn.setAttribute('aria-label', p ? 'Play slideshow' : 'Pause slideshow');
    p ? stop() : start();
  }
  pauseBtn.onclick = function () { setPaused(!paused); };
  if (reduce) pauseBtn.hidden = true;

  deck.addEventListener('mouseenter', stop);
  deck.addEventListener('mouseleave', function () { if (!paused) start(); });
  deck.addEventListener('focusin', stop);
  deck.addEventListener('focusout', function () { if (!paused) start(); });

  var x0 = null;
  deck.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
  deck.addEventListener('touchend', function (e) {
    if (x0 === null) return;
    var dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 40) { go(i + (dx < 0 ? 1 : -1)); restart(); }
    x0 = null;
  });

  deck.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { go(i - 1); restart(); }
    if (e.key === 'ArrowRight') { go(i + 1); restart(); }
  });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      entries[0].isIntersecting ? (paused || start()) : stop();
    }, { threshold: 0.3 }).observe(deck);
  }

  document.addEventListener('visibilitychange', function () {
    document.hidden ? stop() : (paused || start());
  });

  /* Live data injection — see hook below */
  if (typeof window.adStats === 'object' && window.adStats) {
    [].forEach.call(deck.querySelectorAll('[data-fill]'), function (el) {
      var v = window.adStats[el.getAttribute('data-fill')];
      if (v != null) el.textContent = v;
    });
  }

  deck.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    /* Random play: ask the app to shuffle via postMessage from this sandboxed frame. */
    var r = t.closest('[data-random]');
    if (r) {
      e.preventDefault();
      try { window.parent.postMessage({ type: 'wasp:featured-shuffle' }, '*'); } catch (_) {}
        return;
    }

    /* Normal links */
    var a = t.closest('a[data-cta]');
    if (!a) return;
  });

  go(0);
  start();
})();
</script>`;
$("#spSample").addEventListener("click", () => { if (!$("#spCode").value.trim() || confirm("Replace the code in the box with the sample slider?")) $("#spCode").value = SAMPLE_FEATURED; });
$("#spPreviewBtn").addEventListener("click", () => {
  const f = document.createElement("iframe");
  f.title = "Featured slides preview"; f.setAttribute("sandbox", AD_SANDBOX); f.className = "spframe";
  f.style.height = (Math.min(1000, Math.max(60, +$("#spH").value || 340))) + "px";
  const sum = (k) => (window.__tracks || []).reduce((n, t) => n + (t[k] || 0), 0), stats = { "song-count": (window.__tracks || []).length.toLocaleString() };
  if (sum("hearts")) stats["heart-count"] = sum("hearts").toLocaleString();
  if (sum("likes")) stats["like-count"] = sum("likes").toLocaleString();
  f.srcdoc = adDoc($("#spCode").value, stats);
  $("#spPrev").replaceChildren(f);
});
$("#spSave").addEventListener("click", () => saveSettings({ ad_enabled: $("#spOn").checked, ad_html: $("#spCode").value, ad_height: $("#spH").value }, "#spMsg"));

// Administrator role remains bound to the server-side session, never to a username.
$("#adminNameForm").addEventListener("submit",async e=>{
  e.preventDefault();const f=e.currentTarget;
  const r=await post("/api/admin/username",{username:$("#adminNewName").value,password:$("#adminNamePassword").value},"PUT");
  const j=await r.json().catch(()=>({}));
  $("#adminNamePassword").value="";
  if(r.ok){$("#adminAccountName").textContent=j.username;flashMsg("#acctMsg","Administrator username updated.");}
  else flashMsg("#acctMsg",j.error||"Could not change username.",true);
});
// ---------- account settings: the password window only opens on click ----------
const pwDlg = $("#pwDlg");
$("#pwOpen").addEventListener("click", () => { $("#pwForm").reset(); $("#pwMsg").textContent = ""; pwDlg.showModal(); $("#cur").focus(); });
$("#pwCancel").addEventListener("click", () => pwDlg.close());
$("#pwForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if ($("#nw").value !== $("#nw2").value) { $("#pwMsg").textContent = "The new passwords don't match."; $("#nw2").focus(); return; }
  const r = await post("/api/admin/password", { current: $("#cur").value, next: $("#nw").value, confirm: $("#nw2").value });
  if (r.ok) { pwDlg.close(); flashMsg("#acctMsg", "Password changed. Other devices were logged out."); }
  else $("#pwMsg").textContent = (await r.json()).error;
});

// ---------- danger: clean database ----------
const cleanDlg = $("#cleanDlg");
const cCheck = () => ($("#cGo").disabled = !($("#cPw").value && $("#cWord").value.trim() === "confirm"));
$("#cleanBtn").addEventListener("click", () => { $("#cleanForm").reset(); $("#cMsg").textContent = ""; cCheck(); cleanDlg.showModal(); $("#cPw").focus(); });
$("#cCancel").addEventListener("click", () => cleanDlg.close());
$("#cPw").addEventListener("input", cCheck);
$("#cWord").addEventListener("input", cCheck);
$("#cleanForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const go = $("#cGo"); go.disabled = true; go.textContent = "Deleting…";
  const r = await post("/api/admin/clean", { password: $("#cPw").value, confirm: $("#cWord").value });
  const j = await r.json().catch(() => ({}));
  go.textContent = "Delete everything";
  if (r.ok) {
    cleanDlg.close(); $("#queue").innerHTML = ""; $("#upMsg").textContent = "";
    flashMsg("#cleanMsg", `Done. ${j.removed} stored files deleted and the library is empty.`);
    page = 1; refresh(); loadPlaylists(); loadRequests();
  } else { $("#cMsg").textContent = j.error || "Something went wrong."; cCheck(); }
});

// ---------- Network → Crons ----------
const CRON_LABELS={peers:"Check connected peers for new tracks",artwork:"Fetch missing artist/album artwork",biography:"Check artist biographies and lineups",hash:"SHA-256 hash local /music folder (Docker only)",telemetry:"Share my HIVE telemetry with connected peers"};
const CRON_KEYS=Object.keys(CRON_LABELS);
const cronWeekdays=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const availableZones=()=>{
  let zones=[];
  try{zones=Intl.supportedValuesOf("timeZone");}catch{}
  return [...new Set(["Asia/Manila","UTC",...zones])].sort();
};
let cronsLoaded=false;
function showNetworkTab(section='peers'){
  if(typeof section==='boolean')section=section?'crons':'peers'; // v14 compatibility
  const selected=['peers','mobile','crons','telemetry'].includes(section)?section:'peers';
  for(const [tab,panel,name] of [['netTabPeers','netPeersPanel','peers'],['netTabMobile','netMobilePanel','mobile'],['netTabCrons','netCronsPanel','crons'],['netTabTelemetry','netTelemetryPanel','telemetry']]){
    $('#'+tab).setAttribute('aria-selected',String(selected===name));
    $('#'+panel).classList.toggle('hidden',selected!==name);
  }
  if(selected==='telemetry'){loadMetadataSettings();void loadTelemetryPeerChoices();}
  if(selected==='crons'&&!cronsLoaded)loadCrons();
  if(selected==='mobile'&&!mobileBridgeLoaded)loadMobileBridgeSettings();
}
$('#netTabPeers').onclick=()=>{location.hash='network';showNetworkTab('peers');};
$('#netTabMobile').onclick=()=>{location.hash='network/mobile';showNetworkTab('mobile');};
$('#netTabTelemetry').onclick=()=>{location.hash='network/telemetry';showNetworkTab('telemetry');};
// Manual selection is managed below. Cron configuration remains independent.
// v18.1.0: deliberate manual telemetry pull from selected managed peers.
let telemetryPeers=[],telemetryPullBusy=false;
async function loadTelemetryPeerChoices(){
  const list=$('#telemetryPeerChoices');
  try {
    const r=await fetch('/api/admin/telemetry/peers',{cache:'no-store'});
    const d=await r.json();if(!r.ok)throw Error(d.error||'Unable to load managed peers');
    const previous=new Set([...list.querySelectorAll('input:checked')].map(x=>x.value));
    telemetryPeers=d.peers||[];
    list.replaceChildren();
    if(!telemetryPeers.length){list.textContent='No administrator-connected peers. Add a peer under Connected peers first.';return;}
    for(const p of telemetryPeers){
      const label=document.createElement('label');label.className='telemetry-peer-choice';
      const input=document.createElement('input');input.type='checkbox';input.value=p.url;input.checked=previous.has(p.url);
      const details=document.createElement('span');details.className='telemetry-peer-details';
      const name=document.createElement('strong');name.textContent=p.name||p.url;
      const url=document.createElement('small');url.textContent=p.url;
      const state=document.createElement('small');state.textContent=p.last_error?'Last known check: unavailable':p.last_ok?'Last connected successfully':'Not yet checked';
      details.append(name,url,state);label.append(input,details);list.append(label);
    }
  }catch(e){list.textContent='Unable to load peers: '+e.message;}
}
$('#telemetryRefreshPeers').onclick=loadTelemetryPeerChoices;
$('#telemetrySelectAll').onclick=()=>{
  const boxes=[...$('#telemetryPeerChoices').querySelectorAll('input[type="checkbox"]')];
  const check=boxes.some(x=>!x.checked);for(const box of boxes)box.checked=check;
  $('#telemetrySelectAll').textContent=check?'Deselect all peers':'Select all peers';
};
$('#telemetryPullSelected').onclick=async()=>{
  if(telemetryPullBusy)return;
  const peers=[...$('#telemetryPeerChoices').querySelectorAll('input:checked')].map(x=>x.value);
  const status=$('#telemetryPullStatus'),progress=$('#telemetryPullProgress');
  if(!peers.length){status.textContent='Select one or more connected peers first.';return;}
  telemetryPullBusy=true;$('#telemetryPullSelected').disabled=true;progress.hidden=false;progress.value=0;
  let imported=0,checked=0,errors=0,completed=0;
  try {
    // Each Worker request processes at most 10 peers; batch larger selections
    // to keep serverless execution bounded while honoring Select all.
    for(let i=0;i<peers.length;i+=10){
      status.textContent=`Pulling telemetry: ${Math.min(i+10,peers.length)} of ${peers.length} peers requested…`;
      const r=await post('/api/admin/telemetry/pull',{peers:peers.slice(i,i+10)});
      const d=await r.json();if(!r.ok)throw Error(d.error||'Telemetry pull failed');
      imported+=Number(d.imported)||0;checked+=Number(d.checked)||0;errors+=Number(d.errors)||0;
      completed+=Math.min(10,peers.length-i);progress.value=Math.round(completed*100/peers.length);
    }
    status.textContent=`Finished: ${imported} new plays imported from ${checked} peer feeds; ${errors} unavailable or failed. HIVE summaries include these events without double-counting. Refresh Telemetry to see updated totals.`;
  }catch(e){status.textContent=`Pull stopped after ${completed} peers: ${e.message}. Imported plays remain saved; retry is duplicate-safe.`;}
  finally{telemetryPullBusy=false;$('#telemetryPullSelected').disabled=false;progress.hidden=false;}
};
// Refresh the current server's derived summaries, without pulling any peers.
$('#telemetryRecalculate').onclick=async()=>{
  const button=$('#telemetryRecalculate'),status=$('#telemetryRecalculateStatus');
  if(button.disabled)return;
  button.disabled=true;status.textContent='Updating this WASP server’s telemetry summaries…';
  try{
    const r=await post('/api/admin/telemetry/recalculate',{});
    const d=await r.json();if(!r.ok)throw Error(d.error||'Unable to update telemetry');
    status.textContent=`Current telemetry updated: ${d.localPlays} local confirmed plays, ${d.hivePlays} total HIVE confirmed plays. Peer feeds were not pulled.`;
  }catch(e){status.textContent='Update failed: '+e.message;}
  finally{button.disabled=false;}
};
// v18.0.7: reorganize existing controls without duplicating forms or saved
// settings. All four panes belong to the same metadata form.
const metadataFormNode=$('#metadataForm');
const metadataSections=[...metadataFormNode.querySelectorAll(':scope > section')];
const metadataNav=document.createElement('div');metadataNav.className='metadata-subtabs';metadataNav.setAttribute('role','tablist');metadataNav.setAttribute('aria-label','Telemetry and metadata sections');
const metadataPanels={};
for(const [key,label] of [['offline','Offline Metadata'],['online','Online Metadata'],['telemetry','Telemetry'],['others','Others']]){
 const btn=document.createElement('button');btn.type='button';btn.textContent=label;btn.dataset.metadataTab=key;btn.className='btn ghost';btn.setAttribute('role','tab');metadataNav.append(btn);
 const pane=document.createElement('div');pane.dataset.metadataPane=key;pane.className='metadata-subpane';pane.setAttribute('role','tabpanel');pane.hidden=key!=='offline';metadataPanels[key]=pane;metadataFormNode.append(pane);
}
metadataFormNode.before(metadataNav);
[metadataSections[1]].forEach(el=>metadataPanels.offline.append(el));
[metadataSections[2],metadataSections[3],metadataSections[4]].forEach(el=>metadataPanels.online.append(el));
metadataPanels.telemetry.append(metadataSections[0]);
[metadataSections[5],metadataSections[6]].forEach(el=>metadataPanels.others.append(el));
// Keep Save settings and the status message visible on every metadata tab.
const saveActions=metadataSections[5]?.querySelector('.metadata-actions:has(button[type="submit"])');
const saveStatus=document.querySelector('#metadataStatus');
const metadataFooter=document.createElement('div');metadataFooter.className='metadata-global-footer';
if(saveActions)metadataFooter.append(saveActions);
if(saveStatus)metadataFooter.append(saveStatus);
metadataFormNode.append(metadataFooter);
// Peer-tag extraction is a form of offline metadata enrichment.
const peerTags=document.querySelector('#metadataPeerTagsRow');if(peerTags)metadataPanels.offline.append(peerTags);

const offlineAction=document.createElement('button');offlineAction.className='btn';offlineAction.type='button';offlineAction.id='metadataOfflineMatchNow';offlineAction.textContent='Match missing metadata using offline database';offlineAction.disabled=true;metadataPanels.offline.append(offlineAction);
const offlineInfo=document.createElement('p');offlineInfo.className='muted';offlineInfo.textContent='The offline database must be fully installed before matching. File and peer metadata remain read-only.';metadataPanels.offline.append(offlineInfo);
const onlineAction=document.createElement('button');onlineAction.className='btn ghost';onlineAction.type='button';onlineAction.id='metadataOnlineRun';onlineAction.textContent='Scan missing metadata using online APIs';metadataPanels.online.append(onlineAction);
const sharePanel=document.querySelector('#telemetryManualPull')?.closest('.card');if(sharePanel){metadataPanels.telemetry.prepend(sharePanel);sharePanel.querySelector('h2').textContent='Telemetry · Pull and Push';}
const pushAction=document.createElement('button');pushAction.type='button';pushAction.className='btn ghost';pushAction.id='telemetryPushSettingsShortcut';pushAction.textContent='Configure PUSH / sharing in Crons';metadataPanels.telemetry.prepend(pushAction);
metadataNav.addEventListener('click',e=>{const btn=e.target.closest('[data-metadata-tab]');if(!btn)return;for(const el of metadataNav.querySelectorAll('[data-metadata-tab]'))el.setAttribute('aria-selected',String(el===btn));for(const [key,pane] of Object.entries(metadataPanels))pane.hidden=key!==btn.dataset.metadataTab;});
metadataNav.querySelector('[data-metadata-tab="offline"]').setAttribute('aria-selected','true');
$('#telemetryPushSettingsShortcut').onclick=()=>{location.hash='network/crons';showNetworkTab('crons');document.querySelector('#cron-telemetry')?.scrollIntoView({block:'center'});};
$('#metadataOfflineMatchNow').onclick=()=>$('#metadataScan').click();
$('#metadataOnlineRun').onclick=()=>{if(!metadataReady||metadataDirty){metadataStatus('Save your metadata settings first.',true);return;}$('#metadataForm').dispatchEvent(new CustomEvent('metadata-online-run'));};
const metadataFields={lastfm:'metadataLastfm',musicbrainz:'metadataMusicbrainz',enabled:'metadataEnabled',fallback:'metadataFallback',trustPeers:'metadataTrust',shareLastfm:'metadataShareLastfm',wikidata:'metadataWikidata',prioritizePlayed:'metadataPriority',readPeerTags:'metadataPeerTags',offlineFallback:'metadataOfflineFallback'};
let metadataBusy=false,metadataDirty=false,metadataReady=false,metadataLoading=null,metadataRuntime='cloudflare',metadataScanState='idle',metadataPollBusy=false,metadataLastMetrics=0;
const metadataStatus=(text,error=false)=>{const el=$('#metadataStatus');el.textContent=text;el.classList.toggle('err',error);};
const providerStatus=(provider,text,type='')=>{const el=$('#'+(provider==='lastfm'?'metadataLastfmStatus':'metadataMusicbrainzStatus'));el.textContent=text;el.className='metadata-provider-status'+(type?' '+type:'');};
async function metadataResponse(r){let d;try{d=await r.json();}catch{throw Error(r.status===503?'HTTP 503 — Worker unavailable or resource limit exceeded. Check Worker logs for Error 1102.':`HTTP ${r.status} — server returned a non-JSON response. Check server logs.`);}if(!r.ok)throw Error(d?.error||`Request failed (HTTP ${r.status}).`);if(!d||typeof d!=='object'||Array.isArray(d))throw Error('Invalid server response.');return d;}
function renderMetadataCredentials(d){const source=d.credentialSource==='runtime'?'API key configured via runtime environment.':d.apiKeyConfigured?'API key saved.':'No API key saved.';$('#metadataCredentialState').textContent=[source,d.secretConfigured?'Shared secret configured.':'',d.encryptionReady?'Encrypted storage ready.':'Configure METADATA_SETTINGS_KEY before saving credentials.',d.legacyKey?'Previous encryption key is still readable. Saving new credentials uses the dedicated key.':'',d.credentialError||''].filter(Boolean).join(' ');$('#metadataReplaceRow').classList.toggle('hidden',!d.credentialError);if(!d.credentialError)$('#metadataReplace').checked=false;}
function renderCoverage(d){const c=d.coverage;for(const [field,prefix] of [['years','Year'],['origins','Origin']]){const total=Number(c?.total||0),n=Number(c?.[field]||0),pct=total>0?Math.max(0,Math.min(100,n/total*100)):0;$('#metadata'+prefix+'Percent').textContent=!c||!total?'—':pct.toFixed(2)+'%';$('#metadata'+prefix+'Bar').value=pct;$('#metadata'+prefix+'Count').textContent=c?`${n.toLocaleString()} / ${total.toLocaleString()} plays classified`:'Coverage unavailable; retry later.';}}
function renderMetadataScan(d){
 if(d.runtime){metadataRuntime=d.runtime;$('#metadataRuntime').textContent=metadataRuntime==='docker'?'Docker · local metadata processing':'Cloudflare · bounded resource mode';$('#metadataCloudWarning').classList.toggle('hidden',metadataRuntime!=='cloudflare');}
 $('#metadataPeerTagsRow').classList.toggle('hidden',metadataRuntime!=='docker');
 $('#metadataOfflinePanel').classList.toggle('hidden',metadataRuntime!=='docker');
 if(metadataRuntime!=='docker'){offlineAction.disabled=true;return;}
 const fs=d.fileScan;if(fs){$('#metadataFileProgress').classList.remove('hidden');const done=Number(fs.processed)||0,left=Number(fs.remaining)||0;$('#metadataFileBar').value=fs.state==='complete'?100:done+left?100*done/(done+left):0;$('#metadataFileText').textContent=`${done.toLocaleString()} files checked · ${left.toLocaleString()} pending · ${fs.verified||0} tag fields indexed · ${fs.errors||0} file read errors · ${fs.pendingRetries||0} awaiting retry`;}
 const s=d.scan||{state:'idle'};metadataScanState=s.state||'idle';const active=['running','paused'].includes(metadataScanState);$('#metadataScanControls').classList.toggle('hidden',!active);$('#metadataScanProgress').classList.toggle('hidden',metadataScanState==='idle');$('#metadataScan').textContent=metadataScanState==='paused'?'Resume scan':metadataScanState==='running'?'Scanning metadata…':'Scan missing metadata';$('#metadataPause').textContent='Pause scan';$('#metadataPause').disabled=metadataBusy||metadataScanState!=='running';$('#metadataStop').disabled=metadataBusy||!active;$('#metadataScan').disabled=metadataBusy||metadataScanState==='running';$('#metadataRescanFiles').disabled=metadataBusy||metadataScanState==='running';
 const n=Number(s.processed)||0,left=Number(s.remaining)||0,bar=$('#metadataScanBar');if(metadataScanState==='running'&&['discovering','offline','offline download'].includes(s.phase))bar.removeAttribute('value');else bar.value=metadataScanState==='complete'?100:(n+left?100*n/(n+left):0);
 const stale=metadataScanState==='running'&&s.updated&&Date.now()-s.updated>180000;
 $('#metadataScanText').textContent=`${metadataScanState==='complete'?'Scan pass complete':metadataScanState==='running'?(s.phase==='offline'?'Matching offline facts · '+(s.offlineChecked||0)+' checked · '+(s.offlineMatched||0)+' matched':s.phase==='offline download'?'Waiting for offline metadata database':s.retryAt>Date.now()?'Provider cooldown · '+Math.ceil((s.retryAt-Date.now())/1000)+'s remaining · until '+new Date(s.retryAt).toLocaleTimeString():stale?'Waiting for Docker worker to resume':s.phase==='discovering'?'Discovering missing metadata…':s.phase==='files'?'Reading local tags…':s.phase==='peer tags'?'Reading trusted peer tags…':'Processing queued metadata…'):metadataScanState} · ${n.toLocaleString()} jobs processed · ${left.toLocaleString()} currently due · ${s.verified||0} fields verified · ${s.errors||0} lookup errors${s.lastError?' · '+s.lastError:''}`;
 $('#metadataCoverageStatus').textContent=active?'Runs independently of your browser. Unresolved lookups may be retried later.':metadataScanState==='complete'?'Scan pass complete; unresolved fields remain in the coverage totals.':'Start a continuous scan using saved settings.';
}
async function pollMetadataScan(){if(metadataPollBusy||metadataBusy||metadataRuntime!=='docker'||$('#netTelemetryPanel').classList.contains('hidden')||document.hidden||!metadataReady)return;metadataPollBusy=true;try{const d=await metadataResponse(await fetch('/api/admin/telemetry/metadata/status',{cache:'no-store'}));const old=metadataScanState;renderMetadataScan(d);if(!metadataDirty&&(Date.now()-metadataLastMetrics>30000||old!==metadataScanState)){metadataLastMetrics=Date.now();await loadMetadataSettings();}}catch(e){$('#metadataCoverageStatus').textContent='Scanner status temporarily unavailable: '+e.message;}finally{metadataPollBusy=false;}}
setInterval(pollMetadataScan,5000);
let offlineBusy=false,offlineLoading=false;
const offlineGiB=n=>Number.isFinite(n)?(n/1073741824).toFixed(1)+' GiB':'unknown';
function renderOffline(d){offlineAction.disabled=!d.installed?.version||metadataBusy;
 const active=!!d.active,installed=d.installed,stage=d.state||'not-installed',bar=$('#metadataOfflineBar');
 if(stage==='downloading'&&d.totalBytes>0)bar.value=Math.min(100,100*d.bytes/d.totalBytes);
 else if(stage==='indexing'&&d.totalUncompressedBytes>0)bar.value=Math.min(100,100*d.uncompressedBytes/d.totalUncompressedBytes);
 else if(active)bar.removeAttribute('value');else bar.value=installed?100:0;
 const detail=stage==='downloading'?`Downloading ${d.entity||''} · ${offlineGiB(d.bytes)} / ${offlineGiB(d.totalBytes)}`:stage==='indexing'?`Indexing ${d.entity||''} · ${Number(d.records||0).toLocaleString()} records`:stage==='building-indexes'?'Building search indexes and checking integrity…':stage==='ready'?'Offline database ready':stage==='checking'?'Checking official snapshot…':stage==='not-installed'?'Offline database not installed':stage;
 $('#metadataOfflineText').textContent=detail+(installed?` · Installed ${installed.version} · ${Number(installed.artists||0).toLocaleString()} artists · ${Number(installed.albums||0).toLocaleString()} albums`:'');
 $('#metadataOfflineDisk').textContent=`Free storage: ${offlineGiB(d.freeBytes)} · Recommended 15–20 GiB free; minimum 10 GiB to begin. ${d.autoUpdate?'Weekly automatic update enabled.':'Manual updates; optionally configure weekly updates in Docker.'}`;
 const p=d.progress||{};$('#metadataOfflineMatch').textContent=p.version===installed?.version?`Offline matching · ${Number(p.checked||0).toLocaleString()} identities checked · ${Number(p.matched||0).toLocaleString()} new facts matched`:'Start the metadata scan to apply this snapshot.';
 $('#metadataOfflineError').textContent=d.error||'';$('#metadataOfflineDownload').disabled=active||offlineBusy;$('#metadataOfflineCancel').disabled=!active||offlineBusy;
}
async function refreshOffline(){if(offlineLoading||metadataRuntime!=='docker'||$('#netTelemetryPanel').classList.contains('hidden')||document.hidden)return;offlineLoading=true;try{renderOffline(await metadataResponse(await fetch('/api/admin/telemetry/metadata/offline-status',{cache:'no-store'})));}catch(e){$('#metadataOfflineError').textContent='Offline engine status unavailable: '+e.message;}finally{offlineLoading=false;}}
$('#metadataOfflineRefresh').onclick=()=>refreshOffline();
for(const [id,action] of [['metadataOfflineDownload','download'],['metadataOfflineCancel','cancel']])$('#'+id).onclick=async()=>{if(offlineBusy)return;if(action==='download'&&!confirm('Download/update the MusicBrainz artist and release-group database? This may use several GB of data and disk space. Existing music and the current index will be preserved.'))return;offlineBusy=true;$('#metadataOfflineDownload').disabled=true;$('#metadataOfflineCancel').disabled=true;try{const d=await metadataResponse(await post('/api/admin/telemetry/metadata/offline-'+action,{}));if(!d.ok)throw Error(d.error||'Request was not accepted');}catch(e){$('#metadataOfflineError').textContent=e.message;}finally{offlineBusy=false;await refreshOffline();}};
setInterval(refreshOffline,5000);

function renderMetadataMetrics(d){renderCoverage(d);renderMetadataScan(d);$('#metadataVerifiedAlbums').textContent=d.verifiedAlbums??0;$('#metadataVerifiedTracks').textContent=d.verifiedTracks??0;$('#metadataVerifiedArtists').textContent=d.verifiedArtists??0;$('#metadataVerifiedFields').textContent=d.verified??0;$('#metadataStats').textContent=`${d.verified||0} verified fields`+(d.lastRun?` · Last batch: ${new Date(d.lastRun.at).toLocaleString()} · ${d.lastRun.verified||0} updated · ${d.lastRun.imported||0} imported · ${d.lastRun.errors||0} errors`:'');$('#metadataLastError').textContent=d.lastError?'Last enrichment error: '+d.lastError:'';}
async function loadMetadataSettings({force=false}={}){if(metadataLoading)return metadataLoading;if(metadataDirty&&!force)return;metadataLoading=(async()=>{try{const d=await metadataResponse(await fetch('/api/admin/telemetry/metadata',{cache:'no-store'}));if(!metadataDirty||force){document.querySelectorAll('[name="metadata-preference"]').forEach(el=>el.checked=el.value===(d.preferred==='lastfm'?'lastfm':'musicbrainz'));$('#metadataContact').value=d.contact||'';const ps=$('#metadataPreferredPeer');ps.replaceChildren(new Option('Rotate trusted admin peers',''));for(const peer of d.peers||[])ps.add(new Option(peer.name||peer.url,peer.url));ps.value=d.preferredPeer||'';$('#metadataMinutes').value=String(d.minutes||5);const bs=$('#metadataBatchSize');bs.replaceChildren(...(d.runtime==='docker'?[1,2,3,5,10,20,50]:[1,2,3]).map(v=>new Option(v===1&&d.runtime!=='docker'?'1 · Cloudflare Free recommended':String(v),String(v))));bs.value=String(d.batchSize||1);for(const [k,id] of Object.entries(metadataFields))$('#'+id).checked=!!(d[k]??(['wikidata','prioritizePlayed','offlineFallback'].includes(k)));renderMetadataCredentials(d);if(!$('#metadataLastfmStatus').classList.contains('ok'))providerStatus('lastfm',d.credentialError?'Saved credentials unreadable':d.apiKeyConfigured?'Configured — not tested':'API key not configured');if(!$('#metadataMusicbrainzStatus').classList.contains('ok'))providerStatus('musicbrainz',d.contact?'Configured — not tested':'Contact not configured');}renderMetadataMetrics(d);metadataReady=true;void refreshOffline();}catch(e){metadataStatus(e.message,true);}finally{metadataLoading=null;}})();return metadataLoading;}
$('#metadataForm').addEventListener('input',()=>{metadataDirty=true;});$('#metadataForm').addEventListener('change',()=>{metadataDirty=true;});
$('#metadataKey').addEventListener('input',()=>{if($('#metadataKey').value)$('#metadataLastfm').checked=true;providerStatus('lastfm','Entered key — not saved or tested');});$('#metadataSecret').addEventListener('input',()=>providerStatus('lastfm','Credentials edited — not saved'));$('#metadataContact').addEventListener('input',()=>providerStatus('musicbrainz','Contact edited — not saved or tested'));
function metadataLock(on){metadataBusy=on;$('#metadataForm').querySelectorAll('button,input,select').forEach(el=>el.disabled=on);if(!on&&metadataRuntime==='docker'){$('#metadataScan').disabled=metadataScanState==='running';$('#metadataPause').disabled=metadataScanState!=='running';$('#metadataStop').disabled=!['running','paused'].includes(metadataScanState);$('#metadataRescanFiles').disabled=metadataScanState==='running';}}
$('#metadataForm').addEventListener('submit',async e=>{e.preventDefault();if(metadataBusy)return;if(!metadataReady){metadataStatus("Settings could not be loaded. Reopen the Telemetry tab before saving.",true);return;}const b={preferred:$('[name="metadata-preference"]:checked').value,contact:$('#metadataContact').value,minutes:Number($('#metadataMinutes').value),batchSize:Number($('#metadataBatchSize').value),preferredPeer:$('#metadataPreferredPeer').value,apiKey:$('#metadataKey').value,secret:$('#metadataSecret').value,replaceCredentials:$('#metadataReplace').checked};for(const [k,id] of Object.entries(metadataFields))b[k]=$('#'+id).checked;metadataLock(true);metadataStatus('Saving settings…');try{const d=await metadataResponse(await post('/api/admin/telemetry/metadata',b,'PUT'));if(d.ok!==true)throw Error('Settings were not confirmed saved.');if(b.apiKey&&d.apiKeyConfigured===false)throw Error('The server did not confirm the API key was saved.');$('#metadataKey').value='';$('#metadataSecret').value='';$('#metadataReplace').checked=false;metadataDirty=false;providerStatus('lastfm','Saved settings — test to verify');providerStatus('musicbrainz','Saved settings — test to verify');if('apiKeyConfigured' in d)renderMetadataCredentials(d);metadataStatus('Metadata settings saved.');await loadMetadataSettings({force:true});}catch(e){metadataStatus(e.message,true);}finally{metadataLock(false);}});
$('#metadataForm').addEventListener('click',async e=>{const provider=e.target.dataset.metadataTest;if(!provider&&!['metadataRun','metadataScan','metadataPause','metadataStop','metadataPull','metadataRescanFiles'].includes(e.target.id))return;if(metadataBusy)return;if(!metadataReady){metadataStatus('Settings could not be loaded. Reopen the Telemetry tab and retry.',true);return;}if(!provider&&metadataDirty&&!['metadataPause','metadataStop'].includes(e.target.id)){metadataStatus('Save your settings before running enrichment.',true);$('#metadataCoverageStatus').textContent='Save your settings below before scanning.';return;}if(e.target.id==='metadataRescanFiles'&&!confirm('Rescan all file metadata? Original music files will remain unchanged. Stop the active scanner first.'))return;const scanAction=metadataRuntime==='docker'?({metadataScan:'start',metadataPause:'pause',metadataStop:'stop',metadataRescanFiles:'rescan-files'}[e.target.id]):null;
if(scanAction){metadataLock(true);try{const d=await metadataResponse(await post('/api/admin/telemetry/metadata/'+scanAction,{}));renderMetadataScan({scan:d});}catch(err){metadataStatus(err.message,true);}finally{metadataLock(false);}return;}
const pull=e.target.id==='metadataPull';metadataLock(true);if(provider)providerStatus(provider,'Testing…');else{$('#metadataProgressWrap').classList.remove('hidden');$('#metadataProgress').removeAttribute('value');$('#metadataProgressText').textContent='Running a bounded metadata batch…';metadataStatus('Running batch…');$('#metadataCoverageStatus').textContent='Scanning a bounded batch…';}try{const body=provider?{provider,...(provider==='lastfm'?{apiKey:$('#metadataKey').value}:{contact:$('#metadataContact').value})}:{};const d=await metadataResponse(await post('/api/admin/telemetry/metadata/'+(provider?'test':pull?'pull':'run'),body));if(provider){providerStatus(provider,d.source==='entered'?'Connection successful · entered value, not saved':'Connection successful · saved configuration','ok');}else{const skipped=d.skipped||d.disabled,failed=Number(d.errors)>0||!!d.error;const message=skipped?((d.reason||'Batch skipped')+(d.retryAt?' · retry after '+new Date(d.retryAt).toLocaleTimeString():'')):d.error||`Batch complete: ${d.verified||0} verified, ${d.imported||0} imported, ${d.errors||0} errors.`;$('#metadataProgress').value=skipped||failed?0:100;$('#metadataProgressText').textContent=message;metadataStatus(message,failed);$('#metadataCoverageStatus').textContent=message+(skipped?'':' Enable scheduled enrichment to continue automatically.');await loadMetadataSettings({force:true});}}catch(e){if(provider)providerStatus(provider,e.message,'err');else{$('#metadataProgress').value=0;$('#metadataProgressText').textContent='Batch not confirmed complete.';$('#metadataCoverageStatus').textContent=e.message;metadataStatus(e.message,true);}}finally{metadataLock(false);}});
$('#metadataForm').addEventListener('metadata-online-run',async()=>{
 if(metadataBusy||!metadataReady||metadataDirty)return;metadataLock(true);metadataStatus('Scanning online metadata in a bounded batch…');
 try{const d=await metadataResponse(await post('/api/admin/telemetry/metadata/online-scan',{}));const msg=d.error||d.skipped?d.error||d.reason:`Online batch finished · ${d.verified||0} verified · ${d.errors||0} errors`;metadataStatus(msg,!!d.error);await loadMetadataSettings({force:true});}
 catch(e){metadataStatus(e.message,true);}finally{metadataLock(false);}
});
$('#netTabCrons').onclick=()=>{location.hash='network/crons';showNetworkTab('crons');};
function cronJobTemplate(key){
  const id="cron-"+key;
  if(key==='telemetry')return `<fieldset class="cron-job" id="${id}" style="border:1px solid var(--line2);border-radius:12px;padding:14px;margin:14px 0 20px">
    <legend><label><input type="checkbox" data-cron="telemetry" data-field="enabled" checked> Share my telemetry with the HIVE</label></legend>
    <p class="muted">Enabled by default: exchange telemetry every five minutes. When unchecked, this server can still <b>pull</b> peer telemetry, but its own feed is unavailable.</p>
    <div class="form" style="display:flex;flex-wrap:wrap;gap:12px;align-items:end">
      <label>Automatic sync interval <select data-cron="telemetry" data-field="minutes">${[5,10,15,30,60,120].map(n=>`<option value="${n}">${n<60?n+' minutes':n/60+' hour'+(n>60?'s':'')}</option>`).join('')}</select></label>
      <button class="btn ghost cron-manual" type="button" data-run-cron="telemetry">Grab telemetry now</button>
    </div>
    <div class="cron-progress" data-progress="telemetry" hidden><progress max="100" value="0"></progress><span class="muted" role="status"></span></div>
  </fieldset>`;
  return `<fieldset class="cron-job" id="${id}" style="border:1px solid var(--line2);border-radius:12px;margin:16px 0;padding:14px">
    <legend><label><input type="checkbox" data-cron="${key}" data-field="enabled"> ${CRON_LABELS[key]}</label></legend>
    ${key==="peers"?`<label class="check" style="margin:8px 0 12px 12px"><input type="checkbox" data-cron="peers" data-field="sync_catalogue"> Sync peer catalogues and playlists (metadata only)</label>`:""}
    <div class="cron-fields">
      <label>Repeat
        <select data-cron="${key}" data-field="frequency"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>
      </label>
      <label data-schedule="daily">Time (24-hour)
        <input type="time" data-cron="${key}" data-field="time" value="02:00" step="60">
      </label>
      <label data-schedule="weekly" class="hidden">Day of week
        <select data-cron="${key}" data-field="weekday">${cronWeekdays.map((day,i)=>`<option value="${i}">${day}</option>`).join("")}</select>
      </label>
      <label data-schedule="monthly" class="hidden">Day of month
        <select data-cron="${key}" data-field="monthday">${Array.from({length:30},(_,i)=>`<option value="${i+1}">${i+1}</option>`).join("")}</select>
      </label>
    </div>
    <div style="margin-top:12px"><button class="btn ghost cron-manual" type="button" data-run-cron="${key}">Run now</button></div>
    <div class="cron-progress" data-progress="${key}" hidden><progress max="100" value="0"></progress><span class="muted" role="status"></span></div>
  </fieldset>`;
}
$("#cronJobs").innerHTML=CRON_KEYS.map(cronJobTemplate).join("");
const cronField=(key,field)=>document.querySelector(`[data-cron="${key}"][data-field="${field}"]`);
function syncCronFields(key){
  if(key==='telemetry')return;
  const group=$("#cron-"+key),enabled=cronField(key,"enabled").checked,frequency=cronField(key,"frequency").value;
  group.querySelectorAll("[data-schedule]").forEach(el=>el.classList.toggle("hidden",el.dataset.schedule!==frequency));
  group.querySelector(".cron-fields").classList.toggle("cron-disabled",!enabled);
}
$("#cronJobs").addEventListener("change",e=>{
  const key=e.target.dataset.cron;if(key)syncCronFields(key);
});
async function loadCrons(){
  try{
    const res=await fetch("/api/admin/crons",{cache:"no-store"});
    if(!res.ok)throw Error("Unable to load schedules");
    const config=await res.json(),tz=$("#cronTimezone");
    const zones=availableZones();
    if(config.timezone&&!zones.includes(config.timezone))zones.unshift(config.timezone);
    tz.innerHTML=zones.map(z=>`<option value="${esc(z)}">${esc(z)}</option>`).join("");
    tz.value=config.timezone||"UTC";
    for(const key of CRON_KEYS){
      const job=config.jobs?.[key]||{};
      for(const field of ["enabled","frequency","time","weekday","monthday"]){
        const input=cronField(key,field);if(job[field]!==undefined){
          if(field==="enabled")input.checked=!!job[field];else input.value=String(job[field]);
        }
      }
      if(key==="peers")cronField(key,"sync_catalogue").checked=!!job.sync_catalogue;
      if(key==="telemetry"){
        cronField(key,'enabled').checked=job.enabled!==false;
        cronField(key,'minutes').value=String(job.minutes||5);
      }
      syncCronFields(key);
    }
    cronsLoaded=true;
  }catch(e){$("#cronMsg").textContent=e.message||"Unable to load schedules";}
}
$("#cronForm").addEventListener("submit",async e=>{
  e.preventDefault();const btn=$("#cronSave");btn.disabled=true;
  const config={timezone:$("#cronTimezone").value,jobs:{}};
  for(const key of CRON_KEYS){
    if(key==='telemetry'){
      config.jobs.telemetry={enabled:cronField(key,'enabled').checked,minutes:Number(cronField(key,'minutes').value)};
      continue;
    }
    config.jobs[key]={enabled:cronField(key,"enabled").checked,
      ...(key==="peers"?{sync_catalogue:cronField(key,"sync_catalogue").checked}:{}),
      frequency:cronField(key,"frequency").value,time:cronField(key,"time").value,
      weekday:Number(cronField(key,"weekday").value),monthday:Number(cronField(key,"monthday").value)};
  }
  try{const res=await post("/api/admin/crons",config,"PUT");const result=await res.json();
    if(!res.ok)throw Error(result.error||"Unable to save schedules");
    flashMsg("#cronMsg","Schedules saved successfully.");
  }catch(e){flashMsg("#cronMsg",e.message,true);}finally{btn.disabled=false;}
});

// Manual jobs are async on the Worker; the progress bar polls actual persisted status.
$('#cronJobs').addEventListener('click',async e=>{
  const button=e.target.closest('button[data-run-cron]');if(!button)return;
  const kind=button.dataset.runCron,panel=$(`[data-progress="${kind}"]`);
  if(!panel)return;
  const progress=panel.querySelector('progress'),status=panel.querySelector('span');
  panel.hidden=false;progress.value=0;status.textContent='Starting…';button.disabled=true;
  try{
    const r=await post('/api/admin/crons/run',{kind});const data=await r.json();
    if(!r.ok)throw Error(data.error||'Unable to start job');
    for(let attempt=0;attempt<75;attempt++){
      await new Promise(resolve=>setTimeout(resolve,1200));
      const v=await fetch('/api/admin/crons/run-status?id='+encodeURIComponent(data.runId),{cache:'no-store'});
      if(!v.ok)throw Error('Unable to get job status');
      const state=await v.json();progress.value=Math.max(0,Math.min(100,Number(state.progress)||0));
      status.textContent=state.message||state.state;
      if(['complete','error'].includes(state.state))break;
    }
  }catch(error){status.textContent=error.message;}
  finally{button.disabled=false;}
});

// ---------- network (peer-to-peer) ----------
function paintNetShare(on) {
  $("#netShare").checked = !!on;
  $("#netShareBox").classList.toggle("hidden", !on);
  if (on) $("#netLink").value = location.origin;
}
function peerRow(p) {
  const ok = p.online || (p.last_ok && !p.last_error);
  const status = ok
    ? `<span style="color:var(--accent)">Connected</span> · ${p.track_count || 0} songs`
    : `<span style="color:var(--danger)">Offline</span>${p.last_error ? ` · ${esc(p.last_error)}` : ""}`;
  return `<tr data-peer="${p.id}">
    <td style="width:46px"><input type="radio" name="primaryPeer" data-primary="${esc(p.id)}" aria-label="Treat ${esc(p.name||p.url)} as local" ${p.is_primary?"checked":""}></td>
    <td><b>${esc(p.name || p.url)}</b><br><span class="muted" style="word-break:break-all">${esc(p.url)}</span><br><span class="muted">${status}</span></td>
    <td style="text-align:right;white-space:nowrap">
      <button class="btn ghost" data-a="sync" title="Sync metadata only; no music files downloaded" aria-label="Cloud sync metadata" ${small}>☁ ↻</button>
      <button class="btn ghost" data-a="refresh" ${small}>Refresh</button>
      <button class="btn danger" data-a="rm" ${small}>Remove</button>
    </td></tr>`;
}
async function loadNetwork() {
  try {
    const d = await (await fetch("/api/admin/network")).json();
    paintNetShare(d.share);
    window.__peers = d.peers || [];
    $("#netPeers").innerHTML = window.__peers.length
      ? `<p class="muted">Select one peer to treat its catalogue as local, without downloading its audio. <label><input type="radio" name="primaryPeer" data-primary="" ${!d.primary_peer_id?"checked":""}> None</label></p><table><tbody>${window.__peers.map(peerRow).join("")}</tbody></table>`
      : "No peers yet.";
  } catch {
    $("#netPeers").textContent = "Could not load network settings.";
  }
}
$("#netShare").addEventListener("change", async () => {
  const on = $("#netShare").checked;
  const r = await post("/api/admin/network", { share: on }, "PUT");
  if (!r.ok) {
    paintNetShare(!on);
    flashMsg("#netShareMsg", (await r.json().catch(() => ({}))).error || "Couldn't save.", true);
    return;
  }
  paintNetShare(on);
  flashMsg("#netShareMsg", on ? "Sharing is on. Others can add your link." : "Sharing is off.");
});
$("#netCopy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#netLink").value);
    flashMsg("#netShareMsg", "Link copied.");
  } catch {
    $("#netLink").select();
    flashMsg("#netShareMsg", "Select the link and copy it manually.", true);
  }
});
$("#netAddBtn").addEventListener("click", () => {
  $("#netAddForm").classList.remove("hidden");
  $("#netAddMsg").textContent = "";
  $("#netPeerUrl").value = "";
  $("#netPeerUrl").focus();
});
$("#netAddCancel").addEventListener("click", () => {
  $("#netAddForm").classList.add("hidden");
  $("#netAddMsg").textContent = "";
});
$("#netConnect").addEventListener("click", async () => {
  const url = $("#netPeerUrl").value.trim();
  if (!url) { flashMsg("#netAddMsg", "Paste a peer link first.", true); return; }
  const b = $("#netConnect");
  b.disabled = true; b.textContent = "Connecting…";
  const r = await post("/api/admin/network/peers", { url });
  const j = await r.json().catch(() => ({}));
  b.disabled = false; b.textContent = "Connect";
  if (!r.ok) { flashMsg("#netAddMsg", j.error || "Couldn't connect.", true); return; }
  flashMsg("#netAddMsg", `Connected to “${j.name || j.url}” (${j.track_count || 0} songs).`);
  $("#netAddForm").classList.add("hidden");
  await loadNetwork();
});
$("#netPeers").addEventListener("change",async e=>{
  if(e.target.name!=="primaryPeer")return;
  const id=e.target.dataset.primary;
  const response=await post("/api/admin/network/primary",{peer_id:id},"PUT");
  const result=await response.json().catch(()=>({}));
  flashMsg("#netMsg",response.ok?(id?"Primary peer selected. Its catalogue will appear as local on the website.":"Using only this server as local."):(result.error||"Could not select primary peer"),!response.ok);
  await loadNetwork();
  if(response.ok)try{localStorage.setItem("wasp_peer_sync",String(Date.now()));}catch{}
});
$("#netPeers").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b || !b.dataset.a) return;
  const id = b.closest("tr").dataset.peer;
  if (b.dataset.a === "rm") {
    if (!confirm("Remove this peer? Its songs will no longer appear here.")) return;
    await fetch("/api/admin/network/peers/" + id, { method: "DELETE" });
    await loadNetwork();
    return;
  }
  if (b.dataset.a === "refresh" || b.dataset.a === "sync") {
    const hard=b.dataset.a==="refresh",label=b.textContent, buttons=[...b.closest("tr").querySelectorAll("button")];
    buttons.forEach(x=>x.disabled=true);b.textContent="Syncing…";
    const meter=$("#netSyncProgress"),bar=$("#netSyncBar"),message=$("#netSyncStatus");
    meter.hidden=false;bar.value=0;message.textContent=hard?"Refreshing peer information…":"Syncing peer metadata…";
    try {
      if(hard){const r=await fetch(`/api/admin/network/peers/${encodeURIComponent(id)}/refresh`,{method:"POST",cache:"no-store"});
        const j=await r.json();if(!r.ok)throw Error(j.error||"Peer refresh failed");}
      const totals={};let federation=null;const phases=[["tracks",40],["playlists",70],["users",86],["finish",100]];
      for(const [phase,percent] of phases){
        message.textContent=`${phase==="finish"?"Publishing":`Syncing ${phase}`}…`;
        const r=await post(`/api/admin/network/peers/${encodeURIComponent(id)}/sync`,{phase});
        const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||`Unable to sync ${phase}`);
        totals[phase]=j.count||0;if(phase==="finish")federation=j.federation||null;bar.value=percent;
      }
      const extra=federation?` + ${federation.tracks||0} songs from ${federation.sources||0} connected downstream peers`:'';
      const warning=federation?.errors?.length?` (${federation.errors.length} source warning(s); see Mobile Bridge deployment guide)`:'';
      message.textContent=`Complete: ${totals.tracks} gateway songs, ${totals.playlists} server playlists, ${totals.users} user playlists${extra}${warning}.`;
      flashMsg("#netMsg",`Synced ${totals.tracks+(federation?.tracks||0)} songs and ${totals.playlists+totals.users+(federation?.playlists||0)} playlists. No audio files downloaded.${federation?.errors?.length?" Some downstream peers unavailable.":""}`);
      // Notify other tabs on the same origin. Their periodic revision check will reload.
      try{localStorage.setItem("wasp_peer_sync",String(Date.now()));}catch{}
      await loadNetwork();
    } catch(err){message.textContent=err.message;flashMsg("#netMsg",err.message,true);}
    finally{buttons.forEach(x=>x.disabled=false);b.textContent=label;}
  }
});

show();

// Admin-only, read-only documentation viewer. Markdown source is bundled at
// build time; the public static directory never exposes these files.
let docsLoaded=false;
const mdEscape=(s)=>esc(String(s||""));
function mdInline(text){
  let safe=mdEscape(text);
  safe=safe.replace(/`([^`]+)`/g,(_,t)=>`<code>${t}</code>`);
  safe=safe.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  safe=safe.replace(/\*([^*]+)\*/g,'<em>$1</em>');
  safe=safe.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,(_,label,url)=>`<a href="${url.replace(/&amp;/g,'&amp;')}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  return safe;
}
function docsMarkdown(src){
  let html='',code=[],mode=false,ul=false,ol=false,table=false;
  const close=()=>{if(ul){html+='</ul>';ul=false;}if(ol){html+='</ol>';ol=false;}if(table){html+='</tbody></table>';table=false;}};
  for(const line of String(src||"").split(/\r?\n/)){
    if(/^```/.test(line)){close();if(mode){html+=`<pre><code>${mdEscape(code.join('\n'))}</code></pre>`;code=[];mode=false;}else mode=true;continue;}
    if(mode){code.push(line);continue;}
    if(!line.trim()){close();continue;}
    const h=/^(#{1,6})\s+(.+)$/.exec(line);
    if(h){close();html+=`<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`;continue;}
    if(/^\s*---+\s*$/.test(line)){close();html+='<hr>';continue;}
    if(line.includes('|') && /^\s*\|?\s*:?[-]{3}/.test(line)){continue;}
    if(/^\s*\|(.+)\|\s*$/.test(line)){
      if(ul){html+='</ul>';ul=false;}if(ol){html+='</ol>';ol=false;}
      if(!table){html+='<table><tbody>';table=true;}
      html+='<tr>'+line.trim().replace(/^\||\|$/g,'').split('|').map(c=>`<td>${mdInline(c.trim())}</td>`).join('')+'</tr>';continue;
    }
    const bullet=/^\s*[-*]\s+(.+)$/.exec(line),number=/^\s*\d+\.\s+(.+)$/.exec(line);
    if(bullet||number){if(table){html+='</tbody></table>';table=false;}
      if(bullet&&!ul){if(ol){html+='</ol>';ol=false;}html+='<ul>';ul=true;}
      if(number&&!ol){if(ul){html+='</ul>';ul=false;}html+='<ol>';ol=true;}
      html+=`<li>${mdInline((bullet||number)[1])}</li>`;continue;}
    close();if(/^>/.test(line))html+=`<blockquote>${mdInline(line.replace(/^>\s?/,''))}</blockquote>`;
    else html+=`<p>${mdInline(line)}</p>`;
  }
  close();if(mode)html+=`<pre><code>${mdEscape(code.join('\n'))}</code></pre>`;
  return html;
}
async function loadDocs(){
  if(docsLoaded)return;
  try{
    const r=await fetch('/api/admin/docs',{cache:'no-store'});if(!r.ok)throw Error('Unable to load documentation');
    const docs=await r.json();const select=$('#docsSelect');
    select.innerHTML=docs.map(d=>`<option value="${esc(d.name)}">${esc(d.name)}</option>`).join('');
    docsLoaded=true;if(docs.length)await showDoc(docs[0].name);
    else $('#docsMsg').textContent='No release notes available.';
  }catch(e){flashMsg('#docsMsg',e.message,true);}
}
async function showDoc(name){
  try{
    const r=await fetch('/api/admin/docs?name='+encodeURIComponent(name),{cache:'no-store'});
    if(!r.ok)throw Error('Unable to load document');
    const doc=await r.json();$('#docsBody').innerHTML=docsMarkdown(doc.content);
    $('#docsMsg').textContent=doc.name;
  }catch(e){flashMsg('#docsMsg',e.message,true);}
}
$('#docsSelect').onchange=e=>showDoc(e.target.value);

// WASP v15: read-only exact-file duplicate audit. Deletion is allowed only
// for an unreferenced, unplayed, web-uploaded duplicate; /music stays read-only.
let duplicateRefreshBusy=false;
async function loadDuplicates(){
  if(duplicateRefreshBusy)return;duplicateRefreshBusy=true;
  try{
    const r=await fetch('/api/admin/duplicates',{cache:'no-store'});
    const result=await r.json();if(!r.ok)throw Error(result.error||'Unable to load duplicates');
    $('#duplicateCount').textContent=result.duplicate_count||0;
    const st=result.status||{},pct=st.total?Math.round((st.scanned||0)*100/st.total):0;
    $('#hashScanProgress').value=Math.max(0,Math.min(100,pct));
    $('#hashScanState').textContent=`${st.state||'not_run'} · ${(st.scanned||0).toLocaleString()} / ${(st.total||0).toLocaleString()} files · ${(st.changed||0).toLocaleString()} newly hashed`+(st.error?' · '+st.error:'');
    $('#duplicateList').innerHTML=result.groups?.length?result.groups.map(g=>`<section class="card" style="background:transparent"><b>${g.qty} identical files</b><p class="muted">SHA-256: <code>${esc(g.sha)}</code></p><table><thead><tr><th>Song</th><th>Source</th><th>Size</th><th>Action</th></tr></thead><tbody>${(g.items||[]).map(item=>`<tr><td>${esc(item.title||item.id)}<br><span class="muted">${esc(item.source_path||item.artist||'')}</span></td><td>${esc(item.source)}</td><td>${(Number(item.size)||0).toLocaleString()} bytes</td><td>${item.source==='upload'?`<button class="btn danger" data-duplicate-delete="${esc(item.id)}">Review delete</button>`:'Read-only'}</td></tr>`).join('')}</tbody></table></section>`).join(''):'<p class="muted">No exact duplicates indexed yet. Schedule a scan or scan now.</p>';
  }catch(e){flashMsg('#duplicateMsg',e.message,true);}finally{duplicateRefreshBusy=false;}
}
$('#hashScanNow').onclick=async()=>{
  const r=await post('/api/admin/hash-scan',{}),data=await r.json().catch(()=>({}));
  flashMsg('#hashScanMsg',r.ok?'Folder scan queued; progress updates here.':(data.error||'Failed to queue scan'),!r.ok);
  if(r.ok)loadDuplicates();
};
$('#duplicateList').onclick=async e=>{
  const btn=e.target.closest('button[data-duplicate-delete]');if(!btn)return;
  const id=btn.dataset.duplicateDelete;
  if(!confirm('This will permanently delete this managed upload ONLY if an identical file survives and it has no plays, reactions or playlist references. Continue?'))return;
  const word=prompt('To confirm, type: delete duplicate');if(word!=='delete duplicate')return;
  const r=await fetch('/api/admin/duplicates/'+encodeURIComponent(id),{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:word})});
  const data=await r.json().catch(()=>({}));flashMsg('#duplicateMsg',r.ok?'Eligible duplicate deleted.':(data.error||'Deletion refused'),!r.ok);
  if(r.ok){await loadDuplicates();refresh();}
};
setInterval(()=>{if(location.hash.startsWith('#duplicates'))loadDuplicates();},12000);

// Low-frequency polling for outstanding publishing requests; no user addresses are exposed.
setInterval(pollAdminPublishRequests,30000);

// WASP v18.1.5 — temporary Windows npm metadata source. The route is
// implemented only by the local Node proxy, never by Cloudflare or Docker.
let pcScanActive=false,pcScanLoading=false;
async function readPcScan(){if(pcScanLoading)return;pcScanLoading=true;
 try{const r=await fetch('/api/admin/pc-source/status',{cache:'no-store'});if(!r.ok)return;const d=await r.json();if(!d.local_pc)return;
  $('#pcMetadataSourcePanel').classList.remove('hidden');if(document.activeElement!==$('#pcMusicPath')&&!$('#pcMusicPath').value)$('#pcMusicPath').value=d.folder||'';
  const s=d.scan||{},total=s.discovered||0,done=s.processed||0;$('#pcScanProgress').value=total?Math.round(100*done/total):0;
  pcScanActive=s.state==='running';$('#pcScanNow').disabled=pcScanActive;
  $('#pcScanProgressText').textContent=`${s.state||'idle'} · ${done.toLocaleString()} / ${total.toLocaleString()} MP3 files processed · ${s.changed||0} changed · ${s.skipped||0} unchanged · ${s.errors||0} errors · ${(d.entries||0).toLocaleString()} indexed`;
  if(s.lastError)$('#pcScanMessage').textContent=s.lastError;
 }catch{}finally{pcScanLoading=false;}
}
$('#pcScanNow').onclick=async()=>{const folder=$('#pcMusicPath').value.trim();if(!folder){$('#pcScanMessage').textContent='Enter an absolute Windows folder path, e.g. D:\\MUSIC.';return;}
 if(!confirm('Scan this folder read-only and update the local Picard metadata catalogue? No MP3s will be uploaded or modified.'))return;
 $('#pcScanMessage').textContent='Starting read-only metadata scan…';try{const r=await post('/api/admin/pc-source/scan',{folder});const d=await r.json();if(!r.ok)throw Error(d.error||'Scan failed');$('#pcScanMessage').textContent='Scan started. Keep the PC app running until complete.';await readPcScan();}catch(e){$('#pcScanMessage').textContent=e.message;}
};
void readPcScan();setInterval(()=>{if(pcScanActive||location.hash.startsWith('#collection'))void readPcScan();},1800);

// Administrator-only metadata pull: secrets and peer URLs are validated on the
// server, never stored in browser storage or accepted from arbitrary user URLs.
let metadataBankSources=[],metadataBankOffset=0,metadataBankBusy=false,metadataBankLastBatch='',metadataBankCurrentSource='';
const bankMessage=(message,error=false)=>{const el=$('#metadataBankStatus');el.textContent=message;el.classList.toggle('err',error);};
async function bankApi(route,body){const r=body===undefined?await fetch('/api/admin/metadata-bank/'+route,{cache:'no-store'}):await post('/api/admin/metadata-bank/'+route,body);return metadataResponse(r);}
async function loadBankSources(){try{const r=await bankApi('sources');metadataBankSources=r.sources||[];
 const root=$('#metadataBankSources');root.replaceChildren();if(!metadataBankSources.length){const p=document.createElement('p');p.className='muted';p.textContent='No authorized metadata source configured on this deployment. Set WASP_METADATA_SOURCE_URL and WASP_METADATA_PULL_TOKEN (or WASP_METADATA_SOURCES_JSON) in your deployment secrets.';root.append(p);return;}
 for(const s of metadataBankSources){const label=document.createElement('label');label.className='metadata-check';const input=document.createElement('input');input.type='checkbox';input.value=s.url;input.dataset.bankSource='1';const span=document.createElement('span');span.textContent=`${s.name} · ${s.url}`;label.append(input,span);root.append(label);}metadataBankSources.length===1&&(root.querySelector('input').checked=true);
 }catch(e){bankMessage(e.message,true);}}
const bankSelected=()=>[...document.querySelectorAll('[data-bank-source]:checked')].map(e=>e.value);
$('#metadataBankRefresh').onclick=()=>void loadBankSources();void loadBankSources();
$('#metadataBankFingerprint').onclick=async()=>{if(metadataBankBusy)return;metadataBankBusy=true;const btn=$('#metadataBankFingerprint');btn.disabled=true;
 try{let s=await bankApi('fingerprints/status');if(!confirm(`Prepare exact audio-content fingerprints for ${s.remaining} locally hosted songs? WASP will read its existing audio internally in bounded batches. No MP3s will be uploaded or changed.`))return;
  const total=Number(s.total)||0;while(s.remaining){const d=await bankApi('fingerprints',{});if(d.remaining>=s.remaining&&!d.processed)break;s={...s,remaining:d.remaining};$('#metadataBankProgress').value=total?Math.round(100*(total-d.remaining)/total):100;bankMessage(`Audio identity index: ${total-d.remaining} / ${total} tracks prepared${d.reason?' · '+d.reason:''}. Keep this tab open to continue.`);}
  bankMessage('Local audio identity preparation complete. You can now pull corrected Picard tags from your selected source.');
 }catch(e){bankMessage(e.message,true);}finally{btn.disabled=false;metadataBankBusy=false;}}
$('#metadataBankPull').onclick=async()=>{if(metadataBankBusy)return;const sources=bankSelected();if(!sources.length){bankMessage('Select at least one configured source.',true);return;}
 if(!confirm('Manually fetch Picard metadata from the selected sources and stage differences for review? No existing tracks will be changed yet.'))return;
 metadataBankBusy=true;$('#metadataBankPull').disabled=true;$('#metadataBankProgress').value=0;let total=0;
 try{for(let i=0;i<sources.length;i++){const source=sources[i];let cursor=0,iterations=0;
  do{const d=await bankApi('pull',{source,cursor});total+=d.staged||0;cursor=d.cursor;iterations++;bankMessage(`Pulling ${source}: ${iterations*25-(25-(d.count||0))} entries examined · ${total} differences staged…`);$('#metadataBankProgress').value=Math.min(98,Math.round((i+0.9)/sources.length*100));if(!d.more)break;if(iterations>5000)throw Error('Page safety limit reached');}while(true);
  metadataBankCurrentSource=source;}
 $('#metadataBankProgress').value=100;bankMessage(`Pull complete: ${total} new or changed entries staged for review. Existing tracks were not modified.`);metadataBankOffset=0;await reviewBank();
 }catch(e){bankMessage('Pull stopped: '+e.message+'. Earlier staged entries are preserved. Retry is idempotent.',true);}finally{metadataBankBusy=false;$('#metadataBankPull').disabled=false;}}
function bankDataList(){let list=$('#metadataBankTrackOptions');if(!list){list=document.createElement('datalist');list.id='metadataBankTrackOptions';$('#metadataBankReview').append(list);}list.replaceChildren();for(const t of (window.__tracks||[]).slice(0,2000)){const opt=document.createElement('option');opt.value=t.id;opt.label=`${t.title} · ${t.artist}`;list.append(opt);}}
async function bankHistory(){if(!metadataBankCurrentSource)return;try{const r=await bankApi('history?source='+encodeURIComponent(metadataBankCurrentSource));const sel=$('#metadataBankHistory'),current=sel.value;sel.replaceChildren(new Option('Previous applied batches…',''));
  for(const b of r.batches||[]){const date=new Date(b.applied_at).toLocaleString();const option=new Option(`${date} · ${b.total} tracks · ${b.undone||0} restored`,b.batch_id);sel.add(option);}sel.value=metadataBankLastBatch||current||'';
 }catch{}}
async function reviewBank(){const source=metadataBankCurrentSource||bankSelected()[0];if(!source){bankMessage('Choose a metadata source first.');return;}metadataBankCurrentSource=source;
 try{const d=await bankApi('pending?source='+encodeURIComponent(source)+'&offset='+metadataBankOffset);$('#metadataBankReview').classList.remove('hidden');$('#metadataBankReviewStats').textContent=`${d.count} unapplied metadata records · ${d.audio_matches} exact audio matches · ${d.review} require confirmation · ${d.unresolved} unmatched or ambiguous.`;
 const box=$('#metadataBankRows');box.replaceChildren();bankDataList();if(!d.items.length){const p=document.createElement('p');p.className='muted';p.textContent='No pending items on this page. Return to earlier results or pull changed metadata.';box.append(p);}for(const entry of d.items){const t=entry.tags||{},div=document.createElement('div');div.className='metadata-bank-item';
 div.innerHTML=`<label><input type="checkbox" data-bank-approve="${esc(entry.entry_id)}" ${['audio','manual'].includes(entry.match_type)?'':'disabled'}> <b>${esc(t.title||'Untitled')}</b> · ${esc(t.artist||'Unknown artist')} <span class="muted">${esc(t.album||'')} · ${esc(entry.match_type)}</span></label><p class="muted">Current: ${esc(entry.old_title||'No match')} · ${esc(entry.old_artist||'')} · ${esc(entry.old_album||'')}<br>Picard: ${esc(t.title)} · ${esc(t.artist)} · ${esc(t.album)} · ${esc((t.genre||[]).join('; '))}</p><label class="muted">Existing WASP track ID <input type="text" list="metadataBankTrackOptions" data-bank-target="${esc(entry.entry_id)}" placeholder="Choose an existing track" value="${esc(entry.track_id||'')}" spellcheck="false" style="max-width:360px"></label> <button type="button" class="btn ghost" data-bank-match="${esc(entry.entry_id)}">Confirm manual match</button>`;
 box.append(div);}$('#metadataBankNext').disabled=metadataBankOffset+40>=d.count;void bankHistory();
 }catch(e){bankMessage(e.message,true);}}
$('#metadataBankPreview').onclick=()=>{metadataBankOffset=0;void reviewBank();};$('#metadataBankNext').onclick=()=>{metadataBankOffset+=40;void reviewBank();};
$('#metadataBankRows').onclick=async e=>{const btn=e.target.closest('[data-bank-match]');if(!btn)return;const id=btn.dataset.bankMatch;const target=$('#metadataBankRows').querySelector(`[data-bank-target="${CSS.escape(id)}"]`)?.value.trim();if(!target){bankMessage('Enter an existing WASP track ID.',true);return;}
 if(!confirm('Manually match this Picard entry to WASP track '+target+'? Verify they are the same recording before proceeding.'))return;
 try{await bankApi('assign',{source:metadataBankCurrentSource,entry_id:id,track_id:target,confirm:'match manually'});bankMessage('Manual match saved for review. No track metadata has changed.');await reviewBank();}catch(error){bankMessage(error.message,true);}}
$('#metadataBankApply').onclick=async()=>{if(metadataBankBusy)return;const ids=[...$('#metadataBankRows').querySelectorAll('[data-bank-approve]:checked')].map(e=>e.dataset.bankApprove).slice(0,20);if(!ids.length){bankMessage('Select exact audio matches or confirmed manual matches.',true);return;}
 if(prompt(`Apply corrected Picard title, artist, album, track number and additional saved tags to ${ids.length} existing WASP tracks? To confirm, type: apply metadata`)!=='apply metadata')return;
 metadataBankBusy=true;try{const d=await bankApi('apply',{source:metadataBankCurrentSource,ids,confirm:'apply metadata'});metadataBankLastBatch=d.batch_id||'';bankMessage(`Applied ${d.applied} track updates. Audio, playlists and reactions remain unchanged. Undo batch: ${metadataBankLastBatch||'none'}`);await refresh();await reviewBank();}catch(e){bankMessage(e.message,true);}finally{metadataBankBusy=false;}}
$('#metadataBankUndo').onclick=async()=>{const batch=$('#metadataBankHistory').value||metadataBankLastBatch||prompt('Enter the metadata batch ID to restore:');if(!batch)return;if(prompt('Restore the previous metadata for this batch? To confirm, type: undo metadata')!=='undo metadata')return;
 try{const d=await bankApi('undo',{batch_id:batch,confirm:'undo metadata'});bankMessage(`Rolled back ${d.undone} tracks; ${d.conflicts} were changed afterward and were not overwritten.`);await refresh();await reviewBank();}catch(e){bankMessage(e.message,true);}}
