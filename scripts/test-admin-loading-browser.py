"""Local browser regression for cached lists, out-of-order reads and retry UI."""
import functools
import json
import os
import re
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

def data(title):
    row = dict(id=1, title=title, username='fixture', nickname='测试同学', category='other', status='pending', created_at='2026-10-15 12:00:00')
    return {'code': 200, 'data': {'posts': [row], 'users': [dict(row, role='user')], 'songs': [], 'total': 1, 'totalPages': 1}}

server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT / 'public')))
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=os.environ.get('WALL_BROWSER_CHANNEL') or None, headless=True)
        try:
            for width in [390, 768, 769, 1440]:
                context = browser.new_context(viewport={'width': width, 'height': 900}, is_mobile=width <= 768, has_touch=width <= 768)
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.add_init_script("localStorage.setItem('token','fixture');localStorage.setItem('user',JSON.stringify({id:999,role:'super_admin',nickname:'测试管理员'}));localStorage.setItem('admin_last_panel','posts');")
                state = {'postReads': 0, 'hold': False, 'fail': False, 'refresh': False, 'empty': False, 'userRoles': [], 'postKeywords': []}
                pending = {}
                def api(route):
                    path = urlparse(route.request.url)
                    if path.path == '/api/admin/posts':
                        state['postReads'] += 1
                        state['postKeywords'].append(parse_qs(path.query).get('keyword', [''])[0])
                        status = parse_qs(path.query).get('status', ['all'])[0]
                        if state['empty']:
                            route.fulfill(json={'code': 200, 'data': {'posts': [], 'total': 0, 'totalPages': 0}})
                            return
                        if state['refresh']:
                            pending['refresh'] = route
                            return
                        if state['hold'] and status in ['pending', 'approved']:
                            pending[status] = route
                            return
                        if state['fail'] and status == 'rejected':
                            state['fail'] = False
                            route.fulfill(json={'code': 500, 'message': 'fixture error'})
                            return
                        route.fulfill(json=data('已恢复列表' if status == 'rejected' else '初始列表'))
                        return
                    if path.path == '/api/admin/users':
                        state['userRoles'].append(parse_qs(path.query).get('role', ['all'])[0])
                    route.fulfill(json=data('其他列表'))
                page.route('**/api/**', api)
                page.goto(f'http://127.0.0.1:{server.server_port}/admin/index.html', wait_until='networkidle')
                page.locator('#posts-tbody').get_by_text('初始列表').wait_for()
                initial_reads = state['postReads']
                # Switch through the same public navigation events used by the sidebar.
                page.locator('.sidebar-link[data-panel="users"]').evaluate('(node) => node.click()')
                page.locator('#users-tbody tr').first.wait_for()
                page.locator('#users-role-filter').select_option('reviewer')
                page.wait_for_function("document.querySelector('#users-tbody').getAttribute('aria-busy') === 'false'")
                assert 'reviewer' in state['userRoles'], '身份筛选必须传给后台接口'
                page.locator('.sidebar-link[data-panel="posts"]').evaluate('(node) => node.click()')
                page.wait_for_timeout(80)
                assert state['postReads'] == initial_reads, '切回列表应复用短缓存'
                state['hold'] = True
                page.locator('#panel-posts .filter-btn[data-status="pending"]').click()
                page.locator('#panel-posts .filter-btn[data-status="approved"]').first.click()
                for _ in range(50):
                    if 'pending' in pending and 'approved' in pending:
                        break
                    page.wait_for_timeout(20)
                pending['approved'].fulfill(json=data('最新筛选结果'))
                page.locator('#posts-tbody').get_by_text('最新筛选结果').wait_for()
                pending['pending'].fulfill(json=data('过期结果'))
                page.wait_for_timeout(100)
                assert page.locator('#posts-tbody').get_by_text('最新筛选结果').count() == 1
                assert page.locator('#posts-tbody').get_by_text('过期结果').count() == 0
                state['hold'] = False
                state['fail'] = True
                page.locator('#panel-posts .filter-btn[data-status="rejected"]').first.click()
                page.locator('#posts-load-status').get_by_role('button', name='重试').click()
                page.locator('#posts-tbody').get_by_text('已恢复列表').wait_for()
                state['refresh'] = True
                page.locator('#posts-load-status').get_by_role('button', name='刷新').click()
                page.wait_for_function("document.querySelector('#posts-tbody').getAttribute('aria-busy') === 'true'")
                assert page.locator('#posts-tbody').get_by_text('已恢复列表').count() == 1, '刷新时应保留已载入列表'
                for _ in range(50):
                    if 'refresh' in pending:
                        break
                    page.wait_for_timeout(20)
                pending['refresh'].fulfill(json=data('刷新后列表'))
                page.locator('#posts-tbody').get_by_text('刷新后列表').wait_for()
                assert page.evaluate("document.activeElement === document.querySelector('#posts-load-status button')"), '刷新结束后键盘焦点应保留'
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), '页面不能横向溢出'
                assert not errors, errors
                if width in [390, 1440]:
                    artifact_dir = Path(tempfile.gettempdir()) / 'campus-wall-admin-optimization'
                    artifact_dir.mkdir(exist_ok=True)
                    page.screenshot(path=str(artifact_dir / f'admin-{width}.png'))
                state['refresh'] = False
                state['empty'] = True
                page.locator('#panel-posts .filter-btn[data-status="all"]').first.click()
                page.locator('#posts-tbody').get_by_text('暂无数据').wait_for()
                assert page.locator('#posts-count').inner_text() == '共 0 条'
                state['empty'] = False
                page.locator('#posts-search-input').fill('42')
                page.locator('#posts-search-input').press('Enter')
                page.locator('#posts-tbody').get_by_text('初始列表').wait_for()
                assert state['postKeywords'][-1] == '42', '回车搜索应将关键词传给接口'
                page.get_by_role('button', name='清空', exact=True).click()
                assert page.locator('#posts-search-input').input_value() == ''
                page.wait_for_function("document.querySelector('#posts-tbody').getAttribute('aria-busy') === 'false'")
                assert '搜索结果' not in page.locator('#posts-count').inner_text()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                print(json.dumps({'width': width, 'cache': 'pass', 'race': 'pass', 'retry': 'pass', 'empty': 'pass', 'refreshRetainsRows': 'pass', 'jsErrors': errors}, ensure_ascii=False), flush=True)
                context.close()
            context = browser.new_context(viewport={'width': 390, 'height': 900})
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script("localStorage.setItem('token','fixture');localStorage.setItem('user',JSON.stringify({id:999,role:'super_admin'}));localStorage.setItem('admin_last_panel','posts');")
            old_html = re.sub(r'<script src="/admin/js/admin-request-cache[^>]*></script>', '', (ROOT / 'public/admin/index.html').read_text(encoding='utf-8'))
            page.route('**/admin/index.html', lambda route: route.fulfill(content_type='text/html', body=old_html))
            page.route('**/api/**', lambda route: route.fulfill(json=data('缓存模块缺失时仍可加载')))
            page.goto(f'http://127.0.0.1:{server.server_port}/admin/index.html', wait_until='networkidle')
            page.locator('#posts-tbody').get_by_text('缓存模块缺失时仍可加载').wait_for()
            assert not errors, errors
            print(json.dumps({'cacheModuleFallback': 'pass', 'jsErrors': errors}, ensure_ascii=False), flush=True)
            context.close()
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)
