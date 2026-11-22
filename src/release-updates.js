// v18.1.3: fixed-repository, administrator-only upstream update checks.
// Never fetch an administrator-supplied URL, apply an update, or alter a deployment.
export const RELEASE_SOURCES=Object.freeze({
  stable:Object.freeze({owner:'KNDPZ',repo:'WASP',label:'Stable'}),
  test:Object.freeze({owner:'kirbydepaz12',repo:'wasp-test',label:'Test'})
});
export const UPDATE_CHECK_INTERVAL=6*60*60*1000;
const PER_USER_FORCE_MINIMUM=60*1000;
const memory=new Map();
const validSha=s=>/^[a-f\d]{40}$/i.test(String(s||''))?String(s).toLowerCase():'';
const strip=v=>String(v||'').trim().replace(/^v/i,'');
export function compareVersions(a,b){
  const read=s=>{const m=/^(\d+)\.(\d+)\.(\d+)([a-z]?)(?:[.\-+].*)?$/i.exec(strip(s));return m?[+m[1],+m[2],+m[3],m[4].toLowerCase().charCodeAt(0)||0]:null};
  const x=read(a),y=read(b);if(!x||!y)return null;
  for(let i=0;i<4;i++)if(x[i]!==y[i])return x[i]>y[i]?1:-1;
  return 0;
}
const short=s=>String(s||'').slice(0,400);
function parseRelease(item,channel,base){
  if(!item || typeof item.tag_name!=='string' || item.draft || (channel==='stable' && item.prerelease))return null;
  const tag=item.tag_name.slice(0,70);
  if(!/^v?\d+\.\d+\.\d+[a-z]?(?:[.\-+][a-z\d.\-]+)?$/i.test(tag))return null;
  return {tag,name:short(item.name||tag),body:String(item.body||'').slice(0,1600),published_at:item.published_at||null,
    prerelease:!!item.prerelease,url:`${base}/releases/tag/${encodeURIComponent(tag)}`};
}
function parseCommit(item,base){
  const sha=validSha(item?.sha);if(!sha)return null;
  return {sha,short_sha:sha.slice(0,8),message:short(item?.commit?.message?.split('\n')[0]||'New commit'),
    committed_at:item?.commit?.committer?.date||null,url:`${base}/commit/${sha}`};
}
const ghHeaders={'accept':'application/vnd.github+json','user-agent':'WASP-admin-update-checker','x-github-api-version':'2022-11-28'};
async function queryJSON(url,fetchImpl,token=''){
  // Never log a token or expose it through the admin status endpoint.
  const headers=token?{...ghHeaders,authorization:`Bearer ${token}`}:{...ghHeaders};
  const r=await fetchImpl(url,{headers,redirect:'follow',signal:AbortSignal.timeout(7000)});
  if(!r.ok){const error=new Error(r.status===403||r.status===429?'GitHub rate-limited the request':`GitHub returned HTTP ${r.status}`);error.status=r.status;throw error;}
  return r.json();
}
export async function fetchUpstream(channel,{fetchImpl=fetch,force=false,now=Date.now(),token=''}={}){
  const src=RELEASE_SOURCES[channel];if(!src)throw new Error('Invalid release channel');
  const cacheKey=channel+(token?':authenticated':':public');
  const prev=memory.get(cacheKey);
  if(prev && (now-prev.checked_at<UPDATE_CHECK_INTERVAL) && (!force || now-prev.checked_at<PER_USER_FORCE_MINIMUM))return prev;
  const api=`https://api.github.com/repos/${src.owner}/${src.repo}`;
  const base=`https://github.com/${src.owner}/${src.repo}`;
  // A release is optional. The default branch HEAD is authoritative for commit-only updates.
  const [releases,commits]=await Promise.allSettled([
    queryJSON(api+'/releases?per_page=12',fetchImpl,token),queryJSON(api+'/commits?per_page=1',fetchImpl,token)
  ]);
  let release=null,commit=null;
  if(releases.status==='fulfilled'&&Array.isArray(releases.value)){
    release=releases.value.map(item=>parseRelease(item,channel,base)).find(Boolean)||null;
  }
  if(commits.status==='fulfilled'&&Array.isArray(commits.value))commit=parseCommit(commits.value[0],base);
  if(!release&&!commit){
    // Do not poison the cache after a GitHub outage; keep the last good snapshot briefly.
    if(prev)return {...prev,warning:'GitHub is unavailable; showing last successful check.'};
    const allNotFound=[releases,commits].every(p=>p.status==='rejected'&&p.reason?.status===404);
    if(allNotFound)throw new Error(`GitHub cannot access ${src.owner}/${src.repo} (HTTP 404). Confirm the repository exists and is public; for a private repository, configure GITHUB_UPDATES_TOKEN on this WASP server.`);
    throw new Error([releases,commits].filter(p=>p.status==='rejected').map(p=>p.reason.message).join('; ')||'No release or commit found');
  }
  const result={channel,repository:`${src.owner}/${src.repo}`,repository_url:base,release,commit,checked_at:now};
  memory.set(cacheKey,result);return result;
}
export function releaseDecision({upstream,installedVersion,deployedSha='',baselineSha=''}){
  const running=strip(installedVersion);
  const haveSha=validSha(deployedSha)||validSha(baselineSha);
  const r=upstream?.release,c=upstream?.commit;
  const newerRelease=r?compareVersions(r.tag,running)===1:false;
  if(newerRelease){return {available:true,kind:'release',key:`${upstream.channel}:release:${r.tag}`,title:r.name,version:r.tag,url:r.url,
    details:r.body||'New GitHub release published.',published_at:r.published_at};}
  if(c && haveSha && c.sha!==haveSha){return {available:true,kind:'commit',key:`${upstream.channel}:commit:${c.sha}`,title:'New GitHub commit available',
    version:null,url:c.url,details:c.message,published_at:c.committed_at};}
  return {available:false,kind:null,key:null,title:null,version:null,url:null,details:null,published_at:null,
    note:!haveSha?'Commit baseline established at first successful check; future commits will be reported.':''};
}
export function clearCachedChecks(){memory.clear();}
