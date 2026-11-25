"""WASP v18.3.0a responsive RSS tiles, title, and explicit refreshing."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'
css=(P/'style.css').read_text()
js=(P/'rss-home.mjs').read_text().replace('export function ','function ').replace('export async function ','async function ')
with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width,columns in ((1360,4),(810,2),(390,1)):
    page=browser.new_page(viewport={'width':width,'height':900});page.set_default_timeout(12000)
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('about:blank');page.set_content('<style>'+css+'</style><div id="host"></div>')
    feed_js=r'''
    window.__feedCalls=[];
    window.fetch=async(input,opts={})=>{
      const path=String(input),u=new URL(path,'https://wasp.test');window.__feedCalls.push(u.pathname+u.search);
      if(u.pathname==='/api/rss')return Response.json({enabled:true,position:'center',heading:'WASP News',tabs:[{id:'11111111-aaaa-bbbb-cccc-123456789012',title:'News',kind:'feed'},{id:'22222222-aaaa-bbbb-cccc-123456789012',title:'Events',kind:'feed'}]});
      return Response.json({items:Array.from({length:8},(_,i)=>({title:'Headline '+(i+1),description:'A short article & <summary>',date:'Nov 25, 2026',image:'https://images.example/'+i+'.jpg',url:'https://news.example/'+i})),updated_at:Date.now()});
    };
    '''
    page.evaluate('(s)=>(0,eval)(s)',feed_js+'\n'+js+'\nwindow.mountTest=mountHomeRSS;')
    page.evaluate('window.mountTest(document.querySelector("#host"))')
    page.locator('.rss-feed-item').first.wait_for()
    assert page.locator('.rss-feed-item').count()==8
    assert page.locator('.rss-feed-media img').count()==8
    assert page.locator('.rss-custom-heading').inner_text()=='WASP News'
    assert page.locator('.rss-home-block > h2').count()==0
    observed=page.locator('.rss-feed-grid').evaluate('(el)=>getComputedStyle(el).gridTemplateColumns.split(" ").length')
    assert observed==columns,(width,observed)
    bg=page.locator('.rss-home-block').evaluate('(el)=>getComputedStyle(el).backgroundColor')
    assert bg=='rgb(23, 23, 23)',(width,bg)
    page.locator('.rss-refresh-button').click()
    page.wait_for_function('window.__feedCalls.some(s=>s.includes("refresh=1"))')
    assert not errors,errors
    print('PASS RSS grid, heading, neutral background, refresh at width',width)
    page.close()
  # Blank title leaves no RSS heading, with tabs still shown.
  page=browser.new_page(viewport={'width':1200,'height':800});page.goto('about:blank')
  page.set_content('<style>'+css+'</style><div id="host"></div>')
  js2='window.fetch=async(input)=>{if(String(input)==="/api/rss")return Response.json({enabled:true,position:"left",heading:"",tabs:[{id:"11111111-aaaa-bbbb-cccc-123456789012",title:"News",kind:"feed"}]});return Response.json({items:[]});};'
  page.evaluate('(s)=>(0,eval)(s)',js2+'\n'+js+'\nwindow.mountTest=mountHomeRSS;')
  page.evaluate('window.mountTest(document.querySelector("#host"))')
  page.locator('.rss-tab-button').wait_for()
  assert page.locator('.rss-custom-heading').count()==0
  page.close();browser.close()
  print('PASS blank RSS heading has no decorative title')
