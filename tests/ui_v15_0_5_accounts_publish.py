"""Smoke test actual WASP public/admin pages for v15.0.5 account controls."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
import json

ROOT=Path(__file__).resolve().parents[1]/'public'
css=(ROOT/'style.css').read_text()
app_html=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',f'<style>{css}</style>',(ROOT/'index.html').read_text())
app_html=re.sub(r'<script[^>]*src="/app.js(?:\?v=[^"]+)?"[^>]*></script>','',app_html)
admin_html=(ROOT/'admin.html').read_text().replace('<link rel="stylesheet" href="/style.css?v=15.0.6">',f'<style>{css}</style>')
admin_html=re.sub(r'<script[^>]*src="/admin.js(?:\?v=[^"]+)?"[^>]*></script>','',admin_html)
art=(ROOT/'art.js').read_text().replace('export const ','const ').replace('const artistArt =','const _artistArt =').replace('const albumArt =','const _albumArt =')
radio=(ROOT/'radio.js').read_text().replace('import { artistsOf } from "./art.js";','').replace('export function ','function ').replace('const shuffle =','const radioShuffle =').replace('shuffle(','radioShuffle(')
bb=re.sub(r'^export function ', 'function ', (ROOT/'sidebar-bbcode.js').read_text(), flags=re.M)
app_js=re.sub(r'^import .*?;\n','',(ROOT/'app.js').read_text(),count=3,flags=re.M)
admin_js=re.sub(r'^import .*?;\n','',(ROOT/'admin.js').read_text(),flags=re.M)
app_bundle=bb+'\n'+art+'\n'+radio+'\n'+app_js
admin_bundle=bb+'\n'+art+'\n'+(ROOT/'id3.js').read_text().replace('export async function readTags','async function readTags')+'\n'+admin_js
MOCK=r'''
window.__mock={permission:false,deleted:false,username:'alice2',published:1};window.__isAdmin=!!window.__isAdmin;
window.fetch=async(input,opts={})=>{
 const url=new URL(String(input),'https://wasp-v15.invalid'),p=url.pathname,method=opts.method||'GET';
 const mock=window.__mock;let data={ok:true},status=200;
 if(p==='/account-settings.html')return new Response(window.__accountHTML,{headers:{'content-type':'text/html'}});
 if(p==='/api/me')data=window.__isAdmin?{authenticated:true,admin:true,role:'admin',username:'owner'}:{authenticated:true,admin:false,role:'user',username:mock.username};
 else if(p==='/api/site')data={name:'WASP',title:'WASP',show_brand_icon:true,sidebar:{enabled:false},ad:{enabled:false}};
 else if(p==='/api/catalog-version')data={revision:'x'};
 else if(p==='/api/network/peers'||p==='/api/tracks'||p==='/api/playlists'||p==='/api/user-playlists'||p==='/api/recent-listens')data=[];
 else if(p==='/api/entity-reactions'||p==='/api/peer-reactions')data={};
 else if(p==='/api/user/peer-tracks'){status=401;data={error:'Sign in required'};}
 else if(p==='/api/user/publish'){
   if(method==='GET')data={enabled:true,links:mock.published?[{id:'link1',url:'https://peer.example.org',name:'Peer WASP',track_count:99,last_ok:1,online:true}]:[]};
   else {mock.published++;data={ok:true};}
 }
 else if(p.startsWith('/api/user/publish/')&&method==='DELETE'){mock.published=0;}
 else if(p==='/api/user/username'&&method==='PUT'){mock.username=JSON.parse(opts.body).username;data={ok:true,username:mock.username};}
 else if(p==='/api/admin/users') data=mock.deleted?[]:[{id:'user-1',username:'test',heart_songs:0,like_songs:0,private_playlists:1,public_playlists:1,provided_links:3,online_links:2,can_publish:mock.permission?1:0}];
 else if(p==='/api/admin/users/user-1/publish'&&method==='PUT'){mock.permission=JSON.parse(opts.body).enabled;data={ok:true,enabled:mock.permission};}
 else if(p==='/api/admin/users/user-1'&&method==='DELETE'){
   const b=JSON.parse(opts.body);if(b.confirm!=='delete'||b.password!=='password'){status=403;data={error:'Invalid confirmation'};}
   else mock.deleted=true;
 }
 else if(p==='/api/admin/username'&&method==='PUT')data={ok:true,username:JSON.parse(opts.body).username};
 else if(p==='/api/admin/version')data={version:'15.0.5',label:'Account & Community Publishing'};
 else if(p==='/api/admin/network')data={share:false,primary_peer_id:'',peers:[]};
 else if(p==='/api/admin/crons')data={timezone:'Asia/Manila',jobs:{}};
 else if(p==='/api/admin/requests'||p==='/api/requests/history'||p==='/api/requests'||p==='/api/admin/playlists'||p==='/api/admin/duplicates')data=[];
 else if(p==='/api/admin/settings')data={name:'WASP',title:'WASP'};
 return Response.json(data,{status});
};
'''
try:
 with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=browser.new_page(viewport={'width':1280,'height':800})
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto('about:blank')
  page.set_content(app_html)
  page.evaluate('(s)=>window.__accountHTML=s',(ROOT/'account-settings.html').read_text())
  page.evaluate('(s)=>(0,eval)(s)',MOCK)
  page.evaluate('location.hash="#settings/publish"')
  page.evaluate('(s)=>(0,eval)(s)',app_bundle)
  page.locator('#myPublishedLinks').wait_for(timeout=15000)
  assert page.locator('#accountSettingsDialog[open] [data-settings-tab="publish"]').count()==1
  assert page.get_by_text('Peer WASP').count()>=1
  assert page.locator('#publishLinkForm').is_visible()
  page.locator('[data-settings-tab="account"]').click()
  page.locator('#changeUsernameForm').wait_for(timeout=10000)
  page.locator('#changeUsernameForm input[name=username]').fill('new-account')
  page.locator('#changeUsernameForm input[name=password]').fill('password')
  page.locator('#changeUsernameForm button').click()
  page.wait_for_function("() => window.__mock.username === 'new-account'")
  assert not [e for e in errors if 'not defined' in e or 'Cannot' in e], errors

  admin=browser.new_page(viewport={'width':1280,'height':850})
  adminerrors=[];admin.on('pageerror',lambda e:adminerrors.append(str(e)))
  admin.goto('about:blank')
  admin.set_content(admin_html)
  admin.evaluate('(s)=>(0,eval)(s)',MOCK)
  admin.evaluate('window.__isAdmin=true;location.hash="#users"')
  admin.evaluate('(s)=>(0,eval)(s)',admin_bundle)
  admin.locator('#usersList table tbody tr').wait_for(timeout=15000)
  assert admin.locator('#usersList table thead').inner_text().find('Online links')!=-1
  assert admin.get_by_text('2',exact=True).count()>=1
  assert admin.locator('#usersList').inner_text().find('https://')==-1
  admin.locator('[data-user-publish]').check()
  admin.wait_for_function('window.__mock.permission===true')
  admin.locator('[data-delete-user]').click()
  admin.locator('#deleteUserDlg').wait_for(state='visible')
  admin.locator('#deleteUserPassword').fill('password')
  admin.locator('#deleteUserWord').fill('delete')
  admin.locator('#deleteUserForm button[type=submit]').click()
  admin.wait_for_function('window.__mock.deleted===true')
  admin.locator('#usersList').get_by_text('No registered users yet.').wait_for()
  assert not [e for e in adminerrors if 'not defined' in e or 'Cannot' in e],adminerrors
  print('PASS v15.0.5 UI: user Publish tab/rename, admin online-only link counters, disabled checkbox, password-confirmed user delete')
  browser.close()
finally:
 pass
