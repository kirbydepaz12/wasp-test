"""Isolated Chromium tests for WASP v18.3 admin RSS and reconstruction UI."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'
admin_html=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">', '<style>'+ (P/'style.css').read_text()+'</style>', (P/'admin.html').read_text())
admin_html=re.sub(r'<script[^>]*src="/admin.js(?:\?v=[^"]+)?"[^>]*></script>','',admin_html)
admin_code=re.sub(r'^import .*?;\n','',(P/'admin.js').read_text(),flags=re.M)
bb=re.sub(r'^export function ', 'function ', (P/'sidebar-bbcode.js').read_text(),flags=re.M)
mock=r'''
window.__rssSaves=[];window.__recreateRequests=[];
window.fetch=async(input,opts={})=>{
 const url=new URL(String(input),'https://wasp.test'),p=url.pathname,method=opts.method||'GET',b=opts.body?JSON.parse(opts.body):{};
 if(p==='/api/me')return Response.json({admin:true,authenticated:true,role:'admin',username:'admin'});
 if(p==='/api/admin/version')return Response.json({version:'18.3.0',label:'HIVE Recreate + RSS'});
 if(p==='/api/tracks')return Response.json([]);
 if(p==='/api/admin/playlists'||p==='/api/admin/requests')return Response.json([]);
 if(p==='/api/site')return Response.json({name:'WASP',title:'WASP',sidebar:{enabled:false},ad:{enabled:false}});
 if(p==='/api/admin/network')return Response.json({share:false,peers:[]});
 if(p==='/api/admin/rss'&&method==='GET')return Response.json({enabled:false,position:'left',tabs:[{id:'11111111-aaaa-bbbb-cccc-123456789012',title:'Stored News',code:'https://feed.example.com/news.xml',kind:'feed'}]});
 if(p==='/api/admin/rss'&&method==='PUT'){window.__rssSaves.push(b);return Response.json(b);}
 if(p==='/api/admin/rss/preview')return Response.json({items:[{title:'WASP update',description:'New version released'}]});
 if(p==='/api/admin/collection-guide/search')return Response.json({items:[{id:'12345',kind:url.searchParams.get('type'),title:'Mock album',artist:'Various Artists',provider:'deezer',total:2}]});
 if(p==='/api/admin/collection-drafts'&&method==='GET')return Response.json({items:window.__draft?[window.__draft]:[]});
 if(p==='/api/admin/collection-drafts'&&method==='POST'){
  const source={kind:b.kind,title:'Mock album',url:'https://example.com/album/12345',complete:true,tracks:[{title:'Song A',artists:['Artist A'],track_no:1},{title:'Song B',artists:['Artist B'],track_no:2}]};
  window.__draft={id:'12345678-aaaa-bbbb-cccc-123456789012',kind:b.kind,title:'Mock album',source,matches:{},matched:0,remaining:2,status:'pending'};
  return Response.json(window.__draft);
 }
 if(p.endsWith('/automatch')){window.__recreateRequests.push({path:p,body:b});return Response.json({...window.__draft,next:2,matched:1,remaining:1,matches:{0:'local-a'},review:[{slot:0,status:'matched_local'}]});}
 if(p.endsWith('/candidates'))return Response.json({items:[{id:'peer-a',origin:'https://hive.example',title:'Song B',artist:'Artist B',source:'peer'}]});
 if(p.endsWith('/approve')){window.__recreateRequests.push({path:p,body:b});window.__draft.matches[1]='peer:123';window.__draft.matched=2;return Response.json({...window.__draft});}
 if(p.endsWith('/done')){window.__recreateRequests.push({path:p,body:b});window.__draft=null;return Response.json({ok:true,archived:true});}
 if(p.startsWith('/api/admin/collection-drafts/'))return Response.json(window.__draft);
 if(p==='/api/admin/collection-request-song')return Response.json({ok:true,created:true});
 if(p==='/api/admin/collection-attach/history')return Response.json({items:[]});
 return Response.json([]);
};
'''
rss_home=(P/'rss-home.mjs').read_text().replace('export function ','function ').replace('export async function ','async function ')
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for width in (1360,390):
  page=browser.new_page(viewport={'width':width,'height':900});page.set_default_timeout(12000)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:d.accept())
  page.goto('about:blank');page.set_content(admin_html)
  page.evaluate('location.hash="#add"')
  page.evaluate('(s)=>(0,eval)(s)',mock)
  page.evaluate('(s)=>(0,eval)(s)',bb+'\n'+admin_code)
  page.locator('#panel:not(.hidden)').wait_for(timeout=20000)
  assert page.locator('#addUploadPanel').is_visible()
  assert page.locator('input[name="mode"]').count()==3
  assert page.locator('#addRecreatePanel').is_hidden()
  page.locator('#addTabRecreate').click()
  assert page.locator('#addUploadPanel').is_hidden()
  assert page.locator('#addRecreatePanel').is_visible()
  assert page.locator('#drop').is_hidden(), 'No audio drop zone in Recreate tab'
  page.locator('#spotifyCollectionSearch').fill('Mock album')
  page.locator('#spotifyCollectionSearchButton').click()
  page.locator('[data-spotify-index]').first.click()
  page.locator('.recreate-manifest-row').first.wait_for()
  page.wait_for_function('window.__recreateRequests.some(x=>x.path.endsWith("/automatch"))')
  page.locator('[data-recreate-q="1"]').fill('Song B')
  page.locator('[data-recreate-find="1"]').click()
  page.locator('[data-recreate-choice="1"] option').nth(1).wait_for(state='attached')
  page.locator('[data-recreate-choice="1"]').select_option('0')
  page.locator('[data-recreate-approve="1"]').click()
  page.wait_for_function('window.__recreateRequests.some(x=>x.path.endsWith("/approve"))')
  assert page.evaluate('window.__recreateRequests.find(x=>x.path.endsWith("/approve")).body.origin')=='https://hive.example'
  page.locator('#spotifyDraftHistoryWrap summary').click()
  page.locator('[data-done-draft]').click()
  page.wait_for_function('window.__recreateRequests.some(x=>x.path.endsWith("/done"))')
  page.locator('#addTabUpload').click()
  assert page.locator('#drop').is_visible()
  page.evaluate('location.hash="#settings/rss"')
  page.locator('#settingsRSSPanel:not(.hidden)').wait_for()
  page.locator('#rssTabsEditor [data-rss-tab]').first.wait_for()
  assert not page.locator('#rssEnabled').is_checked()
  page.locator('#rssAddTab').click()
  assert page.locator('[data-rss-tab]').count()==2
  page.locator('#rssEnabled').check()
  page.locator('#rssHeading').fill('WASP Newsroom')
  assert page.locator('#rssLayoutPreview .rss-custom-heading').inner_text()=='WASP Newsroom'
  page.locator('[data-rss-position="center"]').click()
  assert page.locator('#rssLayoutPreview .rss-tab-bar').get_attribute('data-position')=='center'
  page.locator('[data-rss-code="1"]').fill('https://example.com/rss.xml')
  page.locator('#rssSave').click()
  page.wait_for_function('window.__rssSaves.length>0')
  assert page.evaluate('window.__rssSaves[0].position')=='center'
  assert page.evaluate('window.__rssSaves[0].enabled') is True
  assert page.evaluate('window.__rssSaves[0].heading')=='WASP Newsroom'
  assert not errors,errors[:5]
  print('PASS v18.3 Recreate and RSS admin controls',width)
  page.close()
 # RSS public isolated UI, enabled and disabled
 page=browser.new_page(viewport={'width':1100,'height':700});page.goto('about:blank');page.set_content('<main id="test"><section id="rssHost"></section></main>')
 feed_mock=r'''
 window.fetch=async(input,opts={})=>{
 const p=new URL(String(input),'https://wasp.test').pathname;
 if(p==='/api/rss')return Response.json({enabled:true,position:'right',tabs:[{id:'11111111-aaaa-bbbb-cccc-123456789012',title:'News',kind:'feed'},{id:'22222222-aaaa-bbbb-cccc-123456789012',title:'Promos',kind:'feed'}]});
 return Response.json({items:[{title:'WASP release',description:'A <safe> item & description',url:'https://wasp.example/news'}]});
 };
 '''
 page.evaluate('(s)=>(0,eval)(s)',feed_mock+'\n'+rss_home+'\nwindow.mountTest=mountHomeRSS;')
 page.evaluate('window.mountTest(document.querySelector("#rssHost"))')
 page.locator('#rssHost .rss-feed-item').wait_for()
 assert page.locator('#rssHost .rss-tab-bar').get_attribute('data-position')=='right'
 page.locator('[data-rss-idx="1"]').click()
 page.locator('#rssHost .rss-feed-item').wait_for()
 assert '<safe>' not in page.locator('#rssHost').inner_html()
 page.close();browser.close()
 print('PASS opt-in RSS Home feed, switching tabs and escaped articles')
