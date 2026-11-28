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

// Docker-specific collection subtab: only registered bind-mounted directories.
let dockerFoldersAvailable=false;
async function loadDockerMusicFolders(){
 const status=$('#dockerMusicMessage');
 try{
   const response=await fetch('/api/admin/music-folders',{cache:'no-store'});
   if(response.status===404){dockerFoldersAvailable=false;$('#collectionTabFolders').classList.add('hidden');return false;}
   const data=await response.json();if(!response.ok)throw Error(data.error||'Unable to read Docker folders');
   dockerFoldersAvailable=true;$('#collectionTabFolders').classList.remove('hidden');
   const defaults=new Set(data.defaults||[]),more=new Set(data.additional||[]);
   $('#dockerMusicRoots').innerHTML=(data.roots||[]).map(root=>`<div class="docker-folder-row"><code>${esc(root)}</code><span class="muted">${defaults.has(root)?'Default mount':more.has(root)?'Additional mount':'Configured mount'}</span>${more.has(root)?`<button class="btn ghost" type="button" data-folder-remove="${esc(root)}">Remove from scanner</button>`:''}</div>`).join('');
   status.textContent=data.scanning?'Directory scanner is currently running.':'Paths are read-only; music scanning runs automatically.';
   return true;
 }catch(e){status.textContent=e.message;return false;}
}
async function showCollectionTab(view='songs'){
 const folderView=view==='music-folders';
 if(folderView){const ok=await loadDockerMusicFolders();if(!ok){$('#collectionSongsPanel').classList.remove('hidden');$('#collectionFoldersPanel').classList.add('hidden');return;}}
 else void loadDockerMusicFolders();
 $('#collectionSongsPanel').classList.toggle('hidden',folderView);
 $('#collectionFoldersPanel').classList.toggle('hidden',!folderView);
 $('#collectionTabSongs').setAttribute('aria-selected',String(!folderView));
 $('#collectionTabFolders').setAttribute('aria-selected',String(folderView));
}
$('#collectionTabSongs').onclick=()=>{location.hash='collection';void showCollectionTab('songs')};
$('#collectionTabFolders').onclick=()=>{location.hash='collection/music-folders';void showCollectionTab('music-folders')};
$('#dockerMusicAdd').onclick=async()=>{
 const el=$('#dockerMusicRoot'),status=$('#dockerMusicMessage'),button=$('#dockerMusicAdd');button.disabled=true;
 status.textContent='Validating container directory…';
 try{const r=await post('/api/admin/music-folders',{path:el.value.trim()}),d=await r.json();if(!r.ok)throw Error(d.error||'Could not add folder');el.value='';await loadDockerMusicFolders();status.textContent='Saved. The new directory will be indexed automatically; reload Songs after scanning completes.';}
 catch(e){status.textContent=e.message;}finally{button.disabled=false;}
};
$('#dockerMusicRoots').onclick=async e=>{
 const button=e.target.closest('[data-folder-remove]');if(!button)return;
 const folder=button.dataset.folderRemove;
 if(!confirm('Stop indexing '+folder+'? This does not remove the Docker bind mount or delete music. Existing indexed tracks may still appear until reconciled.'))return;
 button.disabled=true;
 try{const r=await post('/api/admin/music-folders',{path:folder},'DELETE'),d=await r.json();if(!r.ok)throw Error(d.error||'Could not unregister folder');await loadDockerMusicFolders();$('#dockerMusicMessage').textContent='Removed from future scans. Existing audio was not deleted.';}
 catch(err){$('#dockerMusicMessage').textContent=err.message;button.disabled=false;}
};
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
  if (k === 'collection') void showCollectionTab(route.split('/')[1]==='music-folders'?'music-folders':'songs');
  if (k === "settings") showSettingsSubtab(['release-updates','rss'].includes(route.split('/')[1]) ? route.split('/')[1] : 'general');
  if (k === 'add') showAddSubtab(route.split('/')[1]==='recreate'?'recreate':'upload');
  if (k === 'danger') showDangerTab(route.split('/')[1]==='clean'?'clean':'delists');
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
    status.textContent='Announcement sent. It expires for everyone 10 minutes after sending.';
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
function showAddSubtab(which='upload'){
  const recreation=which==='recreate';
  $('#addUploadPanel').classList.toggle('hidden',recreation);
  $('#addRecreatePanel').classList.toggle('hidden',!recreation);
  $('#addTabUpload').setAttribute('aria-selected',String(!recreation));
  $('#addTabRecreate').setAttribute('aria-selected',String(recreation));
  if(recreation)void loadCollectionDraftHistory();
}
$('#addTabUpload').onclick=()=>{location.hash='add';showAddSubtab('upload')};
$('#addTabRecreate').onclick=()=>{location.hash='add/recreate';showAddSubtab('recreate')};
const recreateKind=()=>$('#recreateKind').value;
$('#recreateKind').onchange=()=>{$('#spotifyCollectionResults').innerHTML='';$('#spotifyCollectionSearch').value='';};
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
    const pl = r.kind === "playlist", isSong = r.kind === "song", songReview = isSong && !r.remote, albumReview = r.kind === "album" && !r.remote;
    const has = pl && r.total != null && Array.isArray(r.missing), canExpand = has || songReview || albumReview;
    const miss = has ? r.missing.length : 0;
    const sourceCount=Number.isSafeInteger(r.source_total)?r.source_total:null;
    const knownIncomplete=has && sourceCount!==null && sourceCount>r.total;
    const unverifiedBoundary=has && !!r.partial && !knownIncomplete;
    const progress = has ? `${r.matched}/${r.total}${knownIncomplete ? ` of ${sourceCount} reported` : unverifiedBoundary ? "+" : ""} · ${r.matched_local??r.matched} local · ${r.matched_peer||0} in peers · ${miss} missing song${miss === 1 ? "" : "s"}` : pl ? (r.total!=null ? "Availability check pending — refresh or wait for scheduled matching" : "Song list not available") : r.matched_local!=null ? `${r.matched_local} local · ${r.matched_peer||0} on peers` : "";
    const open = openReq.has(r.id);
    return `<tr data-r="${esc(r.id)}">
    <td style="width:76px"><label class="request-pick"><input type="checkbox" data-request-select="${esc(r.id)}" aria-label="Select ${esc(r.title)}" ${selectedRequests.has(r.id)?'checked':''}>${mini(r.image, r.title)}</label></td>
    <td>${esc(r.title)}${r.remote?' <span class="chip" title="Originating WASP retains ownership">HIVE peer</span>':''}<br><span class="muted">${KIND[r.kind]}${r.artist ? " · " + esc(r.artist) : ""}${r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener">Open on Spotify</a>` : ""}</span>${r.remote&&r.origin_status==='offline'?'<br><span class="muted">Requestee is offline</span>':''}${r.remote&&r.origin_domain?`<br><span class="muted">Origin: ${esc(r.origin_domain)} · ${esc(r.origin_status||'unknown')}</span>`:''}${progress ? `<br><span class="muted">${esc(progress)}${r.availability_checked_at?` · Checked ${esc(new Date(r.availability_checked_at).toLocaleString())}`:""}</span>` : ""}</td>
    <td style="text-align:right;white-space:nowrap">${canExpand ? `<button class="btn ghost" data-a="toggle" aria-expanded="${open}" aria-label="Show missing songs" ${small}>${open ? "▴" : "▾"}</button> ` : ""}<button class="btn ghost" data-a="${pl&&!r.remote?'refresh':'review-refresh'}" ${small}>Refresh</button> ${songReview||albumReview?`<button class="btn ghost" data-a="${albumReview?'album-scan':'song-scan'}" ${small}>Find potential match</button> `:''}${pl&&!r.remote?`<button class="btn ghost" data-a="scan-matches" ${small}>Scan potential matches</button> <button class="btn ghost" data-a="done" ${small}>Mark as done</button>`:''} ${['artist','album'].includes(r.kind)?`<button class="btn ghost" data-a="review-done" ${small}>Mark as done</button> `:''}${r.remote?`<button class="btn ghost" data-a="locate" ${small}>Locate origin</button> `:''}<button class="btn ghost" data-a="${r.remote&&r.origin_status==='offline'?'hide-offline':'remove'}" ${small} title="${r.remote?'Dismiss on this WASP only':'Cancel local request'}">${r.remote&&r.origin_status==='offline'?'Remove until online':'Remove'}</button></td></tr>
    ${has ? `<tr class="reqdetail${open ? "" : " hidden"}" data-d="${r.id}"><td></td><td colspan="2">
      ${miss ? `<ul class="missing req-missing">${r.missing.map((x) => `<li class="req-match-entry" data-req-index="${Number.isInteger(x.request_index)?x.request_index:-1}"><div class="req-miss-header"><span>${esc(x.t)}${x.a ? ` <span class="muted">· ${esc(x.a)}</span>` : ""}</span>${!r.remote?` <button class="btn ghost" data-a="match-scan" ${small}>Find potential match</button> <button class="btn ghost" data-a="match-request-track" ${small}>Request individual track</button> <button class="btn ghost" data-a="match-skip" ${small}>Remove from request</button>`:''}</div><div class="req-match-results"></div></li>`).join("")}</ul>` : `<p class="muted" style="margin:8px 0">Every song we can see is already in the library.</p>`}
      ${!r.remote?`<div class="request-manual-add"><label>Manually add a song to this request</label><input aria-label="Song title to add" data-req-song-title placeholder="Song title"><input aria-label="Artist to add" data-req-song-artist placeholder="Artist"><button type="button" class="btn ghost" data-a="match-add" ${small}>Add and find match</button></div>`:''}
      ${r.skipped?.length?`<details class="request-skipped"><summary>${r.skipped.length} removed request entries (restorable)</summary>${r.skipped.map(x=>`<div data-req-index="${x.request_index}">${esc(x.t)} · ${esc(x.a)} <button type="button" class="btn ghost" data-a="match-restore" ${small}>Undo removal</button></div>`).join('')}</details>`:''}
      ${knownIncomplete ? `<p class="muted" style="margin:4px 0;font-size:13px">Spotify reports ${sourceCount} songs, but only ${r.total} were retrieved. Fetch the full song list before completion; known missing Spotify songs cannot be skipped.</p>` :
        unverifiedBoundary ? `<p class="muted" style="margin:4px 0;font-size:13px">${r.total} Spotify songs retrieved; full playlist length unverified. More songs may exist beyond those retrieved.</p>` :
        r.source_status==='verified' ? `<p class="muted" style="margin:4px 0;font-size:13px">Spotify reports ${r.total} songs; all ${r.total} were retrieved.</p>` : ""}
      ${r.remote ? `<span class="muted">Completion is managed by the originating WASP.</span>` : miss ? `<span class="muted" style="font-size:13px">Waiting for ${miss} missing song${miss===1?'':'s'} before completion.</span>` :
        knownIncomplete ? `<span class="muted" style="font-size:13px">Cannot finish: complete Spotify song list unavailable.</span>` :
        unverifiedBoundary ? `<span class="muted">Review and finish with the Mark as done button above.</span>` :
        `<span class="muted">Use Mark as done above to complete.</span>`}</td></tr>` : (songReview||albumReview) ? `<tr class="reqdetail${open ? "" : " hidden"}" data-d="${esc(r.id)}"><td></td><td colspan="2">
      <p class="muted" style="margin:4px 0">${albumReview?'Find an album group in local music and connected HIVE peer snapshots. A confirmed candidate remains pending until you review the album and click Mark as done; one song never proves a complete album.':'Find the exact recording in local music and connected HIVE peers. Reject wrong versions; an accepted match completes only this song request.'}</p>
      ${albumReview&&r.confirmed_album?`<p class="muted" role="status">Confirmed album candidate: <b>${esc(r.confirmed_album.album)}</b> · ${esc(r.confirmed_album.origin||'Local')} · ${Number(r.confirmed_album.track_count)||0} catalogued track(s). Review completeness before Mark as done.</p>`:''}
      <div class="req-match-entry" data-req-index="0"><div class="req-miss-header"><span>${esc(r.title)}${r.artist?` <span class="muted">· ${esc(r.artist)}</span>`:''}</span><button type="button" class="btn ghost" data-a="match-scan" ${small}>Find potential match</button></div><div class="req-match-results"></div></div>
    </td></tr>` : ""}`;
  }).join("")}</tbody></table>` : "The queue is empty.";
}
async function requestMatchAction(id,action,index,extra={}){
  try{const response=await post(`/api/admin/requests/${encodeURIComponent(id)}/match`,{action,index,...extra});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Request match failed');
    openReq.add(id);await loadRequests();return result;
  }catch(e){flashMsg('#reqMsg',e.message,true);return null;}
}
async function requestMissingTrack(id,index){
  if(!Number.isSafeInteger(index)||index<0)return;
  if(!confirm('Create a separate song request for this missing playlist entry? The original playlist request stays unchanged.'))return;
  try{
    const res=await post(`/api/admin/requests/${encodeURIComponent(id)}/request-track`,{index});
    const data=await res.json();if(!res.ok)throw Error(data.error||'Could not create an individual song request.');
    openReq.add(id);flashMsg('#reqMsg',data.already_requested?`Individual request already exists for “${data.title}” · ${data.artist}.`:`Individual track requested: “${data.title}” · ${data.artist}.`);
    await loadRequests();
  }catch(e){flashMsg('#reqMsg',e.message,true);}
}
async function requestFindCandidates(entry,id,query=''){
  const index=Number(entry.dataset.reqIndex),pane=entry.querySelector('.req-match-results');
  if(index<0){pane.textContent='Refresh the request first to locate its original song index.';return;}
  pane.textContent='Searching local music and connected peer snapshots…';
  try{const res=await fetch(`/api/admin/requests/${encodeURIComponent(id)}/candidates?index=${index}&q=${encodeURIComponent(query)}`,{cache:'no-store'});const data=await res.json();if(!res.ok)throw Error(data.error||'Search unavailable');
    const scope=data.searched||{};
    const isAlbum=data.kind==='album';
    pane.innerHTML=`<p class="muted" style="margin:6px 0">Searching ${Number(scope.local)||0} local and ${Number(scope.peer)||0} connected HIVE peer tracks (synchronized snapshots).</p><div class="req-match-search"><input aria-label="Search ${isAlbum?'album':'song'} or artist in local and HIVE peer music" placeholder="Search local music and HIVE peers" value="${esc(query)}"><button type="button" class="btn ghost" data-a="match-query" ${small}>Search</button></div>`+
      (data.candidates.length?data.candidates.map(c=>`<div class="req-candidate" data-origin="${esc(c.origin)}" ${isAlbum?`data-candidate-album="${esc(c.album)}"`:`data-candidate-id="${esc(c.id)}"`}><button type="button" data-a="match-reject" class="req-reject" title="Reject this suggestion" aria-label="Reject ${esc(c.title)}">❌</button><button type="button" data-a="match-accept" class="req-accept" title="${isAlbum?'Confirm album candidate':'Confirm this match'}" aria-label="Confirm ${esc(c.title)}">✅</button><span>${esc(c.title)} <small>· ${esc(c.artist)}${!isAlbum&&c.album?' · '+esc(c.album):''}${isAlbum?' · '+Number(c.track_count)+' catalogued track(s)':''} · ${c.origin?'HIVE peer: '+esc(c.origin):'Local'} · ${c.score}% match</small></span></div>`).join(''):`<p class="muted">No possible matches. Try a different search term.</p>`);
  }catch(e){pane.textContent=e.message;}
}
$("#reqRows").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const tr = b.closest("tr"), id = tr.dataset.r || tr.dataset.d, act = b.dataset.a;
  const r = (window.__reqs || []).find((x) => x.id === id) || {};
  const entry=b.closest('[data-req-index]'),index=entry?Number(entry.dataset.reqIndex):-1;
  if(act==='match-request-track'){
    await requestMissingTrack(id,index);return;
  }
  if(act==='song-scan'||act==='album-scan'){
    openReq.add(id);const detail=document.querySelector(`tr[data-d="${CSS.escape(id)}"]`);detail?.classList.remove('hidden');
    const song=detail?.querySelector('.req-match-entry');if(song)await requestFindCandidates(song,id);return;
  }
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
    const isAlbum=r.kind==='album';
    const payload=isAlbum?{origin:candidate.dataset.origin,album:candidate.dataset.candidateAlbum}:{origin:candidate.dataset.origin,id:candidate.dataset.candidateId};
    const saved=await requestMatchAction(id,act==='match-accept'?'accept':'reject',index,payload);
    if(saved)flashMsg('#reqMsg',act==='match-accept'?(isAlbum?'Album candidate confirmed. Check that the album is complete before clicking Mark as done.':saved.status==='done'?'Song matched to the selected local or peer recording and moved to Previous requests.':'Match confirmed. Request counts updated.'):'Candidate rejected. Wrong versions will not automatically complete this request.');return;
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
    if(act==='review-done'&&!confirm(`Mark ${r.title} as done?${r.kind==='album'?' Verify the album is complete: a matching song or album title alone does not prove every track is available.':''}${r.remote?' This completes it on this WASP only; the origin retains ownership.':''}`))return;
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

// v18.2.2: credential-free collection assembly, resumable in D1.
let spotifyCollection=null,spotifyDraft=null,spotifyLookupResults=[],spotifyStagedFiles=[],spotifyFileTags=new Map(),spotifyChoice=new Map(),spotifyExistingChoice=new Map(),spotifyUnmatchedChoice=new Map();
let spotifyLookupSerial=0,spotifyLookupTimer=null;
const normalizedSong=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const songArtistOverlap=(names,other)=>{
  const a=(Array.isArray(names)?names:String(names||'').split(/[;]+/)).map(normalizedSong).filter(Boolean);
  const b=(Array.isArray(other)?other:String(other||'').split(/[;]+/)).map(normalizedSong).filter(Boolean);
  return a.some(x=>b.includes(x));
};
function spotifyCollectionStatus(message='',isError=false){const node=$('#spotifyCollectionStatus');node.textContent=message;node.classList.toggle('err',isError);}
function fileMatchChoices(){
  const used=new Set(),assignments=new Map();
  if(!spotifyCollection)return assignments;
  for(let i=0;i<spotifyCollection.tracks.length;i++){
    if(spotifyDraft?.matches?.[i])continue;
    const item=spotifyCollection.tracks[i];
    if(spotifyChoice.has(i)){
      const chosen=spotifyChoice.get(i);assignments.set(i,chosen);
      if(chosen>=0)used.add(chosen);
      continue;
    }
    let found=-1;
    for(let f=0;f<spotifyStagedFiles.length;f++){
      if(used.has(f))continue;
      const file=spotifyStagedFiles[f],tags=spotifyFileTags.get(file)||{};
      if(normalizedSong(item.title)===normalizedSong(tags.title||file.name.replace(/\.mp3$/i,''))&&songArtistOverlap(item.artists,tags.artists?.length?tags.artists:tags.artist)){found=f;break;}
    }
    if(found>=0)used.add(found);
    assignments.set(i,found);
  }
  return assignments;
}
const recreateCandidateRows=new Map();
function paintSpotifyManifest(){
 const place=$('#spotifyCollectionManifest');if(!spotifyCollection||!spotifyDraft){place.innerHTML='';return;}
 const rows=spotifyCollection.tracks||[],matches=spotifyDraft.matches||{},found=Object.keys(matches).length;
 $('#spotifyDraftState').textContent=`${spotifyDraft.status==='complete'?'Complete':'Pending'} · ${found}/${rows.length} matched · ${rows.length-found} require review${spotifyCollection.complete?'':' · source listing may be partial'}`;
 $('#spotifyVerifySource').classList.toggle('hidden',spotifyDraft.status==='complete'||found!==rows.length||spotifyCollection.complete);
 place.innerHTML=rows.map((item,i)=>{
  const assigned=matches[i],badge=assigned?`<span class="recreate-source-badge">✓ ${String(assigned).startsWith('peer:')?'HIVE peer':'Local'} match</span>`:'';
  return `<div class="recreate-manifest-row${assigned?' is-matched':''}" data-recreate-slot="${i}">
    <div><b>${i+1}. ${esc(item.title)}</b><small class="muted">${esc((item.artists||[]).join(', ')||'Artist unknown')} · ${spotifyCollection.kind==='album'?'Track '+(item.track_no||i+1):'Playlist entry'}</small>${badge}</div>
    <div class="recreate-manifest-actions">${assigned?`<small class="muted">${esc(assigned)} · retained</small>`:`<input type="search" data-recreate-q="${i}" placeholder="Find existing local/HIVE song" aria-label="Search matches for ${esc(item.title)}"><button type="button" class="btn ghost" data-recreate-find="${i}">Find potential match</button><select data-recreate-choice="${i}" aria-label="Candidate match for ${esc(item.title)}"><option value="">Choose candidate</option></select><button class="btn ghost" type="button" data-recreate-approve="${i}">Confirm match</button><button class="btn ghost" type="button" data-source-action="request" data-source-index="${i}">Request individual track</button>`}
      <span class="muted" data-source-feedback="${i}" role="status"></span></div>
  </div>`;
 }).join('')||'<p class="muted">No source entries could be retrieved.</p>';
}
let recreationRunning=false;
async function refreshRecreationMatches(){
 if(recreationRunning||!spotifyDraft)return;
 recreationRunning=true;const btn=$('#recreateRefresh');btn.disabled=true;
 const id=spotifyDraft.id,total=spotifyCollection.tracks.length;
 try{
  for(let offset=0;offset<total;){
   if(!spotifyDraft||spotifyDraft.id!==id)break;
   $('#recreateProgress').textContent=`Matching ${offset}/${total} source entries against local and synced HIVE tracks…`;
   const r=await post('/api/admin/collection-drafts/'+id+'/automatch',{offset,limit:3});
   const data=await r.json();if(!r.ok)throw Error(data.error||'Unable to match entries');
   offset=data.next;spotifyDraft=data;paintSpotifyManifest();
  }
  $('#recreateProgress').textContent=`Finished: ${spotifyDraft?.matched||0} / ${total} matched; verify the remaining entries.`;
 }catch(e){$('#recreateProgress').textContent='Match scan paused: '+e.message+' — matching already saved. Use Refresh HIVE matches to resume.';}
 finally{recreationRunning=false;btn.disabled=false;void loadCollectionDraftHistory();}
}
$('#recreateRefresh').onclick=refreshRecreationMatches;
async function findRecreateCandidates(slot){
 const line=document.querySelector(`[data-recreate-slot="${slot}"]`),input=line?.querySelector(`[data-recreate-q="${slot}"]`),select=line?.querySelector(`[data-recreate-choice="${slot}"]`);
 if(!line||!select||!spotifyDraft)return;
 const msg=line.querySelector(`[data-source-feedback="${slot}"]`);msg.textContent='Searching local and HIVE catalogues…';
 try{const qs=new URLSearchParams({slot:String(slot),q:input?.value.trim()||''});
  const r=await fetch('/api/admin/collection-drafts/'+spotifyDraft.id+'/candidates?'+qs,{cache:'no-store'}),d=await r.json();
  if(!r.ok)throw Error(d.error||'Could not search');
  const hits=d.items||[];recreateCandidateRows.set(slot,hits);
  select.innerHTML='<option value="">Choose matching recording</option>'+hits.map((t,i)=>`<option value="${i}">${esc(t.title)} — ${esc(t.artist)} (${t.source==='peer'?'HIVE peer':'Local'}${t.origin?' · '+esc(t.origin):''})</option>`).join('');
  msg.textContent=hits.length?`${hits.length} candidate(s). Confirm only the correct recording.`:'No potential matches. Try different search terms or request this track.';
 }catch(e){msg.textContent=e.message;}
}
$('#spotifyCollectionManifest').addEventListener('click',async e=>{
 const find=e.target.closest('[data-recreate-find]');if(find){await findRecreateCandidates(Number(find.dataset.recreateFind));return;}
 const approve=e.target.closest('[data-recreate-approve]');if(!approve||!spotifyDraft)return;
 const slot=Number(approve.dataset.recreateApprove),line=approve.closest('.recreate-manifest-row'),select=line.querySelector('[data-recreate-choice]');
 const candidate=(recreateCandidateRows.get(slot)||[])[Number(select.value)];if(!select.value||!candidate){line.querySelector('[data-source-feedback]').textContent='Select a candidate first.';return;}
 if(!confirm(`Confirm “${candidate.title}” by ${candidate.artist} as “${spotifyCollection.tracks[slot].title}”? The audio file will not be copied or deleted.`))return;
 approve.disabled=true;
 try{const r=await post('/api/admin/collection-drafts/'+spotifyDraft.id+'/approve',{slot,origin:candidate.origin,id:candidate.id}),d=await r.json();if(!r.ok)throw Error(d.error||'Could not approve candidate');spotifyDraft=d;paintSpotifyManifest();void loadCollectionDraftHistory();}
 catch(err){line.querySelector('[data-source-feedback]').textContent=err.message;}finally{approve.disabled=false;}
});
async function loadCollectionDraft(data){
  $('#recreateKind').value=data.source.kind;
  spotifyDraft=data;spotifyCollection=data.source;spotifyChoice.clear();spotifyExistingChoice.clear();spotifyUnmatchedChoice.clear();

  $('#spotifyCollectionSelected').classList.remove('hidden');
  $('#spotifyCollectionSummary').innerHTML=`<strong>${esc(spotifyCollection.title)}</strong><small class="muted">${esc(spotifyCollection.artist||spotifyCollection.provider||'Catalogue')} · ${spotifyCollection.tracks.length} listed entries${spotifyCollection.complete?'':' (partial)'} · <a href="${esc(spotifyCollection.url)}" target="_blank" rel="noopener noreferrer">View source</a></small>`;
  spotifyCollectionStatus(spotifyCollection.warning||'Draft saved. Strict matches are automatic; ambiguous matches require review.',!!spotifyCollection.warning);
  paintSpotifyManifest();
}
async function spotifySearchCollection(){
  const kind=recreateKind(),q=$('#spotifyCollectionSearch').value.trim(),box=$('#spotifyCollectionResults'),seq=++spotifyLookupSerial;
  if(!['album','playlist'].includes(kind)||q.length<2){box.innerHTML='';return;}
  if(/^https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:album|playlist)\/[A-Za-z0-9]{10,40}/.test(q)&&q.includes('/'+kind+'/')){
    spotifyLookupResults=[{kind,provider:'spotify-public-embed',url:q,title:'Use this public Spotify '+kind,artist:'From the same public link reader used by WASP users'}];
    box.innerHTML=`<button type="button" class="spotify-result" data-spotify-index="0"><span><b>Use this Spotify ${esc(kind)}</b><small class="muted">Read its public track list without credentials (may be partial)</small></span></button>`;
    $('#spotifyCollectionSearch').setAttribute('aria-expanded','true');return;
  }
  if(q.length>100){spotifyCollectionStatus('Search using a name up to 100 characters, or a public Spotify playlist link.',true);return;}
  box.textContent='Searching public music catalogue…';spotifyCollectionStatus();
  try{
    const response=await fetch('/api/admin/collection-guide/search?'+new URLSearchParams({type:kind,q}),{cache:'no-store'});
    const data=await response.json();if(seq!==spotifyLookupSerial)return;
    if(!response.ok)throw Error(data.error||'Catalogue search failed');
    spotifyLookupResults=data.items||[];
    box.innerHTML=spotifyLookupResults.length?spotifyLookupResults.map((r,i)=>`<button type="button" class="spotify-result" role="option" data-spotify-index="${i}"><span class="spotify-result-art">${r.image?`<img src="${esc(r.image)}" alt="">`:''}</span><span><b>${esc(r.title)}</b><small class="muted">${esc(r.artist||'')} · ${r.total?'~'+r.total+' tracks · ':''}Public album/playlist catalogue</small></span></button>`).join(''):'<p class="muted">No matches. Try a different name or paste a Spotify playlist link.</p>';
    $('#spotifyCollectionSearch').setAttribute('aria-expanded',String(!!spotifyLookupResults.length));
  }catch(error){if(seq!==spotifyLookupSerial)return;box.textContent='';spotifyCollectionStatus(error.message,true);}
}
$('#spotifyCollectionSearchButton').onclick=spotifySearchCollection;
$('#spotifyCollectionSearch').addEventListener('input',()=>{clearTimeout(spotifyLookupTimer);spotifyLookupTimer=setTimeout(spotifySearchCollection,280);});
$('#spotifyCollectionSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();clearTimeout(spotifyLookupTimer);spotifySearchCollection();}if(e.key==='Escape'){$('#spotifyCollectionResults').innerHTML='';e.target.setAttribute('aria-expanded','false');}});
$('#spotifyCollectionResults').onclick=async e=>{
  const button=e.target.closest('[data-spotify-index]');if(!button)return;
  const selected=spotifyLookupResults[Number(button.dataset.spotifyIndex)];if(!selected)return;
  button.disabled=true;spotifyCollectionStatus('Creating a reviewable collection draft…');
  try{
    let b={kind:recreateKind(),id:selected.id||'',url:selected.provider==='spotify-public-embed'?selected.url:''};
    let response=await post('/api/admin/collection-drafts',b),data=await response.json();
    if(response.status===409&&data.code==='playlist_exists'&&confirm('A playlist with this name already exists. Reuse that playlist for this draft?')){
      response=await post('/api/admin/collection-drafts',{...b,reuse_existing:true});data=await response.json();
    }
    if(!response.ok)throw Error(data.error||'Cannot create collection draft');
    await loadCollectionDraft(data);void refreshRecreationMatches();$('#spotifyCollectionResults').innerHTML='';$('#spotifyCollectionSearch').setAttribute('aria-expanded','false');
  }catch(error){spotifyCollectionStatus(error.message,true);}finally{button.disabled=false;}
};
async function loadCollectionDraftHistory(){
  const el=$('#spotifyDraftHistory');el.textContent='Loading saved collections…';
  try{
    const r=await fetch('/api/admin/collection-drafts',{cache:'no-store'}),data=await r.json();if(!r.ok)throw Error(data.error||'Cannot load drafts');
    el.innerHTML=data.items?.length?data.items.map(d=>`<div class="spotify-draft-history-row"><span><b>${esc(d.title)}</b><small class="muted"> ${esc(d.kind)} · ${d.matched}/${d.source.tracks.length} matched · ${esc(d.status)}</small></span><div class="form"><button type="button" class="btn ghost" data-reopen-draft="${esc(d.id)}">Resume</button><button type="button" class="btn ghost" data-done-draft="${esc(d.id)}">Done</button></div></div>`).join(''):'<p class="muted">No pending drafts. Finished collections and their songs remain available.</p>';
  }catch(e){el.textContent=e.message;}
}
$('#spotifyDraftHistoryWrap').addEventListener('toggle',e=>{if(e.target.open)loadCollectionDraftHistory();});
$('#spotifyDraftHistoryRefresh').onclick=loadCollectionDraftHistory;
$('#spotifyDraftHistory').addEventListener('click',async e=>{
 const done=e.target.closest('[data-done-draft]');if(done){
  if(!confirm('Mark this assembly as done anyway, even if incomplete? It disappears from Pending drafts but preserves its matched music/playlist. You can search and recreate the same source later.'))return;
  done.disabled=true;try{const r=await post('/api/admin/collection-drafts/'+done.dataset.doneDraft+'/done',{}),d=await r.json();if(!r.ok)throw Error(d.error||'Could not complete draft');if(spotifyDraft?.id===done.dataset.doneDraft)$('#spotifyCollectionClear').click();await loadCollectionDraftHistory();}catch(e){spotifyCollectionStatus(e.message,true);done.disabled=false;}return;
 }
 const b=e.target.closest('[data-reopen-draft]');if(!b)return;
  b.disabled=true;try{const r=await fetch('/api/admin/collection-drafts/'+encodeURIComponent(b.dataset.reopenDraft)),d=await r.json();if(!r.ok)throw Error(d.error||'Cannot reopen');await loadCollectionDraft(d);}catch(err){spotifyCollectionStatus(err.message,true);}finally{b.disabled=false;}
});
async function loadSpotifyAttachHistory(){
  const box=$('#spotifyAttachmentHistory');if(!box)return;
  box.textContent='Loading attachment history…';
  try{
    const r=await fetch('/api/admin/collection-attach/history',{cache:'no-store'});
    const data=await r.json();if(!r.ok)throw Error(data.error||'Could not load attachment history');
    const rows=data.items||[];
    box.innerHTML=rows.length?rows.map(entry=>{
      const t=(window.__tracks||[]).find(track=>track.id===entry.track_id);
      return `<div class="spotify-attach-entry" data-attach-history="${esc(entry.id)}"><div><b>${esc(t?.title||entry.track_id)}</b><small class="muted">${esc(entry.old_album||'(no album)')} → ${esc(entry.new_album)} · ${new Date(Number(entry.at)||0).toLocaleString()}</small></div><button type="button" class="btn ghost" data-attach-undo="${esc(entry.id)}">Undo</button></div>`;
    }).join(''):'<p class="muted">No album attachments to undo.</p>';
  }catch(e){box.textContent=e.message;}
}
$('#spotifyAttachmentHistoryWrap').addEventListener('toggle',event=>{if(event.target.open)loadSpotifyAttachHistory();});
$('#spotifyAttachmentHistoryRefresh').onclick=loadSpotifyAttachHistory;
$('#spotifyAttachmentHistory').addEventListener('click',async event=>{
  const btn=event.target.closest('[data-attach-undo]');if(!btn)return;
  if(!confirm('Restore this track\'s previous album and track number? The MP3 file is not changed.'))return;
  btn.disabled=true;
  try{const r=await post('/api/admin/collection-attach/'+encodeURIComponent(btn.dataset.attachUndo)+'/undo',{});
    const data=await r.json();if(!r.ok)throw Error(data.error||'Undo failed');
    await refresh();await loadSpotifyAttachHistory();
  }catch(e){alert(e.message);btn.disabled=false;}
});
$('#spotifyCollectionClear').onclick=()=>{spotifyCollection=null;spotifyDraft=null;spotifyChoice.clear();spotifyExistingChoice.clear();
  $('#spotifyCollectionSelected').classList.add('hidden');$('#spotifyCollectionResults').innerHTML='';spotifyCollectionStatus('Draft closed; it remains saved and can be resumed from Pending assemblies.');};
async function stageSpotifyFiles(files){
  spotifyStagedFiles=[...files].filter(file=>/\.mp3$/i.test(file.name));
  const state=$('#spotifyCollectionStatus');state.textContent=`Reading metadata from ${spotifyStagedFiles.length} selected MP3s…`;
  for(let i=0;i<spotifyStagedFiles.length;i++){
    const file=spotifyStagedFiles[i];if(!spotifyFileTags.has(file))spotifyFileTags.set(file,await readTags(file));
    state.textContent=`Read ${i+1} of ${spotifyStagedFiles.length} MP3 tags locally…`;
  }
  spotifyChoice.clear();spotifyUnmatchedChoice.clear();paintSpotifyManifest();spotifyCollectionStatus(`${spotifyStagedFiles.length} MP3s selected for reviewed matching. Audio has not been uploaded.`);
}
$('#spotifyCollectionManifest').addEventListener('input',e=>{
  if(!e.target.matches('[data-source-find]'))return;
  const index=Number(e.target.dataset.sourceFind),line=e.target.closest('[data-source-index]');
  const select=line?.querySelector('[data-source-track]'),q=normalizedSong(e.target.value);
  if(!select)return;
  const matched=(window.__tracks||[]).filter(t=>!q||normalizedSong(t.title+' '+artistLine(t)+' '+albumName(t)).includes(q)).slice(0,30);
  const selected=spotifyExistingChoice.get(index)||'';
  select.innerHTML='<option value="">Choose existing track</option>'+matched.map(t=>`<option value="${esc(t.id)}"${t.id===selected?' selected':''}>${esc(t.title)} — ${esc(artistLine(t))}</option>`).join('');
});
$('#spotifyCollectionManifest').addEventListener('change',e=>{
  if(e.target.matches('[data-source-file]')){const index=Number(e.target.dataset.sourceFile);spotifyChoice.set(index,Number(e.target.value));paintSpotifyManifest();}
  if(e.target.matches('[data-source-track]')){const index=Number(e.target.dataset.sourceTrack);spotifyExistingChoice.set(index,e.target.value);paintSpotifyManifest();}
});
$('#spotifyUnmatchedFiles').addEventListener('change',e=>{if(e.target.matches('[data-unmatched-decision]'))spotifyUnmatchedChoice.set(Number(e.target.dataset.unmatchedDecision),e.target.value);});
$('#spotifyCollectionManifest').addEventListener('click',async e=>{
 const btn=e.target.closest('[data-source-action="request"]');if(!btn||!spotifyCollection||!spotifyDraft)return;
 const index=Number(btn.dataset.sourceIndex),item=spotifyCollection.tracks[index];if(!item)return;
 if(!confirm(`Create a separate song request for “${item.title}” by ${(item.artists||[]).join(', ')}?`))return;
 btn.disabled=true;
 try{const r=await post('/api/admin/collection-request-song',{title:item.title,artist:item.artists?.join(', ')||'Unknown Artist'}),d=await r.json();if(!r.ok)throw Error(d.error||'Could not request track');
  const feedback=document.querySelector(`[data-source-feedback="${index}"]`);if(feedback)feedback.textContent=d.already_requested?'Track already requested.':'Individual track request created.';
 }catch(error){spotifyCollectionStatus(error.message,true);}finally{btn.disabled=false;}
});
$('#spotifyVerifySource').onclick=async()=>{
  if(!spotifyDraft||spotifyDraft.remaining)return;
  const confirmed=prompt('The source was marked PARTIAL. Confirm you personally verified all entries of this album or playlist. Type complete to finish it.');
  if(confirmed!=='complete')return;
  try{const r=await post('/api/admin/collection-drafts/'+spotifyDraft.id+'/verify',{confirm:'complete'}),d=await r.json();if(!r.ok)throw Error(d.error||'Cannot verify collection');spotifyDraft=d;paintSpotifyManifest();spotifyCollectionStatus('Collection manually verified complete. Audio and matched entries remain unchanged.');}
  catch(e){spotifyCollectionStatus(e.message,true);}
};
$('#spotifyUploadMatched').onclick=async()=>{
  if(!spotifyCollection||!spotifyDraft||!spotifyStagedFiles.length)return;
  const selected=new Map(),assignments=fileMatchChoices();
  for(let i=0;i<spotifyCollection.tracks.length;i++){
    if(spotifyDraft.matches?.[i])continue;
    const n=assignments.get(i)??-1;
    if(n>=0){if(selected.has(n)){spotifyCollectionStatus('One MP3 is assigned to multiple entries. Correct the assignments before uploading.',true);return;}
      selected.set(n,{...spotifyCollection.tracks[i],slot:i});}
  }
  const separate=new Set();
  spotifyStagedFiles.forEach((f,i)=>{if(!selected.has(i)&&spotifyUnmatchedChoice.get(i)==='separate')separate.add(f);});
  if(!selected.size&&!separate.size){spotifyCollectionStatus('Assign MP3s to source entries or choose Keep as separate song for unmatched files.',true);return;}
  const files=[...selected.keys()].map(i=>spotifyStagedFiles[i]).concat([...separate]);
  if(!confirm(`Upload ${files.length} approved MP3(s): ${selected.size} assigned to “${spotifyCollection.title}” and ${separate.size} kept separate? Excluded files will not be uploaded. The collection remains pending while entries are missing.`))return;
  const assigned=new Map([...selected].map(([index,entry])=>[spotifyStagedFiles[index],entry]));
  await enqueue(files,assigned,separate);
  spotifyCollectionStatus(`${files.length} MP3s queued for approved upload. Follow progress below. Missing entries remain in the saved draft.`);
};

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

async function enqueue(fileList,assignedTracks=null,separateFiles=null) {
  const m = mode(), msg = $("#upMsg");
  msg.textContent = "";
  let pid = null;
  if (m === "playlist" && assignedTracks && spotifyDraft?.playlist_id) {
    pid=spotifyDraft.playlist_id;
  } else if (m === "playlist") {
    const name = $("#plName").value.trim();
    if (!name) { msg.textContent = "Enter a playlist name first."; return; }
    const r = await post("/api/admin/playlists", { name });
    if (!r.ok) { msg.textContent = (await r.json()).error; return; }
    pid = (await r.json()).id;
  }
  const ctx = { m, pid, album: $("#alName").value.trim(), artist: $("#alArtist").value.trim(), assignedTracks,
    separateFiles, draftId:assignedTracks?spotifyDraft?.id:null };
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
  if(spotifyDraft?.id){
    try{const r=await fetch('/api/admin/collection-drafts/'+spotifyDraft.id);if(r.ok){spotifyDraft=await r.json();paintSpotifyManifest();}}
    catch{}
  }
}
async function processOne({ file, ctx, n }) {
  let { m, pid } = ctx;
  if(ctx.separateFiles?.has(file)){m='singles';pid=null;}
  stat.cur = file.name; stat.frac = 0; paintBatch();
  const item = document.createElement("div");
  item.style.margin = "10px 0";
  item.innerHTML = `<div>${esc(file.name)} <span class="muted">reading…</span></div><div class="bar"><i></i></div>`;
  $("#queue").prepend(item);
  const status = item.querySelector("span"), bar = item.querySelector("i");
  if (!/\.mp3$/i.test(file.name)) { status.textContent = "Skipped: only .mp3 files"; stat.fail++; return; }
  try {
    const tags = spotifyFileTags.get(file) || await readTags(file);
    const source=ctx.assignedTracks?.get(file);
    const confirmSourceTrack=async trackId=>{
      if(!ctx.draftId||!source||!Number.isInteger(source.slot))return;
      const result=await post('/api/admin/collection-drafts/'+ctx.draftId+'/assign',{slot:source.slot,track_id:trackId});
      const data=await result.json();if(!result.ok)throw Error(data.error||'Audio uploaded but collection assignment failed. Resume the draft to finish matching.');
      if(spotifyDraft?.id===ctx.draftId){spotifyDraft=data;paintSpotifyManifest();}
    };
    if(source){
      // Manual association to the Spotify entry is already confirmed by the admin.
      // Preserve contributors from the MP3 unless metadata is absent.
      if(!tags.title)tags.title=source.title;
      if(!tags.artist&&source.artists?.length){tags.artist=source.artists.join(', ');tags.artists=source.artists;}
      if(m==='album'){tags.album=ctx.album;if(source.track_no)tags.track=String(source.track_no);}
    }
    const hash = await sha(file);
    const found = (await (await post("/api/admin/check", { hash })).json()).id;
    if (found) { // already stored: never upload twice, but still add to the playlist
      if (pid) {const attached=await post(`/api/admin/playlists/${pid}/tracks`,{track_id:found});if(!attached.ok)throw Error('Could not add existing track to playlist');status.textContent = "Already in the library — added to the playlist"; }
      else if(m==='album'&&ctx.album){const attached=await post('/api/admin/collection-attach',{kind:'album',track_id:found,album:ctx.album,track_no:Number(source?.track_no)||n});const data=await attached.json();if(!attached.ok)throw Error(data.error||'Could not attach duplicate to album');status.textContent='Already in the library — attached to chosen album; audio unchanged';}
      else status.textContent = "Already in the library — skipped";
      await confirmSourceTrack(found);
      bar.style.width = "100%"; stat.dup++; return;
    }
    if (m === "album") { if (ctx.album) tags.album = ctx.album; if (ctx.artist) tags.artist = ctx.artist; if (!tags.track) tags.track = String(n); }
    status.textContent = `${(tags.artist || "Unknown Artist").replace(/;/g, ", ")} · ${tags.album || "Single"}`;
    const t = await send(file, tags, hash, pid, (p) => { bar.style.width = p * 100 + "%"; stat.frac = p; paintBatch(); });
    bar.style.width = "100%";
    if (tags.cover) await fetch(`/api/admin/tracks/${t.id}/cover`, { method: "PUT", headers: { "content-type": tags.cover.type }, body: tags.cover });
    await confirmSourceTrack(t.id);
    await warm([t], undefined, true); // fetch artwork and biographies now so listeners see them right away
    status.textContent += pid ? " — uploaded and added to the playlist" : source ? " — uploaded and assigned to source entry" : " — uploaded";
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
$("#files").addEventListener("change",async (e)=>{const files=[...e.target.files];e.target.value='';enqueue(files);});
["dragenter", "dragover"].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop",async e=>{enqueue(e.dataTransfer.files);});

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
  const updates=which==='release-updates',rss=which==='rss';
  $('#settingsGeneralPanel').classList.toggle('hidden',updates||rss);
  $('#settingsUpdatesPanel').classList.toggle('hidden',!updates);
  $('#settingsRSSPanel').classList.toggle('hidden',!rss);
  $('#settingsTabGeneral').setAttribute('aria-selected',String(!updates&&!rss));
  $('#settingsTabUpdates').setAttribute('aria-selected',String(updates));
  $('#settingsTabRSS').setAttribute('aria-selected',String(rss));
  if(updates && (!lastReleaseCheck || selectedReleaseChannel()===savedReleaseChannel))void checkReleases();
  if(rss&&!rssLoaded)void loadRSSAdmin();
}
$('#settingsTabGeneral').onclick=()=>{location.hash='settings';showSettingsSubtab('general');};
$('#settingsTabUpdates').onclick=()=>{location.hash='settings/release-updates';showSettingsSubtab('release-updates');};
$('#settingsTabRSS').onclick=()=>{location.hash='settings/rss';showSettingsSubtab('rss');};
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

// -------- v18.3 RSS settings and safe previews --------
let rssLoaded=false,rssDraft={enabled:false,position:'left',heading:'',show_titles:true,tabs:[]},rssIndex=0,rssPreviewSeq=0;
const rssEscape=esc;
async function loadRSSAdmin(){
 try{const r=await fetch('/api/admin/rss',{cache:'no-store'}),d=await r.json();if(!r.ok)throw Error(d.error||'Unable to load RSS');
  rssDraft={enabled:!!d.enabled,position:d.position||'left',heading:d.heading||'',show_titles:d.show_titles!==false,tabs:d.tabs||[]};rssLoaded=true;rssIndex=0;paintRSSAdmin();void loadRSSPreview();
 }catch(e){$('#rssSaveMsg').textContent=e.message;}
}
function rssPreviewIcon(url){try{const u=new URL(String(url||''));return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}}
function rssTabLabel(t,i,active=false){
 const show=rssDraft.show_titles!==false,title=rssEscape(t.title||'RSS Tab '+(i+1)),icon=rssPreviewIcon(t.icon_url)||'/wasp-icon.png';
 return `<button type="button" class="rss-tab-button${show?'':' rss-icon-only'}" data-rss-focus="${i}" data-title="${title}" title="${title}" aria-label="${title}" aria-selected="${active}">${!show||rssPreviewIcon(t.icon_url)?`<img class="rss-tab-icon" src="${rssEscape(icon)}" alt="" referrerpolicy="no-referrer">`:''}${show?`<span>${title}</span>`:''}</button>`;
}
function rssTabPreview(){return `<div class="rss-tab-bar" data-position="${rssDraft.position}">${rssDraft.tabs.map((t,i)=>rssTabLabel(t,i,i===rssIndex)).join('')}</div>`;}

function paintRSSAdmin(){
 $('#rssEnabled').checked=rssDraft.enabled;
 $('#rssShowTitles').checked=rssDraft.show_titles!==false;
 $('#rssHeading').value=rssDraft.heading||'';
 $('#rssEnabledStatus').textContent=rssDraft.enabled?'ON (pending Save)':'OFF — saved feeds retained';
 document.querySelectorAll('[data-rss-position]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.rssPosition===rssDraft.position)));
 $('#rssLayoutPreview').innerHTML=(rssDraft.heading?`<h3 class="rss-custom-heading">${rssEscape(rssDraft.heading)}</h3>`:'')+rssTabPreview()+`<p class="muted">${rssDraft.enabled?'RSS will appear below Playlists when saved.':'RSS is currently disabled; preview remains available to admins.'}</p>`;
 $('#rssTabsEditor').innerHTML=rssDraft.tabs.map((t,i)=>`<div class="rss-admin-tab${rssIndex===i?' is-selected':''}" data-rss-tab="${i}">
   <div class="rss-admin-tab-head"><span class="rss-drag-handle" role="button" tabindex="0" draggable="true" data-rss-drag="${i}" title="Drag to reorder RSS tab" aria-label="Drag ${rssEscape(t.title||'RSS Tab')} to reorder">⠿</span><button type="button" class="btn ghost" data-rss-focus="${i}">${rssEscape(t.title||'RSS Tab '+(i+1))}</button><button type="button" class="rss-small-move" data-rss-move="${i}" data-rss-direction="-1" title="Move up" aria-label="Move ${rssEscape(t.title)} up" ${i===0?'disabled':''}>↑</button><button type="button" class="rss-small-move" data-rss-move="${i}" data-rss-direction="1" title="Move down" aria-label="Move ${rssEscape(t.title)} down" ${i===rssDraft.tabs.length-1?'disabled':''}>↓</button><button type="button" class="btn ghost" data-rss-delete="${i}" title="Remove this saved RSS tab">Remove</button></div>
   ${rssIndex===i?`<label>Title</label><input data-rss-title="${i}" maxlength="70" value="${rssEscape(t.title)}"><label>Public HTTPS feed URL or static embed code</label><textarea class="rss-feed-code" data-rss-code="${i}" rows="1" maxlength="12000" placeholder="https://example.org/rss.xml">${rssEscape(t.code)}</textarea><label>Optional icon image URL (public HTTPS)</label><input data-rss-icon="${i}" type="url" maxlength="1600" value="${rssEscape(t.icon_url||'')}" placeholder="https://example.com/icon.png"><p class="muted" style="font-size:12px">When titles are hidden, WASP uses its own icon unless you provide one here.</p><button class="btn ghost" type="button" data-rss-expand="${i}">Expand editor</button>`:''}</div>`).join('');
 $('#rssContentTitle').textContent='Content preview — '+(rssDraft.tabs[rssIndex]?.title||'Select a tab');
 const t=rssDraft.tabs[rssIndex];$('#rssContentPreview').textContent=t?(t.kind==='embed'?'Static embed preview — scripts are disabled.':'Enter or paste a feed URL to preview current items.'):'Add a tab to preview its content.';
}
$('#rssEnabled').onchange=e=>{rssDraft.enabled=e.target.checked;paintRSSAdmin();};
$('#rssShowTitles').onchange=e=>{rssDraft.show_titles=e.target.checked;paintRSSAdmin();};
$('#rssHeading').oninput=e=>{rssDraft.heading=e.target.value;$('#rssLayoutPreview').innerHTML=(rssDraft.heading?`<h3 class="rss-custom-heading">${rssEscape(rssDraft.heading)}</h3>`:'')+rssTabPreview();};
$('#rssPositionControls').onclick=e=>{const b=e.target.closest('[data-rss-position]');if(!b)return;rssDraft.position=b.dataset.rssPosition;paintRSSAdmin();};
function rssFocus(i){rssIndex=i;paintRSSAdmin();void loadRSSPreview();}
$('#settingsRSSPanel').addEventListener('click',e=>{
 const focus=e.target.closest('[data-rss-focus]'),remove=e.target.closest('[data-rss-delete]'),expand=e.target.closest('[data-rss-expand]'),move=e.target.closest('[data-rss-move]');
 if(move){rssMove(Number(move.dataset.rssMove),Number(move.dataset.rssDirection));return;}
 if(focus){rssFocus(Number(focus.dataset.rssFocus));return;}
 if(remove){if(!confirm('Remove this RSS tab? This action is saved only after Save changes.'))return;rssDraft.tabs.splice(Number(remove.dataset.rssDelete),1);rssIndex=Math.max(0,Math.min(rssIndex,rssDraft.tabs.length-1));paintRSSAdmin();return;}
 if(expand){const textarea=document.querySelector(`[data-rss-code="${expand.dataset.rssExpand}"]`);if(textarea){textarea.classList.toggle('rss-expanded');textarea.rows=textarea.classList.contains('rss-expanded')?17:1;textarea.focus();}}
});
let rssPreviewDelay;
$('#rssTabsEditor').addEventListener('input',e=>{
 if(e.target.matches('[data-rss-title]')){rssDraft.tabs[Number(e.target.dataset.rssTitle)].title=e.target.value;$('#rssLayoutPreview').innerHTML=(rssDraft.heading?`<h3 class="rss-custom-heading">${rssEscape(rssDraft.heading)}</h3>`:'')+rssTabPreview();$('#rssContentTitle').textContent='Content preview — '+e.target.value;}
 if(e.target.matches('[data-rss-code]')){const t=rssDraft.tabs[Number(e.target.dataset.rssCode)];t.code=e.target.value;t.kind=t.code.trim().startsWith('<')?'embed':'feed';clearTimeout(rssPreviewDelay);rssPreviewDelay=setTimeout(loadRSSPreview,650);}
 if(e.target.matches('[data-rss-icon]')){rssDraft.tabs[Number(e.target.dataset.rssIcon)].icon_url=e.target.value;$('#rssLayoutPreview').innerHTML=(rssDraft.heading?`<h3 class="rss-custom-heading">${rssEscape(rssDraft.heading)}</h3>`:'')+rssTabPreview();}
});
let rssDragFrom=-1;
function rssMove(from,step){const to=from+step;if(from<0||to<0||to>=rssDraft.tabs.length)return;const selected=rssDraft.tabs[rssIndex];const [item]=rssDraft.tabs.splice(from,1);rssDraft.tabs.splice(to,0,item);rssIndex=rssDraft.tabs.indexOf(selected);paintRSSAdmin();}
$('#rssTabsEditor').addEventListener('dragstart',e=>{const handle=e.target.closest('[data-rss-drag]');if(!handle)return;rssPointerStart=null;rssDragFrom=Number(handle.dataset.rssDrag);e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(rssDragFrom));});
$('#rssTabsEditor').addEventListener('dragover',e=>{const row=e.target.closest('[data-rss-tab]');if(row&&rssDragFrom>=0){e.preventDefault();e.dataTransfer.dropEffect='move';row.classList.add('drag-over');}});
$('#rssTabsEditor').addEventListener('dragleave',e=>{const row=e.target.closest('[data-rss-tab]');if(row&&!row.contains(e.relatedTarget))row.classList.remove('drag-over');});
$('#rssTabsEditor').addEventListener('drop',e=>{const row=e.target.closest('[data-rss-tab]');if(!row||rssDragFrom<0)return;e.preventDefault();rssPointerStart=null;const from=rssDragFrom,to=Number(row.dataset.rssTab);rssDragFrom=-1;if(from===to){paintRSSAdmin();return;}const selected=rssDraft.tabs[rssIndex];const [item]=rssDraft.tabs.splice(from,1);rssDraft.tabs.splice(to,0,item);rssIndex=rssDraft.tabs.indexOf(selected);paintRSSAdmin();});
$('#rssTabsEditor').addEventListener('dragend',()=>{rssDragFrom=-1;document.querySelectorAll('.rss-admin-tab.drag-over').forEach(el=>el.classList.remove('drag-over'));});
// Pointer fallback for touchscreens and browsers that suppress native drag events.
let rssPointerStart=null;
$('#rssTabsEditor').addEventListener('pointerdown',e=>{const handle=e.target.closest('[data-rss-drag]');if(!handle)return;rssPointerStart={index:Number(handle.dataset.rssDrag),x:e.clientX,y:e.clientY};});
document.addEventListener('pointerup',e=>{
 if(!rssPointerStart)return;
 const start=rssPointerStart;rssPointerStart=null;
 if(Math.abs(e.clientX-start.x)+Math.abs(e.clientY-start.y)<12)return;
 const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-rss-tab]');
 if(!target)return;
 const selected=rssDraft.tabs[rssIndex],to=Number(target.dataset.rssTab);
 if(start.index===to||start.index<0||to<0||to>=rssDraft.tabs.length)return;
 const [item]=rssDraft.tabs.splice(start.index,1);rssDraft.tabs.splice(to,0,item);rssIndex=rssDraft.tabs.indexOf(selected);paintRSSAdmin();
});
document.addEventListener('pointercancel',()=>{rssPointerStart=null;});


$('#rssAddTab').onclick=()=>{rssDraft.tabs.push({id:'',title:'RSS Tab '+(rssDraft.tabs.length+1),code:'',kind:'feed',icon_url:''});rssFocus(rssDraft.tabs.length-1);};
$('#rssReset').onclick=()=>loadRSSAdmin();
$('#rssSave').onclick=async()=>{
 const button=$('#rssSave');button.disabled=true;$('#rssSaveMsg').textContent='Saving RSS settings…';
 try{const r=await post('/api/admin/rss',rssDraft,'PUT'),d=await r.json();if(!r.ok)throw Error(d.error||'Unable to save RSS');rssDraft=d;rssLoaded=true;paintRSSAdmin();$('#rssSaveMsg').textContent='Saved. '+(rssDraft.enabled?'RSS is visible below Playlists.':'RSS is OFF; saved entries are preserved.');}
 catch(e){$('#rssSaveMsg').textContent=e.message;}finally{button.disabled=false;}
};
function rssPreviewImage(value){try{const u=new URL(String(value||''));return u.protocol==='https:'?u.href:'';}catch{return '';}}
function paintRSSPreviewItems(node,items){
 node.innerHTML=items.length?`<div class="rss-feed-grid">${items.map(item=>{
   const image=rssPreviewImage(item.image),href=rssPreviewImage(item.url);
   return `<article class="rss-feed-item"><div class="rss-feed-media">${image?`<img src="${rssEscape(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:'<span aria-hidden="true">◉</span>'}</div><div class="rss-feed-info">${href?`<a href="${rssEscape(href)}" target="_blank" rel="noopener noreferrer nofollow">${rssEscape(item.title)}</a>`:`<b>${rssEscape(item.title)}</b>`}<p class="muted">${rssEscape(item.description||'')}</p></div></article>`;
  }).join('')}</div>`:'<p class="muted">No items returned from feed.</p>';
}
$('#rssForceRefresh').onclick=async()=>{
 const t=rssDraft.tabs[rssIndex],msg=$('#rssRefreshMsg'),button=$('#rssForceRefresh');
 if(!t?.id){msg.textContent='Save this tab first, then refresh its published feed.';return;}
 button.disabled=true;++rssPreviewSeq;msg.textContent='Checking the published feed…';
 try{
   const r=await post('/api/admin/rss/refresh',{id:t.id}),d=await r.json();
   if(!r.ok)throw Error(d.error||'Unable to refresh feed');
   msg.textContent=d.refresh_throttled?'Recently refreshed; showing the latest cached copy.':'Published feed refreshed. Reload Home to see these articles.';
   if(t.code.trim()===String(rssDraft.tabs[rssIndex]?.code||'').trim())paintRSSPreviewItems($('#rssContentPreview'),d.items||[]);
 }catch(e){msg.textContent=e.message;}finally{button.disabled=false;}
};
async function loadRSSPreview(){
 const t=rssDraft.tabs[rssIndex],node=$('#rssContentPreview'),serial=++rssPreviewSeq;if(!t)return;
 if(t.code.trim().startsWith('<')){
  node.textContent='Static embed (sandboxed, no JavaScript).';
  if(/<script\b|on\w+\s*=|javascript\s*:/i.test(t.code)){node.textContent='Active scripts are not permitted in RSS embeds.';return;}
  const iframe=document.createElement('iframe');iframe.className='rss-embed-preview';iframe.setAttribute('sandbox','');iframe.setAttribute('referrerpolicy','no-referrer');iframe.srcdoc=t.code;node.replaceChildren(iframe);return;
 }
 if(!/^https:\/\//i.test(t.code.trim())){node.textContent='Enter a public HTTPS RSS or Atom URL.';return;}
 node.textContent='Loading feed preview…';
 try{const r=await post('/api/admin/rss/preview',{title:t.title,code:t.code}),d=await r.json();if(serial!==rssPreviewSeq)return;if(!r.ok)throw Error(d.error||'Preview unavailable');
  paintRSSPreviewItems(node,d.items||[]);
 }catch(e){if(serial===rssPreviewSeq)node.textContent='Preview unavailable: '+e.message;}
}
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

// ---------- danger: local artist and song delists ----------
let delistsBusy=false;
function showDangerTab(name='delists'){
  const delists=name!=='clean';
  $('#dangerDelistsPanel').classList.toggle('hidden',!delists);
  $('#dangerCleanPanel').classList.toggle('hidden',delists);
  $('#dangerTabDelists').setAttribute('aria-selected',String(delists));
  $('#dangerTabClean').setAttribute('aria-selected',String(!delists));
  if(delists)void loadDelists();
}
$('#dangerTabDelists').onclick=()=>{location.hash='danger/delists';showDangerTab('delists');};
$('#dangerTabClean').onclick=()=>{location.hash='danger/clean';showDangerTab('clean');};
const delistsType=$('#delistsType');
function paintDelistsType(){
 const song=delistsType.value==='song';$('#delistsTitleWrap').classList.toggle('hidden',!song);
 $('#delistsTitle').required=song;closeDelistSuggest('artist');closeDelistSuggest('song');
}
delistsType.addEventListener('change',paintDelistsType);
const delistSuggestConfig={artist:{input:$('#delistsArtist'),menu:$('#delistsArtistSuggestions')},song:{input:$('#delistsTitle'),menu:$('#delistsTitleSuggestions')}};
let delistSuggestTicket={artist:0,song:0};
let delistSuggestTimer={artist:0,song:0};
const suppressDelistFocus={artist:false,song:false};
function closeDelistSuggest(which){const c=delistSuggestConfig[which];c.menu.classList.add('hidden');c.menu.replaceChildren();c.input.setAttribute('aria-expanded','false');}
function showDelistSuggestions(which,items){
 const c=delistSuggestConfig[which];c.menu.replaceChildren();
 for(const item of items){
  const b=document.createElement('button');b.type='button';b.className='delist-suggestion';b.setAttribute('role','option');
  b.dataset.artist=item.artist||'';b.dataset.title=item.title||'';
  const main=document.createElement('strong');main.textContent=which==='artist'?item.artist:item.title;
  const meta=document.createElement('small');meta.textContent=which==='artist'?item.source||'Local / HIVE':`${item.artist||''}${item.album?' · '+item.album:''} · ${item.source||'HIVE'}`;
  b.append(main,meta);c.menu.appendChild(b);
 }
 c.menu.classList.toggle('hidden',items.length===0);c.input.setAttribute('aria-expanded',String(items.length>0));
}
async function updateDelistSuggestions(which){
 const ticket=++delistSuggestTicket[which],c=delistSuggestConfig[which],q=c.input.value.trim();
 if(q.length<2){closeDelistSuggest(which);return;}
 try{
  const u=new URL('/api/admin/delists/suggest',document.baseURI);u.searchParams.set('kind',which);u.searchParams.set('q',q);
  if(which==='song')u.searchParams.set('artist',$('#delistsArtist').value.trim());
  const r=await fetch(u,{cache:'no-store'});if(!r.ok)throw Error('Search unavailable');const d=await r.json();
  if(ticket!==delistSuggestTicket[which]||c.input.value.trim()!==q)return;
  showDelistSuggestions(which,Array.isArray(d.candidates)?d.candidates:[]);
 }catch{if(ticket===delistSuggestTicket[which])closeDelistSuggest(which);}
}
for(const which of ['artist','song']){
 const c=delistSuggestConfig[which];
 c.input.addEventListener('input',()=>{clearTimeout(delistSuggestTimer[which]);delistSuggestTimer[which]=setTimeout(()=>void updateDelistSuggestions(which),320);});
 c.input.addEventListener('focus',()=>{if(!suppressDelistFocus[which]&&c.input.value.trim().length>=2)void updateDelistSuggestions(which);});
 c.input.addEventListener('keydown',e=>{
  if(e.key==='Escape'){closeDelistSuggest(which);return;}
  if(e.key==='ArrowDown'&&!c.menu.classList.contains('hidden')){e.preventDefault();c.menu.querySelector('button')?.focus();}
 });
 c.menu.addEventListener('keydown',e=>{
  if(e.key==='Escape'){closeDelistSuggest(which);c.input.focus();}
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){
   e.preventDefault();const buttons=[...c.menu.querySelectorAll('button')];const i=buttons.indexOf(document.activeElement);
   buttons[(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();
  }
 });
 c.menu.addEventListener('click',e=>{
  const b=e.target.closest('.delist-suggestion');if(!b)return;
  $('#delistsArtist').value=b.dataset.artist||'';
  if(which==='song')$('#delistsTitle').value=b.dataset.title||'';
  delistSuggestTicket[which]++;suppressDelistFocus[which]=true;closeDelistSuggest(which);c.input.focus();suppressDelistFocus[which]=false;
 });
}
document.addEventListener('pointerdown',e=>{for(const which of ['artist','song'])if(!e.target.closest('.delist-combobox')||!delistSuggestConfig[which].menu.parentElement.contains(e.target))closeDelistSuggest(which);});
paintDelistsType();
async function loadDelists(){
 if(delistsBusy)return;
 try{
  const r=await fetch('/api/admin/delists',{cache:'no-store'}),d=await r.json();
  if(!r.ok)throw Error(d.error||'Could not retrieve delists');
  $('#delistsEntries').innerHTML=d.rules.length?d.rules.map(rule=>`<div class="delist-entry">
    <div class="delist-entry-name"><strong>${esc(rule.kind==='song'?rule.title+' · '+rule.artist:rule.artist)}</strong><span class="muted">${rule.kind==='artist'?'All credited songs':'Specific song and credited artist'}</span></div>
    <div class="delist-entry-actions"><label class="check"><input type="checkbox" data-delist-hidden="${esc(rule.id)}" ${Number(rule.hide_search)?'checked':''}> Hide from search</label>
      <button type="button" class="btn ghost" data-delist-remove="${esc(rule.id)}">Restore playback</button></div>
  </div>`).join(''):'<p class="muted">No active delists. All otherwise available music can play.</p>';
 }catch(e){$('#delistsStatus').textContent=e.message;}
}
$('#delistsRefresh').onclick=()=>void loadDelists();
$('#delistsAddForm').onsubmit=async e=>{
 e.preventDefault();if(delistsBusy)return;
 delistsBusy=true;const submit=e.currentTarget.querySelector('[type=submit]');submit.disabled=true;
 try{
  const r=await post('/api/admin/delists',{kind:delistsType.value,artist:$('#delistsArtist').value,title:$('#delistsTitle').value,hide_search:$('#delistsHideSearch').checked});
  const d=await r.json();if(!r.ok)throw Error(d.error||'Unable to delist');
  $('#delistsStatus').textContent='Delist saved. Playback blocked on this instance; search visibility saved. No files deleted.';
  $('#delistsTitle').value='';$('#delistsArtist').value='';$('#delistsHideSearch').checked=false;
  closeDelistSuggest('artist');closeDelistSuggest('song');
 }catch(err){$('#delistsStatus').textContent=err.message;}
 finally{delistsBusy=false;submit.disabled=false;await loadDelists();}
};
$('#delistsEntries').addEventListener('change',async e=>{
 const check=e.target.closest('[data-delist-hidden]');if(!check)return;
 check.disabled=true;
 try{
  const r=await post('/api/admin/delists/'+encodeURIComponent(check.dataset.delistHidden)+'/visibility',{hide_search:check.checked},'PUT');
  const d=await r.json();if(!r.ok)throw Error(d.error||'Unable to save visibility');
  $('#delistsStatus').textContent=check.checked?'This delist is hidden from search; playback remains blocked.':'This delist is searchable but playback remains blocked.';
 }catch(err){check.checked=!check.checked;$('#delistsStatus').textContent=err.message;}
 finally{check.disabled=false;}
});
$('#delistsEntries').onclick=async e=>{
  const b=e.target.closest('[data-delist-remove]');if(!b)return;
  if(!confirm('Remove this local restriction and allow this music to play again?'))return;
  b.disabled=true;
  try{const r=await fetch('/api/admin/delists/'+encodeURIComponent(b.dataset.delistRemove),{method:'DELETE'}),d=await r.json();if(!r.ok)throw Error(d.error||'Unable to remove rule');
    $('#delistsStatus').textContent='Restriction removed. This change does not alter the source server or music files.';
  }catch(err){$('#delistsStatus').textContent=err.message;}
  finally{b.disabled=false;await loadDelists();}
};

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
async function loadBankSources(){const root=$('#metadataBankSources'),selectAll=$('#metadataBankSelectAll');
 root.replaceChildren();selectAll.textContent='Select all sources';const loading=document.createElement('p');loading.className='muted';loading.textContent='Loading configured metadata sources…';root.append(loading);selectAll.disabled=true;
 try{const r=await bankApi('sources');metadataBankSources=r.sources||[];root.replaceChildren();
  if(!metadataBankSources.length){const note=document.createElement('p');note.className='muted';note.textContent='No authorized metadata source configured. Connected music peers do not automatically grant metadata access. Configure the PC metadata feed URL and read-only token in this deployment’s private server settings: WASP_METADATA_SOURCE_URL and WASP_METADATA_PULL_TOKEN (or WASP_METADATA_SOURCES_JSON).';root.append(note);bankMessage('No metadata sources configured. Existing music and metadata are unchanged.');return;}
  for(const s of metadataBankSources){const label=document.createElement('label');label.className='metadata-bank-source-choice';const input=document.createElement('input');input.type='checkbox';input.value=s.url;input.dataset.bankSource='1';const span=document.createElement('span');const title=document.createElement('strong');title.textContent=s.name;const detail=document.createElement('small');detail.textContent=s.url;span.append(title,detail);label.append(input,span);root.append(label);}
  if(metadataBankSources.length===1)root.querySelector('input').checked=true;
  selectAll.disabled=false;bankMessage(`${metadataBankSources.length} authorized metadata source${metadataBankSources.length===1?'':'s'} ready. Select sources to pull; no changes are applied without review.`);
 }catch(e){root.replaceChildren();const note=document.createElement('p');note.className='err';note.textContent='Unable to load metadata sources: '+e.message;root.append(note);metadataBankSources=[];bankMessage(e.message,true);}}
const bankSelected=()=>[...document.querySelectorAll('[data-bank-source]:checked')].map(e=>e.value);
$('#metadataBankSelectAll').onclick=()=>{const inputs=[...document.querySelectorAll('[data-bank-source]')];const next=!inputs.every(e=>e.checked);for(const input of inputs)input.checked=next;$('#metadataBankSelectAll').textContent=next?'Clear selection':'Select all sources';};
$('#metadataBankRefresh').onclick=()=>void loadBankSources();void loadBankSources();
async function runBankRematch(source,{quiet=false}={}){
 if(!source)return {processed:0,matched:0,review:0};
 let cursor=0,processed=0,matched=0,review=0,steps=0;
 // Pages always advance through pending records; manually assigned and applied
 // entries are excluded by the server. Reopening the page is safe.
 while(true){const d=await bankApi('rematch',{source,after:cursor});
  processed+=d.processed||0;matched+=d.matched||0;review+=d.review||0;steps++;
  if(d.cursor<=cursor||!d.more)break;
  cursor=d.cursor;
  if(steps%20===0)await new Promise(resolve=>setTimeout(resolve,0));
  if(steps>100000)throw Error('Rematch safety limit reached');
  if(!quiet)bankMessage(`Rematching ${source}: ${processed.toLocaleString()} pending records checked · ${matched} new exact audio matches · ${review} review candidates. You can leave this page and resume later.`);
 }
 bankMessage(`Rematch complete: ${processed.toLocaleString()} pending records checked · ${matched} new exact audio matches · ${review} review candidates. Nothing was applied.`);
 return {processed,matched,review};
}
$('#metadataBankRematch').onclick=async()=>{if(metadataBankBusy)return;const sources=bankSelected();if(!sources.length){bankMessage('Select a metadata source to rematch.',true);return;}
 metadataBankBusy=true;$('#metadataBankRematch').disabled=true;
 try{for(const source of sources){metadataBankCurrentSource=source;await runBankRematch(source);}metadataBankOffset=0;await reviewBank();}
 catch(e){bankMessage('Rematch stopped: '+e.message+'. Pending entries are preserved. Click Rematch again to retry.',true);}
 finally{metadataBankBusy=false;$('#metadataBankRematch').disabled=false;}
};
$('#metadataBankFingerprint').onclick=async()=>{if(metadataBankBusy)return;metadataBankBusy=true;const btn=$('#metadataBankFingerprint');btn.disabled=true;
 try{let s=await bankApi('fingerprints/status');if(!confirm(`Prepare exact audio-content fingerprints for ${s.remaining} locally hosted songs? WASP will read its existing audio internally in bounded batches. No MP3s will be uploaded or changed.`))return;
  const total=Number(s.total)||0;while(s.remaining){const d=await bankApi('fingerprints',{});if(d.remaining>=s.remaining&&!d.processed)break;s={...s,remaining:d.remaining};$('#metadataBankProgress').value=total?Math.round(100*(total-d.remaining)/total):100;bankMessage(`Audio identity index: ${total-d.remaining} / ${total} tracks prepared${d.reason?' · '+d.reason:''}. Keep this tab open to continue.`);}
  const sources=bankSelected();if(sources.length){for(const source of sources){metadataBankCurrentSource=source;await runBankRematch(source);}metadataBankOffset=0;await reviewBank();}
  else bankMessage('Local audio identity preparation complete. Select a source and click Rematch staged metadata; no new PC pull is necessary.');
 }catch(e){bankMessage(e.message,true);}finally{btn.disabled=false;metadataBankBusy=false;}}
$('#metadataBankPull').onclick=async()=>{if(metadataBankBusy)return;const sources=bankSelected();if(!sources.length){bankMessage('Select at least one configured source.',true);return;}
 if(!confirm('Manually fetch new Picard metadata from the selected sources and stage differences for review? Previously staged records will be preserved. No existing tracks will be changed.'))return;
 metadataBankBusy=true;$('#metadataBankPull').disabled=true;$('#metadataBankProgress').value=0;let total=0,checked=0;
 try{for(let i=0;i<sources.length;i++){const source=sources[i];const fullScan=$('#metadataBankFullSync').checked;const progress=fullScan?{cursor:0}:await bankApi('pull/progress?source='+encodeURIComponent(source));let cursor=Number(progress.cursor)||0,iterations=0,batchSize=2;
  bankMessage(`${fullScan?'Rechecking':'Resuming'} ${source} after source sequence ${cursor}. Previously staged metadata is preserved.`);
  do{let d;try{d=await bankApi('pull',{source,cursor,batch_size:batchSize});}
   catch(e){if(batchSize>1&&/HTTP 503|1102|CPU time limit|resource limit/i.test(e.message||'')){batchSize=1;bankMessage('Cloudflare resource limit: reducing this pull to one metadata record per request and retrying safely.');d=await bankApi('pull',{source,cursor,batch_size:1});}else throw e;}total+=d.staged||0;checked+=d.count||0;const next=Number(d.cursor);if(next<cursor||(!d.count&&d.more))throw Error('Source did not advance its cursor');cursor=next;iterations++;bankMessage(`Pulling ${source}: ${checked.toLocaleString()} new source records examined · ${total} differences staged · resume sequence ${cursor}…`);$('#metadataBankProgress').value=Math.min(98,Math.round((i+0.9)/sources.length*100));if(!d.more)break;if(iterations>100000)throw Error('Page safety limit reached');}while(true);
  metadataBankCurrentSource=source;}
 $('#metadataBankProgress').value=100;bankMessage(`Pull complete: ${total} new or changed entries staged. Existing staged records were kept. Click Rematch staged metadata if audio fingerprints were prepared later.`);metadataBankOffset=0;await reviewBank();
 }catch(e){bankMessage('Pull stopped: '+e.message+'. Earlier staged entries are preserved. Retry resumes from the last staged sequence.',true);}finally{metadataBankBusy=false;$('#metadataBankPull').disabled=false;}}
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
