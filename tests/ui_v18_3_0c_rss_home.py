"""Public RSS icons and pinned-tab tooltips, on 3 viewport sizes."""
from pathlib import Path
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'
css=(P/'style.css').read_text();script=(P/'rss-home.mjs').read_text().replace('export function ','function ').replace('export async function ','async function ')
mock=r'''
window.__feeds=[];window.fetch=async(input,opts={})=>{
const p=String(input);window.__feeds.push(p);
if(p==='/api/rss')return Response.json({enabled:true,heading:'Music news',position:'center',show_titles:false,tabs:[{id:'11111111-aaaa-bbbb-cccc-111111111111',title:'Pitchfork',icon_url:'https://assets.example/music.png',kind:'feed'},{id:'22222222-aaaa-bbbb-cccc-222222222222',title:'Manila concert news',icon_url:'',kind:'feed'}]});
return Response.json({items:[{title:'Concert',description:'Update',image:'',url:'https://news.example/1'}]});
};
'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for width in (1360,810,390):
  page=browser.new_page(viewport={'width':width,'height':800})
  page.goto('about:blank');page.set_content('<style>'+css+'</style><div id="rss"></div><base href="https://wasp.test/">')
  page.evaluate('(s)=>(0,eval)(s)',mock+'\n'+script+'\nwindow.mountTest=mountHomeRSS;')
  page.evaluate('mountTest(document.querySelector("#rss"))')
  page.locator('.rss-feed-item').first.wait_for()
  assert page.locator('.rss-tab-button.rss-icon-only').count()==2
  assert page.locator('.rss-tab-button img').count()==2
  assert page.locator('.rss-tab-button').first.get_attribute('title')=='Pitchfork'
  assert page.locator('.rss-tab-button img').nth(1).get_attribute('src')=='/wasp-icon.png'
  assert page.locator('.rss-tab-button').nth(1).get_attribute('aria-label')=='Manila concert news'
  page.locator('.rss-tab-button').first.hover()
  page.wait_for_timeout(160)
  assert page.locator('.rss-tab-button').first.evaluate('(n)=>getComputedStyle(n,"::after").opacity')=='1'
  page.locator('.rss-tab-button').nth(1).click()
  page.wait_for_function('window.__feeds.some(x=>x.includes("22222222"))')
  page.locator('.rss-feed-item').first.wait_for()
  assert page.locator('.rss-feed-item').count()==1
  page.close();print('PASS pinned RSS tab labels and icon fallback',width)
 browser.close()
