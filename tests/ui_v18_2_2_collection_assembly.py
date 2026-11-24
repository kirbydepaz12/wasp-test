"""Offline Chromium checks for admin Spotify-guided album/playlist assembly."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
P=ROOT/'public'
admin_html=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">','<style>'+ (P/'style.css').read_text()+'</style>',(P/'admin.html').read_text())
admin_html=re.sub(r'<script[^>]*src="/admin.js(?:\?v=[^"]+)?"[^>]*></script>','',admin_html)
code=re.sub(r'^import .*?;\n','',(P/'admin.js').read_text(),flags=re.M)
bb=re.sub(r'^export function ', 'function ', (P/'sidebar-bbcode.js').read_text(),flags=re.M)
mock=r'''
window.__attachCalls=[];window.__draft=null;
window.readTags=async f=>({title:f.name.replace(/\.mp3$/i,''),artist:'Artist One',artists:['Artist One']});
window.artistsOf=t=>(Array.isArray(t.artists)&&t.artists.length?t.artists:[t.artist||'Unknown']);
window.artistLine=t=>artistsOf(t).join(', ');
window.albumName=t=>t.album||'';
window.fetch=async(input,opts={})=>{
 const url=new URL(String(input),'https://wasp.test'),p=url.pathname,method=opts.method||'GET',body=opts.body?JSON.parse(opts.body):{};
 if(p==='/api/me')return Response.json({admin:true,authenticated:true,role:'admin',username:'admin'});
 if(p==='/api/admin/version')return Response.json({version:'18.2.2',label:'Artist & Collection'});
 if(p==='/api/tracks')return Response.json([{id:'song-a',title:'Song One',artist:'Artist One',artists:['Artist One'],album:'Old Album',plays:0}]);
 if(p==='/api/admin/playlists')return Response.json([]);
 if(p==='/api/admin/requests')return Response.json([]);
 if(p==='/api/site')return Response.json({name:'WASP',title:'WASP',sidebar:{enabled:false},ad:{enabled:false}});
 if(p==='/api/admin/network')return Response.json({share:false,peers:[]});
 if(p==='/api/admin/collection-guide/search')return Response.json({items:[{id:'12345',provider:'deezer',title:'Various Album',artist:'Various Artists',kind:url.searchParams.get('type'),url:'https://www.deezer.com/album/12345',total:2}]});
 if(p==='/api/admin/collection-drafts'&&method==='POST'){
   const source={kind:body.kind,title:body.kind==='album'?'Various Album':'New Playlist',provider:'deezer',artist:'Various Artists',complete:true,url:'https://www.deezer.com/'+body.kind+'/12345',tracks:[{title:'Song One',artists:['Artist One'],track_no:1},{title:'Song Two',artists:['Artist Two'],track_no:2}]};
   window.__draft={id:'12345678-aaaa-bbbb-cccc-123456789012',title:source.title,kind:body.kind,source,matches:{},matched:0,remaining:2,playlist_id:body.kind==='playlist'?'plid':'',status:'pending'};
   return Response.json(window.__draft);
 }
 if(p==='/api/admin/collection-drafts'&&method==='GET')return Response.json({items:window.__draft?[window.__draft]:[]});
 if(p.startsWith('/api/admin/collection-drafts/')&&p.endsWith('/assign')){
   window.__attachCalls.push({path:p,body});window.__draft.matches[body.slot]=body.track_id;window.__draft.matched=Object.keys(window.__draft.matches).length;window.__draft.remaining=2-window.__draft.matched;window.__draft.status=window.__draft.remaining?'pending':'complete';return Response.json({...window.__draft});
 }
 if(p.startsWith('/api/admin/collection-drafts/'))return Response.json(window.__draft);
 if(p==='/api/admin/collection-attach'){__attachCalls.push({path:p,body});return Response.json({ok:true,artist_preserved:true,unchanged_audio:true});}
 if(p==='/api/admin/collection-request-song'){__attachCalls.push({path:p,body});return Response.json({ok:true,created:true});}
 if(p==='/api/admin/collection-attach/history')return Response.json({items:[{id:'history-1',track_id:'song-a',old_album:'Old Album',old_track_no:1,new_album:'Various Album',at:Date.now()}]});
 if(p==='/api/admin/collection-attach/history-1/undo'){__attachCalls.push({path:p,body});return Response.json({ok:true});}
 if(p==='/api/admin/playlists'){__attachCalls.push({path:p,body});return Response.json({id:'playlist-a',name:body.name});}
 return Response.json([]);
};
'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for width in (1360,390):
  page=browser.new_page(viewport={'width':width,'height':900})
  page.set_default_timeout(8000)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('dialog',lambda d:d.accept())
  page.goto('about:blank');page.set_content(admin_html)
  page.evaluate('location.hash="#add"')
  page.evaluate('(code)=>(0,eval)(code)',mock)
  page.evaluate('(code)=>(0,eval)(code)',bb+'\n'+code)
  page.locator('#panel:not(.hidden)').wait_for(timeout=15000)
  page.locator('input[name=mode][value=album]').check()
  page.locator('#spotifyCollectionTools:not(.hidden)').wait_for()
  page.locator('#spotifyCollectionSearch').fill('Soundtrack')
  page.locator('#spotifyCollectionSearchButton').click()
  page.locator('[data-spotify-index]').first.wait_for()
  page.locator('[data-spotify-index]').first.click()
  page.locator('#spotifyCollectionSelected:not(.hidden)').wait_for()
  assert page.locator('#alName').input_value()=='Various Album'
  assert page.locator('#alArtist').input_value()==''
  assert page.locator('.spotify-manifest-row').count()==2
  page.evaluate("async()=>await stageSpotifyFiles([new File(['fake'],'Song One.mp3',{type:'audio/mpeg'}),new File(['fake'],'Not In Source.mp3',{type:'audio/mpeg'})])")
  assert page.locator('[data-unmatched-decision]').count()==1,'Unmatched MP3 must be reviewed explicitly'
  assert page.locator('[data-unmatched-decision]').input_value()=='exclude','Unmatched defaults to not uploaded'
  page.locator('[data-unmatched-decision]').select_option('separate')
  assert page.locator('[data-unmatched-decision]').input_value()=='separate'
  page.locator('[data-source-track="0"]').select_option('song-a')
  page.locator('[data-source-action="attach"][data-source-index="0"]').click()
  page.wait_for_function('window.__attachCalls.some(c=>c.path.endsWith("/assign"))')
  assert page.evaluate('window.__attachCalls.find(c=>c.path.endsWith("/assign")).body')=={'track_id':'song-a','slot':0}
  page.locator('#spotifyAttachmentHistoryWrap summary').click()
  page.locator('[data-attach-undo="history-1"]').wait_for()
  page.locator('[data-attach-undo="history-1"]').click()
  page.wait_for_function('window.__attachCalls.some(c=>c.path==="/api/admin/collection-attach/history-1/undo")')
  page.locator('[data-source-action="request"][data-source-index="1"]').click()
  page.wait_for_function('window.__attachCalls.some(c=>c.path==="/api/admin/collection-request-song")')
  page.locator('#spotifyDraftHistoryWrap summary').click()
  page.locator('[data-reopen-draft]').wait_for()
  page.locator('input[name=mode][value=playlist]').check()
  assert page.locator('#spotifyCollectionSelected').is_hidden(),'Switching mode must clear old album reference'
  page.locator('#spotifyCollectionSearchButton').click()
  page.locator('[data-spotify-index]').first.click()
  page.locator('#spotifyCollectionSelected:not(.hidden)').wait_for()
  assert page.locator('#plName').input_value()=='New Playlist'
  assert page.locator('.spotify-manifest-row').count()==2
  assert page.locator('#spotifyCollectionTools').is_visible()
  assert page.locator('#spotifyDraftState').inner_text().lower().find('pending')>=0
  assert not errors,errors[:10]
  print('PASS Spotify album and playlist collection guidance',width,'(manual attach, requests, no audio upload)')
  page.close()
 browser.close()
