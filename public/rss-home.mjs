// v18.3 RSS rail: independent of the persistent music player.
const escapeText=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function formatRSSItem(item){
  const url=String(item.url||'');let safe='';try{const u=new URL(url);if(['https:','http:'].includes(u.protocol))safe=u.href;}catch{}
  const image=String(item.image||'');let cover='';try{const u=new URL(image);if(['https:','http:'].includes(u.protocol))cover=u.href;}catch{}
  return `<article class="rss-feed-item">${cover?`<img loading="lazy" referrerpolicy="no-referrer" src="${escapeText(cover)}" alt="">`:''}<div>${safe?`<a href="${escapeText(safe)}" target="_blank" rel="noopener noreferrer nofollow">${escapeText(item.title)}</a>`:`<b>${escapeText(item.title)}</b>`}${item.date?`<small class="muted"> · ${escapeText(item.date)}</small>`:''}<p class="muted">${escapeText(item.description||'')}</p></div></article>`;
}
export async function mountHomeRSS(host,fetcher=fetch){
  if(!host?.isConnected)return;
  let manifest;try{const response=await fetcher('/api/rss',{cache:'no-store'});if(!response.ok)throw Error('RSS unavailable');manifest=await response.json();}
  catch{if(host.isConnected)host.remove();return;}
  if(!host.isConnected)return;
  if(!manifest.enabled||!manifest.tabs?.length){host.remove();return;}
  host.className='rss-home-block';
  host.innerHTML='<h2 style="margin:0 0 12px">RSS</h2><div class="rss-tab-bar"></div><div class="rss-home-body" role="tabpanel"></div>';
  const bar=host.querySelector('.rss-tab-bar'),body=host.querySelector('.rss-home-body');
  bar.dataset.position=manifest.position||'left';
  let generation=0;
  const show=async index=>{
    const tab=manifest.tabs[index];if(!tab)return;
    const my=++generation;
    [...bar.querySelectorAll('button')].forEach((b,i)=>b.setAttribute('aria-selected',String(i===index)));
    body.textContent='Loading feed…';
    if(tab.kind==='embed'){
      const code=String(tab.code||'');
      if(/<\s*script\b|javascript\s*:|on\w+\s*=/i.test(code)){body.textContent='Unsupported active embed.';return;}
      const iframe=document.createElement('iframe');iframe.className='rss-embed-preview';iframe.setAttribute('sandbox','');iframe.setAttribute('referrerpolicy','no-referrer');iframe.setAttribute('loading','lazy');iframe.srcdoc=code;body.replaceChildren(iframe);return;
    }
    try{
      const r=await fetcher('/api/rss/feed/'+encodeURIComponent(tab.id),{cache:'default'}),d=await r.json();
      if(!r.ok)throw Error(d.error||'Feed unavailable');
      if(my!==generation||!host.isConnected)return;
      body.innerHTML=d.items?.length?d.items.map(formatRSSItem).join(''):'<p class="muted">No articles available in this feed yet.</p>';
      if(d.stale)body.insertAdjacentHTML('beforeend','<p class="muted">Showing cached RSS items; source temporarily unavailable.</p>');
    }catch(e){if(my===generation&&host.isConnected)body.textContent='Could not load feed: '+e.message;}
  };
  bar.innerHTML=manifest.tabs.map((t,i)=>`<button type="button" class="rss-tab-button" data-rss-idx="${i}" aria-selected="${i===0}">${escapeText(t.title)}</button>`).join('');
  bar.addEventListener('click',e=>{const b=e.target.closest('[data-rss-idx]');if(b)void show(Number(b.dataset.rssIdx));});
  void show(0);
}
