"""Desktop regression: sidebar scrolls but never exposes a native scrollbar."""
from pathlib import Path
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]
css=(P/'public/style.css').read_text()
html=f'''<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>{css}</style><div class="app"><aside class="side"><nav id="nav">{''.join('<a class="nav-item">Link</a>' for _ in range(65))}</nav></aside><main class="main">Music</main></div>'''
with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=browser.new_page(viewport={'width':1280,'height':650})
  page.set_content(html)
  for collapsed in (False,True,False):
    page.evaluate('(state)=>document.body.classList.toggle("sidebar-collapsed",state)',collapsed)
    values=page.locator('.app>.side').evaluate('el=>({overflow:getComputedStyle(el).overflowY,scrollbar:getComputedStyle(el).scrollbarWidth,border:getComputedStyle(el).borderRightWidth,canScroll:el.scrollHeight>el.clientHeight})')
    assert values['scrollbar']=='none',values
    assert values['overflow']=='auto',values
    assert values['canScroll'],values
    assert values['border']=='1px',values
  browser.close()
print('PASS v16.0.6: scrollbar hidden in both modes, scrolling and divider preserved')
