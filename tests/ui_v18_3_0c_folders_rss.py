"""Isolated Chromium smoke checks for Docker Music Folders and pinned RSS tabs."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'
html=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">','<style>'+(P/'style.css').read_text()+'</style>',(P/'admin.html').read_text())
html=re.sub(r'<script[^>]*src="/admin.js(?:\?v=[^"]+)?"[^>]*></script>','',html)
admin=re.sub(r'^import .*?;\n','',(P/'admin.js').read_text(),flags=re.M)
bb=re.sub(r'^export function ','function ',(P/'sidebar-bbcode.js').read_text(),flags=re.M)
mock='''
window.__saved=[];window.__folders={runtime:'docker',defaults:['/music'],additional:[],roots:['/music'],scanning:false};
window.fetch=async(input,opts={})=>{
 const url=new URL(String(input),'https://wasp.test'),p=url.pathname,method=opts.method||'GET',b=opts.body?JSON.parse(opts.body):{};
 if(p==='/api/me')return Response.json({admin:true,authenticated:true,role:'admin',username:'admin'});
 if(p==='/api/admin/version')return Response.json({version:'18.3.0c',label:'Music Folders'});
 if(p==='/api/tracks')return Response.json([]);
 if(p==='/api/admin/playlists'||p==='/api/admin/requests')return Response.json([]);
 if(p==='/api/site')return Response.json({name:'WASP',title:'WASP',sidebar:{enabled:false},ad:{enabled:false}});
 if(p==='/api/admin/network')return Response.json({share:false,peers:[]});
 if(p==='/api/admin/music-folders'){
  if(method==='POST'){if(b.path==='/music2'){window.__folders.additional=['/music2'];window.__folders.roots=['/music','/music2'];return Response.json(window.__folders)}return Response.json({error:'Folder not mounted'},{status:400});}
  if(method==='DELETE'){window.__folders.additional=[];window.__folders.roots=['/music'];return Response.json(window.__folders);}
  return Response.json(window.__folders);
 }
 if(p==='/api/admin/rss'&&method==='GET')return Response.json({enabled:true,heading:'News',position:'left',show_titles:true,tabs:[{id:'11111111-aaaa-bbbb-cccc-111111111111',title:'Pitchfork',icon_url:'',code:'https://feed.example.com/rss',kind:'feed'},{id:'22222222-aaaa-bbbb-cccc-222222222222',title:'Billboard',icon_url:'',code:'https://other.example/rss',kind:'feed'}]});
 if(p==='/api/admin/rss'&&method==='PUT'){window.__saved.push(b);return Response.json(b);}
 if(p==='/api/admin/rss/preview')return Response.json({items:[{title:'Test article',description:'Body'}]});
 if(p==='/api/admin/collection-drafts')return Response.json({items:[]});
 if(p==='/api/admin/collection-attach/history')return Response.json({items:[]});
 return Response.json([]);
};
'''
with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in (1360,390):
    page=browser.new_page(viewport={'width':width,'height':950});page.set_default_timeout(15000)
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:d.accept())
    page.goto('about:blank');page.route('**/wasp-icon.png',lambda route:route.fulfill(status=200,content_type='image/png',body=(P/'wasp-icon.png').read_bytes()));page.route('https://cdn.example/*',lambda route:route.fulfill(status=200,content_type='image/png',body=(P/'wasp-icon.png').read_bytes()));page.set_content(html.replace('<head>','<head><base href="https://wasp.test/">'))
    page.evaluate('location.hash="#collection"')
    page.evaluate('(s)=>(0,eval)(s)',mock)
    page.evaluate('(s)=>(0,eval)(s)',bb+'\n'+admin)
    page.locator('#panel:not(.hidden)').wait_for(timeout=20000)
    page.locator('#collectionTabFolders:not(.hidden)').wait_for(timeout=20000)
    page.locator('#collectionTabFolders').click()
    page.locator('#collectionFoldersPanel:not(.hidden)').wait_for()
    assert page.locator('.docker-folder-row').count()==1
    page.locator('#dockerMusicRoot').fill('/music2')
    page.locator('#dockerMusicAdd').click()
    page.wait_for_function('window.__folders.additional.includes("/music2")')
    page.locator('.docker-folder-row').nth(1).wait_for()
    assert page.locator('.docker-folder-row').count()==2
    page.locator('[data-folder-remove="/music2"]').click()
    page.wait_for_function('window.__folders.additional.length===0')
    page.locator('.docker-folder-row').first.wait_for()
    page.evaluate('location.hash="#settings/rss"')
    page.locator('#settingsRSSPanel:not(.hidden)').wait_for()
    page.locator('[data-rss-tab]').nth(1).wait_for()
    assert page.locator('#rssShowTitles').is_checked()
    page.locator('#rssShowTitles').uncheck()
    assert page.locator('#rssLayoutPreview .rss-icon-only').count()==2
    assert page.locator('#rssLayoutPreview .rss-tab-icon').count()==2
    assert '/wasp-icon.png' in page.locator('#rssLayoutPreview .rss-tab-icon').first.get_attribute('src')
    page.locator('[data-rss-icon="0"]').fill('https://cdn.example/pitchfork.png')
    assert page.locator('#rssLayoutPreview .rss-tab-icon').first.get_attribute('src')=='https://cdn.example/pitchfork.png'
    # accessible move controls and drag handles reorder same persisted array
    page.locator('[data-rss-move="0"][data-rss-direction="1"]').click()
    assert page.locator('[data-rss-tab="0"] [data-rss-focus="0"]').inner_text()=='Billboard'
    page.locator('[data-rss-drag="0"]').drag_to(page.locator('[data-rss-tab="1"]'))
    assert page.locator('[data-rss-tab="0"] [data-rss-focus="0"]').inner_text()=='Pitchfork'
    page.locator('#rssSave').click()
    page.wait_for_function('window.__saved.length>0')
    assert page.evaluate('window.__saved.at(-1).show_titles') is False
    assert page.evaluate('window.__saved.at(-1).tabs[0].icon_url')=='https://cdn.example/pitchfork.png'
    assert not errors,errors[:5]
    page.close();print('PASS Docker folder management and RSS icons/reorder, width',width)
  # Cloudflare hides Docker-only tab.
  page=browser.new_page();page.goto('about:blank');page.route('**/wasp-icon.png',lambda route:route.fulfill(status=200,content_type='image/png',body=(P/'wasp-icon.png').read_bytes()));page.route('https://cdn.example/*',lambda route:route.fulfill(status=200,content_type='image/png',body=(P/'wasp-icon.png').read_bytes()));page.set_content(html.replace('<head>','<head><base href="https://wasp.test/">'));page.evaluate('location.hash="#collection"')
  page.evaluate('(s)=>(0,eval)(s)',mock.replace("if(p==='/api/admin/music-folders'){", "if(p==='/api/admin/music-folders'){return Response.json({error:'Docker only'},{status:404});} if(p==='/x-unused'){"))
  page.evaluate('(s)=>(0,eval)(s)',bb+'\n'+admin)
  page.locator('#panel:not(.hidden)').wait_for(timeout=20000);page.wait_for_timeout(220)
  assert page.locator('#collectionTabFolders').is_hidden()
  page.close();browser.close();print('PASS non-Docker folder tab hidden')
