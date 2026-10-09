"""Verify generated GitHub Pages paths and interactions with fictional data."""
import functools
import http.server
import json
import os
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


class DemoHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, request_path):
        if request_path.startswith('/school_wall/'):
            request_path = request_path[len('/school_wall'):]
        return super().translate_path(request_path)

    def log_message(self, *_args):
        pass


def main():
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(DemoHandler, directory=str(ROOT / '.pages-demo')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = os.environ.get('DEMO_TEST_URL') or f'http://127.0.0.1:{server.server_port}/school_wall/'
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel=os.environ.get('WALL_BROWSER_CHANNEL', 'msedge'), headless=True)
        try:
            for width in (390, 768, 769, 1440):
                page = browser.new_page(viewport={'width': width, 'height': 900})
                errors = []
                unsafe = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('request', lambda request: unsafe.append(request.url) if 'wall.jay23.cn' in request.url else None)
                page.goto(url)
                page.locator('.post-card').first.wait_for()
                assert page.locator('.post-card').count() == 5
                assert page.locator('#campus-demo-bar').is_visible()
                page.locator('[data-category="help"]').click()
                page.wait_for_timeout(150)
                assert page.locator('.post-card').count() == 1
                assert '晚自习' in page.locator('#postList').inner_text()
                page.locator('[data-category="全部"]').click()
                page.wait_for_timeout(150)
                page.locator('.post-card').first.click()
                page.wait_for_url('**/post-detail.html?id=1')
                page.goto(url + 'post-detail.html?id=3')
                page.locator('#commentList').get_by_text('谢谢推荐，已经加入歌单！').wait_for()
                page.locator('#commentInput').fill('演示评论回归')
                page.locator('#submitComment').click()
                page.locator('#commentList').get_by_text('演示评论回归').wait_for()

                page.goto(url + 'radio.html')
                page.locator('.slot-card-item').first.wait_for()
                page.locator('#songName').fill('演示歌曲')
                page.locator('#songArtist').fill('演示歌手')
                page.locator('.slot-card-item').first.click()
                page.locator('#dateSelect').select_option('100')
                page.locator('#submitSong').click()
                page.get_by_text('点歌提交成功！', exact=True).wait_for()
                assert '演示歌曲' in page.locator('body').inner_text()
                assert '/school_wall/10' not in page.locator('body').inner_text()

                page.goto(url + 'messages.html')
                page.locator('.conversation-item').first.click()
                page.locator('#message-textarea').fill('演示私信回归')
                page.locator('#btn-send').click()
                page.locator('.message-bubble').get_by_text('演示私信回归').wait_for()

                page.goto(url + 'admin/')
                page.locator('#stat-total-posts').get_by_text('6', exact=True).wait_for()
                page.locator('#overview-pending-posts button').first.click()
                page.wait_for_timeout(150)
                result = page.evaluate('async () => (await (await fetch("/api/posts?category=全部")).json()).data.total')
                assert result == 6, 'admin approval must update the local feed'
                page.goto(url)
                page.locator('.post-card').first.wait_for()
                assert page.locator('.post-card').count() == 6
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'page overflow'
                page.locator('#themeSwitch').click()
                assert page.locator('html').get_attribute('data-theme') == 'dark'
                assert not errors, errors
                assert not unsafe, unsafe
                print(json.dumps({'width': width, 'checks': ['feed', 'filter', 'navigation', 'comment', 'song', 'message', 'approval', 'persistence', 'dark', 'isolation'], 'status': 'passed'}))
                page.context.close()
        finally:
            browser.close()
    server.shutdown()


if __name__ == '__main__':
    main()
