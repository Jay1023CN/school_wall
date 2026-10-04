# Optional browser regression: Python + Playwright and an installed browser.
# Uses local public/ files and synthetic API fixtures; never connects to production.
import os,json,threading,functools
from contextlib import contextmanager
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]

@contextmanager
def local_site():
    class QuietHandler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=str(ROOT/'public')))
    thread=threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}'
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
rows=[{'id':i+1,'user_id':i+1,'username':f'user{i+1}','nickname':f'测试同学{i+1}','user_nickname':f'测试同学{i+1}','title':f'测试标题{i+1}','content':'长内容用于检查卡片滚动和分页位置。'*5,'song_name':f'测试歌曲{i+1}','artist':'测试歌手','blessing':'天天开心','category':'other','images':'[]','email':'fixture@example.invalid','role':'user','status':'pending','created_at':'2026-10-01 12:00:00','deleted_at':'2026-10-02 12:00:00','type':'bug','action':'saveSettings','action_type':'saveSettings','details':'检查滚动与分页','u1_name':'甲同学','u2_name':'乙同学','total_msgs':2,'deleted_msgs':0,'last_msg':'最近消息'} for i in range(20)]
cases=[('users',320,568,'light'),('users',390,844,'dark'),('users',768,844,'light'),('users',769,844,'light'),('users',1440,844,'light'),('users',667,375,'light')]+[(panel,390,844,'light') for panel in ['posts','songs','feedbacks','logs','trash','postviews','daily-songs','messages']]
with local_site() as base_url, sync_playwright() as p:
    browser=p.chromium.launch(channel=os.environ.get('WALL_BROWSER_CHANNEL') or None,headless=True)
    try:
      for panel,width,height,theme in cases:
        context=browser.new_context(viewport={'width':width,'height':height},is_mobile=width<=768,has_touch=width<=768)
        page=context.new_page();requests=[];errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.add_init_script("localStorage.setItem('token','offline-fixture');localStorage.setItem('user',JSON.stringify({id:999,username:'tester',nickname:'布局测试',role:'super_admin'}));localStorage.setItem('admin_last_panel',"+json.dumps(panel)+");localStorage.setItem('admin-theme',"+json.dumps(theme)+");")
        def api(route):
            requests.append(route.request.url)
            data={key:rows for key in ['users','posts','songs','feedbacks','logs','records','conversations']}
            data.update({'total':40,'totalPages':2,'song_reject_reasons':[],'activeNovelId':'','novels':[]})
            route.fulfill(json={'code':200,'data':data})
        page.route('**/api/**',api)
        page.goto(base_url+'/admin/index.html',wait_until='networkidle')
        if panel=='messages':
            page.locator('#msg-conv-tbody tr').first.wait_for()
            target='#msg-conv-tbody tr:last-child button'
        else:target=f'#{panel}-pagination button[data-page="2"]'
        page.locator(target).first.wait_for(state='attached',timeout=4000)
        page.mouse.move(width-30,min(500,height-30))
        for _ in range(18):page.mouse.wheel(0,2000);page.wait_for_timeout(25)
        info=page.evaluate("""selector=>{const button=document.querySelector(selector),r=button.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);const wrapper=button.closest('.admin-panel').querySelector('.admin-table-wrapper');return {visible:r.top>=0&&r.bottom<=innerHeight&&!!hit&&button.contains(hit),y:r.y,bottom:r.bottom,maxHeight:getComputedStyle(wrapper).maxHeight,horizontalOverflow:document.documentElement.scrollWidth>innerWidth}}""",target)
        reached=info['visible'];clicked=False
        if reached and panel!='messages':
            page.locator(target).first.click(timeout=3000)
            page.wait_for_function("selector=>document.querySelector(selector).classList.contains('active')",arg=target)
            clicked=any(parse_qs(urlparse(u).query).get('page')==['2'] for u in requests)
        print(json.dumps({'panel':panel,'width':width,'height':height,'theme':theme,'reached':reached,'clickedSecondPage':clicked,'jsErrors':errors,'layout':info},ensure_ascii=False))
        assert reached and not info['horizontalOverflow'] and not errors,(panel,width,info,errors)
        if panel!='messages':assert clicked
        if os.environ.get('WALL_BROWSER_SCREENSHOT_DIR'):
            screenshot_dir=Path(os.environ['WALL_BROWSER_SCREENSHOT_DIR'])
            screenshot_dir.mkdir(parents=True,exist_ok=True)
            page.screenshot(path=str(screenshot_dir/f'campus-wall-{panel}-{width}-{height}-{theme}.png'))
        context.close()
    finally:browser.close()
