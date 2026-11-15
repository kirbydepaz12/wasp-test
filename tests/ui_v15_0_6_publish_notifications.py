"""Browser smoke test: v15.0.6 publish controls, badges, sorting, and input theme."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]/'public'
css=(ROOT/'style.css').read_text()
index=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',f'<style>{css}</style>',(ROOT/'index.html').read_text())
index=re.sub(r'<script[^>]*src="/app.js(?:\?v=[^"]+)?"[^>]*></script>','',index)
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
window.__mock={global:false,pending:false,approved:false,canPublish:false,publishRequests:1,search:'',published:0,permission:false};
window.fetch=async(input,opts={})=>{
 const p=new URL(String(input),'https://wasp.invalid').pathname,method=opts.method||'GET';
 const mock=window.__mock;let body={},code=200;
 if(p==='/account-settings.html')return new Response(window.__accountHTML,{headers:{'content-type':'text/html'}});
 if(p==='/api/me')body=window.__isAdmin?{authenticated:true,admin:true,role:'admin',username:'owner'}:{authenticated:true,admin:false,role:'user',username:'test',publish_notice:mock.approved};
 else if(p==='/api/site')body={name:'WASP',title:'WASP',sidebar:{enabled:false},ad:{enabled:false}};
 else if(p==='/api/catalog-version')body={revision:'a'};
 else if(['/api/tracks','/api/playlists','/api/user-playlists','/api/network/peers','/api/recent-listens'].includes(p))body=[];
 else if(['/api/peer-reactions','/api/entity-reactions'].includes(p))body={};
 else if(p==='/api/user/peer-tracks'){code=401;body={error:'No tracks'};}
 else if(p==='/api/user/publish/request'&&method==='POST'){mock.pending=true;mock.publishRequests=1;body={ok:true,pending:true};}
 else if(p==='/api/user/publish'){
   if(method==='GET'){body={enabled:mock.canPublish,request_pending:mock.pending,approval_seen:mock.approved,links:[]};mock.approved=false;}
   else body={ok:true};
 }
 else if(p==='/api/admin/users/publish-default'){
   if(method==='PUT'){mock.global=JSON.parse(opts.body).enabled;body={ok:true,enabled:mock.global};}
   else body={enabled:mock.global};
 }
 else if(p==='/api/admin/users/publish-notifications')body={pending:mock.publishRequests};
 else if(p==='/api/admin/users')body=[
   {id:'one',username:'Zelda',heart_songs:12,like_songs:2,dislike_songs:0,private_playlists:1,public_playlists:0,provided_links:1,online_links:0,created_at:1690000000000,can_publish:mock.permission?1:0,publish_requested:mock.publishRequests>0?1:0},
   {id:'two',username:'Amy',heart_songs:1,like_songs:30,dislike_songs:4,private_playlists:0,public_playlists:3,provided_links:7,online_links:5,created_at:1720000000000,can_publish:1,publish_requested:0}
 ];
 else if(p==='/api/admin/users/one/publish'&&method==='PUT'){mock.permission=JSON.parse(opts.body).enabled;mock.publishRequests=0;body={ok:true,enabled:mock.permission};}
 else if(p==='/api/admin/version')body={version:'15.0.6',label:'Publishing Permissions & Notifications'};
 else if(p==='/api/admin/network')body={share:false,peers:[]};
 else if(p==='/api/admin/crons')body={timezone:'Asia/Manila',jobs:{}};
 else if(p==='/api/admin/settings')body={name:'WASP',title:'WASP'};
 else if(p==='/api/admin/requests')body=[];
 return Response.json(body,{status:code});
};
'''
with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  a=browser.new_page(viewport={'width':1280,'height':840})
  failures=[];a.on('pageerror',lambda e:failures.append(str(e)))
  a.goto('about:blank');a.set_content(admin_html)
  a.evaluate('(s)=>(0,eval)(s)',MOCK)
  a.evaluate('window.__isAdmin=true;location.hash="#users"')
  a.evaluate('(s)=>(0,eval)(s)',admin_bundle)
  a.locator('#usersList tbody tr').first.wait_for(timeout=15000)
  assert a.locator('#publishAllUsers').is_checked()==False
  assert a.locator('#usersList thead button[data-sort]').count()==10
  assert a.locator('#usersList tbody tr').count()==2
  assert a.locator('#usersList tbody tr').first.locator('.publish-request-dot').count()==1
  assert a.locator('.publish-request-count').inner_text()=='1'
  assert a.locator('#usersList thead button[data-sort="username"]').count()==1
  a.locator('[data-sort=username]').click()
  assert a.locator('#usersList tbody tr').first.locator('td').first.inner_text().strip()=='Amy'
  a.locator('[data-sort=username]').click()
  assert a.locator('#usersList tbody tr').first.locator('td').first.inner_text().strip()=='Zelda'
  a.locator('[data-sort=heart_songs]').click()
  assert a.locator('#usersList tbody tr').first.locator('td').first.inner_text().strip()=='Amy'
  a.locator('[data-sort=heart_songs]').click()
  assert a.locator('#usersList tbody tr').first.locator('td').first.inner_text().strip()=='Zelda'
  a.locator('[data-sort=created_at]').click()
  assert a.locator('#usersList tbody tr').first.locator('td').first.inner_text().strip()=='Zelda'
  a.locator('[data-sort=created_at]').click()
  assert a.locator('#usersList tbody tr').first.locator('td').first.inner_text().strip()=='Amy'
  a.locator('[data-sort=can_publish]').click()
  assert a.locator('#usersList tbody tr').first.locator('td').first.inner_text().strip()=='Zelda'
  a.locator('#usersSearch').fill('amy')
  assert a.locator('#usersList tbody tr').count()==1
  assert a.locator('#usersList tbody tr').first.locator('td').first.inner_text().strip()=='Amy'
  a.locator('#usersSearch').fill('')
  a.locator('#publishAllUsers').check()
  a.wait_for_function('window.__mock.global===true')
  a.locator('a[href="#account"]').first.click()
  assert a.locator('#adminNewName').get_attribute('type')=='text'
  assert a.locator('#adminNewName').evaluate('e=>getComputedStyle(e).borderRadius')=='999px'
  assert not [e for e in failures if 'not defined' in e or 'Cannot' in e],failures
  u=browser.new_page(viewport={'width':1280,'height':850})
  user_errors=[];u.on('pageerror',lambda e:user_errors.append(str(e)))
  u.goto('about:blank');u.set_content(index)
  u.evaluate('(s)=>window.__accountHTML=s',(ROOT/'account-settings.html').read_text())
  u.evaluate('(s)=>(0,eval)(s)',MOCK)
  u.evaluate('location.hash="#settings/publish"')
  u.evaluate('(s)=>(0,eval)(s)',app_bundle)
  u.locator('#requestPublish').wait_for(timeout=15000)
  u.locator('#requestPublish').click()
  u.locator('.publish-pending').wait_for(timeout=10000)
  u.evaluate('window.__mock.approved=true;window.__mock.canPublish=true;window.__mock.pending=false')
  u.evaluate('(async()=>await refreshAccount())()')
  u.locator('#nav a[href="#settings"] .notice-expanded').wait_for(timeout=10000)
  u.locator('#accountSettingsDialog .publish-subtab-dot').wait_for(timeout=10000)
  settings_row=u.locator('#nav a[href="#settings"]')
  expanded_dot=settings_row.locator('.notice-expanded')
  assert 'nav-has-notices' in (settings_row.get_attribute('class') or '')
  row_bounds=settings_row.bounding_box()
  dot_bounds=expanded_dot.bounding_box()
  assert abs((dot_bounds['y']+dot_bounds['height']/2)-(row_bounds['y']+row_bounds['height']/2))<2, (row_bounds,dot_bounds)
  assert 0 <= (row_bounds['x']+row_bounds['width'])-(dot_bounds['x']+dot_bounds['width']) <= 16, (row_bounds,dot_bounds)
  dislikes_bounds=u.locator('#nav a[href="#dislikes"]').bounding_box()
  assert dot_bounds['y'] > dislikes_bounds['y']+dislikes_bounds['height'], (dot_bounds,dislikes_bounds)
  u.locator('#accountSettingsClose').click()
  u.locator('#sidebarToggle').click()
  compact_dot=settings_row.locator('.notice-compact')
  compact_dot.wait_for(state='visible',timeout=10000)
  assert expanded_dot.is_hidden()
  icon_bounds=settings_row.locator('.nav-icon-frame').bounding_box()
  compact_bounds=compact_dot.bounding_box()
  assert icon_bounds['x'] <= compact_bounds['x'] <= icon_bounds['x']+icon_bounds['width'], (icon_bounds,compact_bounds)
  assert icon_bounds['y'] <= compact_bounds['y'] <= icon_bounds['y']+icon_bounds['height'], (icon_bounds,compact_bounds)
  u.evaluate('document.querySelector(\'#nav a[href="#settings"]\').click()')
  u.locator('#changeUsernameForm').wait_for(timeout=10000)
  assert u.locator('#changeUsernameForm input[name=username]').get_attribute('type')=='text'
  assert u.locator('#changeUsernameForm input[name=username]').evaluate('e=>getComputedStyle(e).borderRadius')=='999px'
  u.locator('[data-settings-tab="publish"]').click()
  u.locator('#publishLinkForm').wait_for(timeout=10000)
  assert u.locator('#nav a[href="#settings"] .notice-expanded').count()==0
  assert u.locator('#accountSettingsDialog .publish-subtab-dot').count()==0
  assert not [e for e in user_errors if 'not defined' in e or 'Cannot' in e],user_errors
  print('PASS v15.0.6 UI: Users search/sorts/global switch/badges, rounded username inputs, publish request, approved notice, collapsed icon badge acknowledgement')
  browser.close()
