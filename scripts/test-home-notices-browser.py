"""Home notice integration: responsive, native disclosure, safe text and recovery."""
import functools
import os
import threading
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT / 'public')))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=os.environ.get('WALL_BROWSER_CHANNEL', 'msedge'), headless=True)
        for width in [390, 768, 769, 1440]:
            for theme in ['light', 'dark']:
                page = browser.new_page(viewport={'width': width, 'height': 1000})
                page.add_init_script(f"localStorage.setItem('theme', '{theme}');")
                state = {'mode': 'success'}
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                def handle(route):
                    parsed = urlparse(route.request.url)
                    if parsed.hostname != '127.0.0.1':
                        route.abort()
                    elif parsed.path == '/api/notices':
                        if state['mode'] == 'error':
                            route.fulfill(status=500, json={'code': 500})
                        elif state['mode'] == 'empty':
                            route.fulfill(json={'code': 200, 'data': []})
                        else:
                            route.fulfill(json={'code': 200, 'data': [dict(id=1, title='点歌审核通知和公众号歌单调整', content='审核通过不告知播放日期。\n\n只公布本周审核通过的歌曲。<img src=x onerror="window.noticeInjected=true">', is_top=1), dict(id=2, title='第二条公告', content='普通公告内容', is_top=0)]})
                    elif parsed.path.startswith('/api/'):
                        payload = {'posts': [], 'songs': [], 'total': 0, 'has_more': False}
                        if parsed.path == '/api/site-info':
                            payload = {}
                        route.fulfill(json={'code': 200, 'data': payload})
                    else:
                        route.continue_()
                page.route('**/*', handle)
                page.goto(f'http://127.0.0.1:{server.server_port}/index.html', wait_until='networkidle')
                page.evaluate("theme => document.documentElement.setAttribute('data-theme', theme)", theme)
                section = page.locator('#homeNotices')
                expect(section).to_be_visible()
                expect(section.locator('details')).to_have_count(2)
                expect(section.locator('.home-notice-preview').first).to_be_visible()
                typography = section.locator('.home-notice-title').first.evaluate('(el) => ({family: getComputedStyle(el).fontFamily, weight: getComputedStyle(el).fontWeight})')
                assert typography['family'].startswith('system-ui'), typography
                assert typography['weight'] == '500', typography
                assert section.locator('.home-notice-preview').first.evaluate('(el) => parseFloat(getComputedStyle(el).width) <= parseFloat(getComputedStyle(el).fontSize) * 44 + 1')
                expect(section.locator('.home-notice-pin')).to_have_count(1)
                summary = section.locator('summary').first
                summary.focus()
                page.keyboard.press('Enter')
                expect(section.locator('.home-notice-body').first).to_be_visible()
                assert section.locator('img').count() == 0
                assert page.evaluate('window.noticeInjected !== true')
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), f'overflow {width}/{theme}'
                assert section.evaluate('(el) => el.getBoundingClientRect().right <= innerWidth')
                page.keyboard.press('Enter')
                expect(section.locator('.home-notice-preview').first).to_be_visible()
                state['mode'] = 'error'
                page.reload(wait_until='networkidle')
                expect(page.locator('#homeNoticeRetry')).to_be_visible()
                state['mode'] = 'success'
                page.locator('#homeNoticeRetry').click()
                expect(page.locator('#homeNoticeList details')).to_have_count(2)
                state['mode'] = 'empty'
                page.reload(wait_until='networkidle')
                expect(section).to_be_hidden()
                assert not errors, errors
                page.close()
        browser.close()
    print('[home-notices] PASS: 390/768/769/1440 light/dark, guest, safe text, keyboard, retry, empty')
finally:
    server.shutdown()
    server.server_close()
