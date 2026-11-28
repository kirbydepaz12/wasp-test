"""Isolated browser checks: reversible administrator delists, narrow layout."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'
html=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">','<style>'+(P/'style.css').read_text()+'</style>',(P/'admin.html').read_text())
html=re.sub(r'<script[^>]*src="/admin.js(?:\?v=[^"]+)?"[^>]*></script>','',html)
admin=re.sub(r'^import .*?;\n','',(P/'admin.js').read_text(),flags=re.M)
bb=re.sub(r'^export function ','function ',(P/'sidebar-bbcode.js').read_text(),flags=re.M)
mock='''
window.__rules=[];window.__searchable=true;window.__next=1;
window.fetch=async(input,opts={})=>{
 const url=new URL(String(input),'https://wasp.test'),p=url.pathname,m=opts.method||'GET',b=opts.body?JSON.parse(opts.body):{};
 if(p==='/api/me')return Response.json({admin:true,authenticated:true,role:'admin',username:'admin'});
 if(p==='/api/admin/version')return Response.json({version:'18.3.0d',label:'Delists'});
 if(p==='/api/tracks'||p==='/api/admin/playlists'||p==='/api/admin/requests')return Response.json([]);
 if(p==='/api/site')return Response.json({name:'WASP',title:'WASP',sidebar:{enabled:false},ad:{enabled:false}});
 if(p==='/api/admin/network')return Response.json({share:false,peers:[]});
 if(p==='/api/admin/music-folders')return Response.json({error:'Docker only'},{status:404});
 if(p==='/api/admin/delists'){
   if(m==='POST')window.__rules.push({...b,id:String(window.__next++).padStart(36,'0')});
   return Response.json({rules:window.__rules,searchable:window.__searchable});
 }
 if(p==='/api/admin/delists/searchable') {window.__searchable=b.searchable;return Response.json({rules:window.__rules,searchable:window.__searchable});}
 if(p.startsWith('/api/admin/delists/')&&m==='DELETE'){window.__rules=window.__rules.filter(r=>r.id!==p.split('/').at(-1));return Response.json({rules:window.__rules,searchable:window.__searchable});}
 return Response.json([]);
};
'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for width in (1360,390):
  page=browser.new_page(viewport={'width':width,'height':920});page.set_default_timeout(15000)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:d.accept())
  page.goto('about:blank');page.set_content(html.replace('<head>','<head><base href="https://wasp.test/">'))
  page.evaluate('location.hash="#danger/delists"')
  page.evaluate('(s)=>(0,eval)(s)',mock)
  page.evaluate('(s)=>(0,eval)(s)',bb+'\n'+admin)
  page.locator('#dangerDelistsPanel:not(.hidden)').wait_for(timeout=25000)
  assert page.locator('#dangerCleanPanel').is_hidden()
  assert page.locator('#delistsSearchable').is_checked()
  page.locator('#delistsArtist').fill('Jinjer')
  page.locator('#delistsAddForm [type="submit"]').click()
  page.wait_for_function('window.__rules.length===1')
  page.locator('.delist-entry').first.wait_for()
  assert 'Jinjer' in page.locator('.delist-entry').first.inner_text()
  page.locator('#delistsType').select_option('song')
  assert page.locator('#delistsTitleWrap').is_visible()
  page.locator('#delistsArtist').fill('Slipknot')
  page.locator('#delistsTitle').fill('Duality')
  page.locator('#delistsAddForm [type="submit"]').click()
  page.wait_for_function('window.__rules.length===2')
  page.locator('.delist-entry').nth(1).wait_for()
  page.locator('#delistsSearchable').uncheck()
  page.wait_for_function('window.__searchable===false')
  page.locator('.delist-entry button').first.click()
  page.wait_for_function('window.__rules.length===1')
  page.evaluate('location.hash="#danger/clean"')
  page.locator('#dangerCleanPanel:not(.hidden)').wait_for()
  assert page.locator('#dangerDelistsPanel').is_hidden()
  assert not errors, errors[:3]
  print('PASS Danger > Delists add, search toggle, restore, clean isolation; viewport',width)
  page.close()
 browser.close()
