"""Offline Chromium checks for incremental artist grid rendering and artist search."""
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
src=(ROOT/'public/app.js').read_text()
part=src[src.index('// Render a bounded first batch immediately'):src.index('// The album name belongs')]
with sync_playwright() as pw:
 for width in (1440,390):
  browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=browser.new_page(viewport={'width':width,'height':840})
  errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content('<style>.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}.tile{min-height:80px}</style><main id="list"></main><audio id="player"></audio>')
  setup='''
   const tracks=Array.from({length:240},(_,i)=>({id:i,title:'Song '+i,artists:['Artist '+String(i).padStart(3,'0')],created_at:i}));
   let query=''; const normal=s=>s.toLowerCase();const artistSearchTokens=s=>s.trim()?[s.trim()]:[];
   const normalizeRecording=s=>String(s).toLowerCase();const artistsOf=t=>t.artists;
   const match=t=>!query||t.title.toLowerCase().includes(query);
   const esc=s=>s;const enc=encodeURIComponent;const plural=(n,w)=>n+' '+w+(n===1?'':'s');
   const art=(src,name)=>'<span class="art"></span>';
   const artistArt=n=>'';const sourceTitle=n=>n;
   const artistSources=n=>({local:true,peer:false});
   const empty=x=>x;const noView=()=>{};
   const buildArtistIndex=(ts)=>{
    const entries=new Map();for(const t of ts)for(const name of artistsOf(t)){
     let item=entries.get(name);if(!item){item={name,songs:0,created:0};entries.set(name,item);}
     item.songs++;item.created=Math.max(item.created,t.created_at);
    }
    const alphabetical=[...entries.values()].sort((a,b)=>a.name.localeCompare(b.name));
    return {alphabetical,newest:[...entries.values()].sort((a,b)=>b.created-a.created)};
   };
   const getArtistIndex=()=>buildArtistIndex(tracks);
   const list=document.querySelector('#list');
   window.IntersectionObserver=undefined;
  '''
  page.add_script_tag(content=setup+part+'''window.__artist={render:(q,recent=false)=>{query=q.toLowerCase();artistGrid(list,recent);},release:releaseArtistGridObserver}''')
  page.evaluate('__artist.render("")')
  assert page.locator('.artist-progressive-grid .tile').count()==48
  assert page.locator('.artist-more-holder button').count()==1
  assert page.locator('#player').count()==1
  page.locator('.artist-more-holder button').click()
  assert page.locator('.artist-progressive-grid .tile').count()==96
  for _ in range(3):page.locator('.artist-more-holder button').click()
  assert page.locator('.artist-progressive-grid .tile').count()==240
  assert page.locator('.artist-more-holder').count()==0
  page.evaluate('__artist.render("Artist 017")')
  assert page.locator('.artist-progressive-grid .tile').count()==1
  assert 'Artist 017' in page.locator('.artist-progressive-grid .tile').inner_text()
  page.evaluate('__artist.render("Song 5",true)')
  assert page.locator('.artist-progressive-grid .tile').count()==11
  assert page.locator('#player').count()==1
  assert not errors,errors
  browser.close()
  print('PASS artist grid progressive, search, recent search and playback continuity',width)
