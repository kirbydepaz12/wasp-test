// v18.3.0b RSS rail — independent of the persistent music player.
const escapeText=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safePublicUrl=s=>{try{const u=new URL(String(s||''));return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}};
export function formatRSSItem(item){
 const link=safePublicUrl(item.url),cover=safePublicUrl(item.image);
 const media=cover?`<img loading="lazy" referrerpolicy="no-referrer" src="${escapeText(cover)}" alt="">`:'<span aria-hidden="true" class="rss-card-placeholder">◉</span>';
 const title=link?`<a href="${escapeText(link)}" target="_blank" rel="noopener noreferrer nofollow">${escapeText(item.title)}</a>`:`<b>${escapeText(item.title)}</b>`;
 return `<article class="rss-feed-item"><div class="rss-feed-media">${media}</div><div class="rss-feed-info">${title}${item.date?`<time class="rss-feed-date">${escapeText(item.date)}</time>`:''}<p class="muted">${escapeText(item.description||'')}</p></div></article>`;
}
export async function mountHomeRSS(host,fetcher=fetch){
 if(!host?.isConnected)return;
 let manifest;try{const response=await fetcher('/api/rss',{cache:'no-store'});if(!response.ok)throw Error('RSS unavailable');manifest=await response.json();}
 catch{if(host.isConnected)host.remove();return;}
 if(!host.isConnected)return;
 if(!manifest.enabled||!manifest.tabs?.length){host.remove();return;}
 host.className='rss-home-block';
 const heading=manifest.heading?`<h2 class="rss-custom-heading">${escapeText(manifest.heading)}</h2>`:'';
 host.innerHTML=`<div class="rss-home-toolbar">${heading}<span class="rss-home-spacer"></span><button class="rss-refresh-button" type="button" title="Check for new RSS articles" aria-label="Refresh RSS feed">↻ Refresh feed</button></div><div class="rss-tab-bar"></div><div class="rss-home-body" role="tabpanel"></div><p class="rss-feed-status muted" role="status"></p>`;
 const bar=host.querySelector('.rss-tab-bar'),body=host.querySelector('.rss-home-body'),status=host.querySelector('.rss-feed-status'),refresh=host.querySelector('.rss-refresh-button');
 bar.dataset.position=manifest.position||'left';
 let generation=0,active=0;
 const show=async(index,force=false)=>{
   const tab=manifest.tabs[index];if(!tab)return;active=index;
   const my=++generation;
   [...bar.querySelectorAll('button')].forEach((b,i)=>b.setAttribute('aria-selected',String(i===index)));
   body.textContent='Loading feed…';status.textContent='';refresh.disabled=tab.kind==='embed';
   if(tab.kind==='embed'){
     const code=String(tab.code||'');
     if(/<\s*script\b|javascript\s*:|on\w+\s*=/i.test(code)){body.textContent='Unsupported active embed.';return;}
     const iframe=document.createElement('iframe');iframe.className='rss-embed-preview';iframe.setAttribute('sandbox','');iframe.setAttribute('referrerpolicy','no-referrer');iframe.setAttribute('loading','lazy');iframe.srcdoc=code;body.replaceChildren(iframe);return;
   }
   try{
     const path='/api/rss/feed/'+encodeURIComponent(tab.id)+(force?'?refresh=1':'');
     const r=await fetcher(path,{cache:'no-store'}),d=await r.json();if(!r.ok)throw Error(d.error||'Feed unavailable');
     if(my!==generation||!host.isConnected)return;
     body.innerHTML=d.items?.length?`<div class="rss-feed-grid">${d.items.map(formatRSSItem).join('')}</div>`:'<p class="muted">No articles available in this feed yet.</p>';
     const when=d.updated_at?new Date(d.updated_at).toLocaleString():'';
     status.textContent=d.stale?'Showing saved articles; the publisher is temporarily unavailable.':d.refresh_throttled?'Recently checked. Refresh is limited to once per minute.':when?'Feed checked: '+when:'';
   }catch(e){if(my===generation&&host.isConnected){body.textContent='Could not load feed: '+e.message;status.textContent='';}}
 };
 bar.innerHTML=manifest.tabs.map((t,i)=>`<button type="button" class="rss-tab-button" data-rss-idx="${i}" aria-selected="${i===0}">${escapeText(t.title)}</button>`).join('');
 bar.addEventListener('click',e=>{const b=e.target.closest('[data-rss-idx]');if(b)void show(Number(b.dataset.rssIdx));});
 refresh.addEventListener('click',()=>{if(!refresh.disabled)void show(active,true);});
 void show(0);
}
