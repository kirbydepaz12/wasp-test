"""Deterministic in-memory Chromium regression for Radio genre spacing / wheel pager.
No live HTTP server, network, or production data.
"""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'
html=(P/'index.html').read_text()
html=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',lambda m:'<style>'+(P/'style.css').read_text()+'</style>',html)
html=re.sub(r'<script[^>]*src="/app.js(?:\?v=[^"]+)?"[^>]*></script>','',html)
bb=re.sub(r'^export function ','function ',(P/'sidebar-bbcode.js').read_text(),flags=re.M)
art=(P/'art.js').read_text().replace('export const ','const ').replace('const artistArt =','const _artistArt =').replace('const albumArt =','const _albumArt =')
radio=(P/'radio.js').read_text().replace('import { artistsOf } from "./art.js";','').replace('export function ','function ').replace('const shuffle =','const radioShuffle =').replace('shuffle(','radioShuffle(')
builder=(P/'radio-builder.js').read_text().replace('export const ','const ').replace('export function ','function ')
app=re.sub(r'^import .*?;\n','',(P/'app.js').read_text(),flags=re.M)
source='\n'.join((bb,art,radio,builder,app))
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    for width in (1450,390):
        page=browser.new_page(viewport={'width':width,'height':850})
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('about:blank')
        page.set_content(html)
        page.evaluate('location.hash="#radio"')
        page.evaluate(r'''()=>{
          window.fetch=async(input,opt={})=>{
            const url=new URL(String(input),'https://wasp.test'),key=url.pathname;
            let data=[];
            if(key==='/api/catalog-version')data={revision:'1'};
            else if(key==='/api/tracks')data=[{id:'a',title:'Song A',artist:'Artist A',artists:['Artist A'],album:'Album A',genre:'rock',duration:200,created_at:1}];
            else if(key==='/api/genres')data={'Artist A':Array.from({length:73},(_,i)=>'Genre '+String(i).padStart(2,'0'))};
            else if(key==='/api/site')data={name:'WASP',sidebar:{enabled:false},ad:{enabled:false}};
            else if(key==='/api/me')data={authenticated:false};
            else if(key==='/api/stars/batch')data={items:[]};
            else if(key==='/api/entity-reactions')data={artist:{},playlist:{}};
            return Response.json(data);
          };
        }''')
        page.evaluate('(s)=>(0,eval)(s)',source)
        page.locator('#boot[hidden]').wait_for(timeout=20000)
        page.locator('[data-radio-mode="genre"]').click()
        page.wait_for_function('document.querySelectorAll(".radio-genre-dot").length===4')
        assert page.locator('.radio-genre-page .radio-genre-pill').count()==24
        # Regression: the generic fieldset label rule previously introduced 16px extra right margin.
        gap=page.evaluate('''()=>{
          const p=document.querySelector('.radio-genre-page');const a=p.children[0],b=p.children[1];
          const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();
          return {gap:br.left-ar.right,margin:getComputedStyle(a).marginRight,cssGap:getComputedStyle(p).gap};
        }''')
        assert gap['margin']=='0px',gap
        assert 5<=gap['gap']<=7,gap
        assert gap['cssGap']=='6px',gap
        page.locator('.radio-genre-page input').first.check(force=True)
        assert page.locator('#radioSelectedGenres [data-selected-genre]').count()==1
        # Wheel down must advance one page, with fast follow-up input throttled.
        page.locator('.radio-genre-page').hover()
        page.mouse.wheel(0,180)
        page.wait_for_function('document.querySelector(".radio-genre-dot.on")?.dataset.radioGenrePage==="1"')
        page.locator('.radio-genre-page').hover()
        page.mouse.wheel(0,190)
        page.wait_for_timeout(120)
        assert page.locator('.radio-genre-dot.on').get_attribute('data-radio-genre-page')=='1'
        # After settling, horizontal wheel moves to next page.
        page.wait_for_timeout(480)
        page.locator('.radio-genre-page').hover()
        page.mouse.wheel(160,0)
        page.wait_for_function('document.querySelector(".radio-genre-dot.on")?.dataset.radioGenrePage==="2"')
        # Going backwards and dot clicks still work.
        page.wait_for_timeout(480)
        page.locator('.radio-genre-page').hover()
        page.mouse.wheel(0,-150)
        page.wait_for_function('document.querySelector(".radio-genre-dot.on")?.dataset.radioGenrePage==="1"')
        page.locator('[data-radio-genre-page="3"]').click()
        assert page.locator('.radio-genre-dot.on').get_attribute('data-radio-genre-page')=='3'
        assert page.locator('#radioSelectedGenres [data-selected-genre]').count()==1
        page.locator('#radioSelectedGenres [data-selected-genre]').click()
        assert page.locator('#radioSelectedGenres').is_hidden()
        assert not [x for x in errors if "Failed to construct 'URL'" not in x],errors
        page.close()
        print(f'PASS {width}px: 6px gap, wheel forward/back, throttle, dot paging, persistent selections',flush=True)
    browser.close()
