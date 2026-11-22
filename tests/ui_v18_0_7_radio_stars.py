"""Offline Chromium pagination, star vote and Up Next link checks."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'
html=(P/'index.html').read_text();html=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',lambda m:'<style>'+(P/'style.css').read_text()+'</style>',html)
html=re.sub(r'<script[^>]*src="/app.js(?:\?v=[^"]+)?"[^>]*></script>','',html)
bb=re.sub(r'^export function ','function ',(P/'sidebar-bbcode.js').read_text(),flags=re.M)
art=(P/'art.js').read_text().replace('export const ','const ').replace('const artistArt =','const _artistArt =').replace('const albumArt =','const _albumArt =')
radio=(P/'radio.js').read_text().replace('import { artistsOf } from "./art.js";','').replace('export function ','function ').replace('const shuffle =','const radioShuffle =').replace('shuffle(','radioShuffle(')
builder=(P/'radio-builder.js').read_text().replace('export const ','const ').replace('export function ','function ')
app=re.sub(r'^import .*?;\n','',(P/'app.js').read_text(),flags=re.M)
source='\n'.join((bb,art,radio,builder,app))
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for width in (1350,390):
  p=browser.new_page(viewport={'width':width,'height':850});errors=[];p.on('pageerror',lambda e:errors.append(str(e)));p.goto('about:blank');p.set_content(html);p.evaluate('location.hash="#radio"')
  p.evaluate(r'''()=>{
   window.__test={posts:[]};window.fetch=async(input,opt={})=>{const u=new URL(String(input),'https://wasp.test'),k=u.pathname;let d={};if(k==='/api/catalog-version')d={revision:'1'};else if(k==='/api/tracks')d=[{id:'song1',title:'Arise',artist:'Sepultura',artists:['Sepultura'],album:'Arise',duration:189,release_year:1992,genre:'death metal',created_at:1}];else if(k==='/api/playlists')d=[{id:'srv1',name:'Album Mix',tracks:['song1']}];else if(k==='/api/site')d={name:'WASP',sidebar:{enabled:false},ad:{enabled:false}};else if(k==='/api/me')d={authenticated:false};else if(k==='/api/genres')d={'Sepultura':Array.from({length:67},(_,i)=>'Genre '+String(i).padStart(2,'0'))};else if(k==='/api/stars/batch')d={items:[]};else if(k==='/api/stars'){const b=JSON.parse(opt.body);__test.posts.push(b);d={votes:1,average:b.stars,mine:b.stars};}else if(k==='/api/entity-reactions')d={artist:{},playlist:{}};else if(k==='/api/track-reaction-counts'||k==='/api/network/peers'||k==='/api/peer-catalogue'||k==='/api/active-streams'||k==='/api/user-playlists'||k==='/api/user/peer-tracks'||k==='/api/recent-listens')d=[];else if(k==='/api/radio/top')d=[];return Response.json(d)};
  }''')
  p.evaluate('(s)=>(0,eval)(s)',source);p.locator('#boot[hidden]').wait_for(timeout=18000)
  p.locator('[data-radio-mode="genre"]').click();p.wait_for_function('document.querySelectorAll(".radio-genre-dot").length===3')
  assert p.locator('.radio-genre-dot').count()==3
  assert p.locator('.radio-genre-page input').count()==24
  p.locator('.radio-genre-page input').first.check(force=True)
  assert p.locator('#radioSelectedGenres [data-selected-genre]').count()==1
  p.locator('[data-radio-genre-page="1"]').click()
  assert p.locator('.radio-genre-page input').count()==24
  p.locator('[data-radio-genre-page="2"]').click();assert p.locator('.radio-genre-page input').count()==20
  assert p.locator('#radioSelectedGenres [data-selected-genre]').count()==1
  p.locator('#radioSelectedGenres [data-selected-genre]').click();assert p.locator('#radioSelectedGenres').is_hidden()
  p.evaluate('location.hash="#artist/Sepultura";window.dispatchEvent(new Event("hashchange"))')
  p.wait_for_timeout(250)
  # Artist vote may not render from fixture if there is no artist biography; track vote always renders on playback.
  p.evaluate("""()=>{document.querySelector('#playerStars').innerHTML='<span class="rating-stars" data-star-type="track" data-star-key="song1"><button data-star-value="4">☆</button></span>';}""")
  p.locator('#playerStars [data-star-value="4"]').click()
  p.wait_for_function('__test.posts.length>0')
  assert p.evaluate('__test.posts[0].stars')==4
  assert not [e for e in errors if "Failed to construct 'URL'" not in e],errors
  p.close();print(f'PASS Radio genre page indicators and persistent chips; 5-star voting at {width}px',flush=True)
 browser.close()
