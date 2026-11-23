"""Mocked Chromium UI coverage of Windows-only source and metadata pull, no live services."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]/'public'
html=(ROOT/'admin.html').read_text()
html=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',lambda _: '<style>'+(ROOT/'style.css').read_text()+'</style>',html)
html=re.sub(r'<script[^>]*src="/admin.js(?:\?v=[^"]+)?"[^>]*></script>','',html)
js=re.sub(r'^import .*?;\n','',(ROOT/'admin.js').read_text(),flags=re.M)
bb=re.sub(r'^export function ','function ',(ROOT/'sidebar-bbcode.js').read_text(),flags=re.M)
art=(ROOT/'art.js').read_text().replace('export const ','const ')
script=art+'\n'+bb+'\n'+js

def check(browser,width,pc):
 page=browser.new_page(viewport={'width':width,'height':900});errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.set_content(html)
 page.evaluate('''pc=>{
 window.__pc=pc;window.__scanning={state:'idle',processed:0,discovered:0,changed:0,skipped:0,errors:0};window.__log=[];
 window.confirm=()=>true;window.prompt=()=> 'apply metadata';
 window.fetch=async(input,opt={})=>{
  const u=new URL(String(input),'https://wasp.test'),p=u.pathname,m=opt.method||'GET';window.__log.push([p,m]);
  if(p==='/api/me')return Response.json({admin:true,authenticated:true,username:'admin'});
  if(p==='/api/admin/pc-source/status')return window.__pc?Response.json({local_pc:true,folder:'D:\\\\MUSIC',scan:window.__scanning,entries:200}):Response.json({error:'Forbidden'},403);
  if(p==='/api/admin/pc-source/scan') {window.__scanning={state:'running',processed:20,discovered:100,changed:20,skipped:0,errors:0};return Response.json({ok:true,scan:window.__scanning});}
  if(p==='/api/admin/metadata-bank/sources')return Response.json({sources:[{name:'PC Picard',url:'https://metadata.example.test'}]});
  if(p==='/api/admin/metadata-bank/pull')return Response.json({ok:true,staged:1,unchanged:0,count:1,cursor:1,more:false});
  if(p==='/api/admin/metadata-bank/pending')return Response.json({count:1,audio_matches:1,review:0,unresolved:0,items:[{entry_id:'file-1',seq:1,tags:{title:'Corrected Song',artist:'New Artist',album:'Correct Album',genre:['Rock']},track_id:'track-1',match_type:'audio',old_title:'Track 01',old_artist:'Unknown Artist',old_album:'Unknown Album'}]});
  if(p==='/api/admin/metadata-bank/history')return Response.json({batches:[]});
  if(p==='/api/admin/metadata-bank/apply')return Response.json({ok:true,applied:1,batch_id:'abc-0000'});
  if(p==='/api/admin/metadata-bank/fingerprints/status')return Response.json({total:1,done:1,remaining:0});
  if(p==='/api/admin/version')return Response.json({version:'18.1.5',label:'Picard Metadata'});
  if(p==='/api/admin/users/publish-notifications')return Response.json({pending:0});
  if(p==='/api/admin/network')return Response.json({share:false,peers:[]});
  if(p==='/api/site')return Response.json({name:'WASP',title:'TEST',sidebar:{enabled:false},ad:{enabled:false}});
  if(p==='/api/tracks')return Response.json([{id:'track-1',title:'Track 01',artist:'Unknown Artist',album:'Unknown Album',plays:4}]);
  if(p==='/api/admin/telemetry/metadata')return Response.json({runtime:'cloudflare',coverage:{total:0,years:0,origins:0},peers:[]});
  if(p==='/api/admin/telemetry/metadata/offline-status')return Response.json({});
  if(p==='/api/admin/telemetry/peers')return Response.json({peers:[]});
  return Response.json({});
 };
}''',pc)
 page.evaluate('(s)=>(0,eval)(s)',script)
 page.wait_for_timeout(700)
 if pc:
  page.locator('#pcMetadataSourcePanel').wait_for(state='visible')
  assert page.locator('#pcMusicPath').input_value()=='D:\\MUSIC'
  page.locator('#pcScanNow').click()
  page.wait_for_function("window.__scanning.state==='running'")
  assert page.locator('#pcScanProgressText').is_visible()
 else:assert page.locator('#pcMetadataSourcePanel').is_hidden()
 page.evaluate('location.hash="#network/telemetry"')
 page.locator('[data-metadata-tab="online"]').click()
 page.locator('#metadataBankSources input').wait_for(state='visible')
 assert page.locator('#metadataBankSources input').count()==1
 page.locator('#metadataBankPull').click()
 page.locator('[data-bank-approve="file-1"]').wait_for(state='visible')
 assert 'Corrected Song' in page.locator('#metadataBankRows').inner_text()
 page.locator('[data-bank-approve="file-1"]').check()
 page.locator('#metadataBankApply').click()
 page.wait_for_timeout(900)
 assert 'Applied 1 track updates' in page.locator('#metadataBankStatus').inner_text()
 assert any(x==['/api/admin/metadata-bank/apply','POST'] for x in page.evaluate('window.__log'))
 assert not errors,errors
 print(f'PASS {width}px PC={pc}: scanner gating, scan progress, online source, preview, manual apply')
 page.close()

with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for w,pc in ((1440,True),(390,True),(1440,False),(390,False)):check(browser,w,pc)
 browser.close()
