// WASP v18.3 — safe, bounded RSS/Atom reader. No arbitrary HTML executes in WASP.
export function safeFeedUrl(input) {
  let u;try{u=new URL(String(input||''))}catch{return null}
  if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')||u.href.length>1600)return null;
  const host=u.hostname.toLowerCase().replace(/\.$/,'');
  // Only DNS names; no literal private/public IP targets, localhost or metadata services.
  if(!host.includes('.')||/^(localhost|[^.]+\.local|[^.]+\.internal|[^.]+\.localhost|[^.]+\.test|[^.]+\.invalid)$/.test(host)
     ||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||host.endsWith('.onion')
     ||/^\d+\.\d+\.\d+\.\d+$/.test(host)||host.includes(':')||host.startsWith('xn--')&&host.includes('localhost'))return null;
  return u.toString();
}
export function feedTab(input,i=0){
  const title=String(input?.title||`RSS Tab ${i+1}`).trim().slice(0,70),code=String(input?.code||'').trim().slice(0,12000);
  if(!title)throw Error('Every RSS tab needs a title.');
  const kind=code.startsWith('<')?'embed':'feed';
  if(kind==='feed'&&!safeFeedUrl(code))throw Error('Enter a public HTTPS RSS/Atom URL, or a sandboxed embed snippet.');
  if(kind==='embed'&&/<\s*(?:script|object|embed|base|form|meta)\b|javascript\s*:|on\w+\s*=/i.test(code))throw Error('Scripts and active HTML are not allowed in RSS embeds.');
  return {title,code,kind};
}
const unescapeXML=s=>String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi,'$1')
  .replace(/&(?:amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+));/gi,(m,d,h)=>{
    if(d||h){const v=parseInt(d||h,d?10:16);return v>0&&v<=0x10ffff?String.fromCodePoint(v):'';}
    return { '&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[m.toLowerCase()]||m;
  });
const text=s=>unescapeXML(s).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const tag=(xml,name)=>{const re=new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,'i');return xml.match(re)?.[1]||'';};
const link=(item,atom)=>{
  if(atom){const m=item.match(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\/?\s*>/i);return unescapeXML(m?.[1]||'');}
  return text(tag(item,'link'));
};
export function parseFeed(xml,{max=30}={}){
  if(typeof xml!=='string'||xml.length>600000)throw Error('Feed is too large.');
  const atom=/<feed(?:\s|>)/i.test(xml),re=atom?/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi:/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  const items=[];let m;
  while((m=re.exec(xml))&&items.length<Math.min(50,max)){
    const b=m[1],url=link(b,atom);let safe='';try{const u=new URL(url);if(['https:','http:'].includes(u.protocol)&&!u.username&&!u.password)safe=u.href;}catch{}
    const title=text(tag(b,'title')).slice(0,250),description=text(tag(b,'description')||tag(b,'summary')||tag(b,'content')).slice(0,550);
    const date=text(tag(b,'pubDate')||tag(b,'updated')||tag(b,'published')).slice(0,70);
    const enclosure=b.match(/<(?:enclosure|media:thumbnail|media:content)\b[^>]*\burl\s*=\s*["']([^"']+)["'][^>]*>/i);
    const imageUrl=enclosure?unescapeXML(enclosure[1]):'';let image='';try{const u=new URL(imageUrl);if(['https:','http:'].includes(u.protocol))image=u.href;}catch{}
    if(title)items.push({title,description,url:safe,date,image});
  }
  return {format:atom?'atom':'rss',items};
}
export async function fetchFeed(url,fetcher=fetch){
  const safe=safeFeedUrl(url);if(!safe)throw Error('Invalid or private feed URL.');
  const response=await fetcher(safe,{redirect:'manual',headers:{accept:'application/rss+xml, application/atom+xml, text/xml, application/xml;q=0.9'},signal:AbortSignal.timeout(9000)});
  if(!response.ok||response.status>=300&&response.status<400)throw Error('Feed returned HTTP '+response.status);
  const length=Number(response.headers.get('content-length')||0);if(length>600000)throw Error('Feed exceeds 600 KB');
  const reader=response.body?.getReader();let bytes=0,parts=[];
  if(reader){while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>600000){await reader.cancel();throw Error('Feed exceeds 600 KB');}parts.push(value);}}
  const data=new Uint8Array(bytes);let offset=0;for(const part of parts){data.set(part,offset);offset+=part.length;}
  const xml=reader?new TextDecoder().decode(data):await response.text();
  return parseFeed(xml);
}
