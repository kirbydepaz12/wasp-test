"""Spotify admin queue: source-length classification, explicit acknowledgement, and real error surfaces."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]/'public'
html=(root/'admin.html').read_text()
html=re.sub(r'<link rel="stylesheet" href="/style\.css(?:\?v=[^"]+)?">',f'<style>{(root/"style.css").read_text()}</style>',html)
html=re.sub(r'<script[^>]*src="/admin\.js(?:\?v=[^"]+)?"[^>]*></script>','',html)
admin_js=re.sub(r'^import .*?;\n','',(root/'admin.js').read_text(),flags=re.M)
bb=re.sub(r'^export function ','function ',(root/'sidebar-bbcode.js').read_text(),flags=re.M)
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1200,'height':850})
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('about:blank');page.set_content(html);page.evaluate('location.hash="#requests"')
 page.evaluate('''window.__calls=[];window.__reqVersion=0;
 window.__queue=[
 {id:'r50',kind:'playlist',title:'This Is Charlie Puth',image:'',url:'https://open.spotify.com/playlist/a',total:50,partial:true,source_status:'unverified',source_total:null,matched:50,matched_local:50,matched_peer:0,missing:[]},
 {id:'r70',kind:'playlist',title:'Known Incomplete',image:'',total:50,partial:true,source_status:'incomplete',source_total:70,matched:50,matched_local:50,matched_peer:0,missing:[]},
 {id:'rMiss',kind:'playlist',title:'Missing Songs',image:'',total:50,partial:true,source_status:'unverified',source_total:null,matched:49,matched_local:49,matched_peer:0,missing:[{t:'Missing song',a:'Test band'}]},
 {id:'rVerified',kind:'playlist',title:'Verified Complete',image:'',total:50,partial:false,source_status:'verified',source_total:50,matched:50,matched_local:50,matched_peer:0,missing:[]}
 ];
 window.confirm=message=>{window.__calls.push({confirm:message});return true;};
 window.fetch=async(input,options={})=>{
  const p=new URL(String(input),'https://example.com').pathname;
  if(p==='/api/admin/requests'&&(!options.method||options.method==='GET'))return Response.json(window.__queue);
  if(p.includes('/api/admin/requests/')&&options.method==='POST'){
   const id=p.split('/')[4],action=p.split('/')[5],payload=options.body?JSON.parse(options.body):null;
   window.__calls.push({id,action,payload});
   if(id==='r50'&&payload?.confirm_unverified===true){window.__queue=window.__queue.filter(x=>x.id!==id);return Response.json({status:'done',matched:50,total:50,completed_unverified:true});}
   if(id==='rVerified'){window.__queue=window.__queue.filter(x=>x.id!==id);return Response.json({status:'done',matched:50,total:50,completed_unverified:false});}
   return Response.json({error:'Spotify reports more songs than WASP retrieved.'},{status:409});
  }
  if(p==='/api/me')return Response.json({admin:true,authenticated:true});
  if(p==='/api/admin/version')return Response.json({version:'17.0.4',label:'Spotify Playlist Completion Fix'});
  if(p==='/api/admin/network')return Response.json({share:true,peers:[]});
  if(p==='/api/site')return Response.json({title:'WASP',name:'WASP',ad:{enabled:false}});
  if(p==='/api/admin/spotify-config')return Response.json({client_id:'',secret_configured:false});
  return Response.json([]);
 };''')
 page.evaluate('(src)=>(0,eval)(src)',bb+'\n'+admin_js)
 page.locator('tr[data-r="r50"]').wait_for()
 def open_row(id):page.locator(f'tr[data-r="{id}"] button[data-a="toggle"]').click()
 open_row('r50')
 detail=page.locator('tr[data-d="r50"]');assert detail.get_by_text('full playlist length unverified',exact=False).is_visible()
 btn=detail.get_by_role('button',name='Finalize 50 retrieved songs…');assert btn.is_visible()
 btn.click()
 page.wait_for_function('window.__calls.some(x=>x.id==="r50")')
 calls=page.evaluate('window.__calls');assert any(x.get('id')=='r50' and x.get('payload')=={'confirm_unverified':True} for x in calls),calls
 assert any('only these 50 retrieved songs' in x.get('confirm','').lower() for x in calls),calls
 page.get_by_text('full Spotify length unverified',exact=False).wait_for()
 page.locator('tr[data-r="r70"]').wait_for()
 open_row('r70');incomplete=page.locator('tr[data-d="r70"]')
 assert incomplete.get_by_text('Spotify reports 70 songs',exact=False).is_visible()
 assert incomplete.locator('button[data-a^="done"]').count()==0
 open_row('rMiss');missing=page.locator('tr[data-d="rMiss"]')
 assert missing.get_by_text('Waiting for 1 missing song',exact=False).is_visible()
 assert missing.locator('button[data-a^="done"]').count()==0
 open_row('rVerified');verified=page.locator('tr[data-d="rVerified"]')
 assert verified.get_by_role('button',name='Mark as done').is_visible()
 # Real error response must be displayed if any request conflicts.
 page.locator('tr[data-r="r70"] button[data-a="refresh"]').click()
 page.get_by_text('Spotify reports more songs than WASP retrieved.').wait_for()
 assert not errors,errors
 browser.close()
print('PASS v17.0.4 Spotify admin queue: explicit override, no skipping known missing songs, verified completion, actual API error')
