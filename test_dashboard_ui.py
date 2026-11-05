#!/usr/bin/env python3
"""Real-browser UI test for the dashboard (npm run test:ui).

Starts server.js in DASHBOARD_ONLY mode on a random port (temp state files), opens the dashboard in
headless Chromium at desktop 1366x800 and mobile 390x844, and for EVERY tab button:
  * checks the button is fully on-screen without horizontal scrolling (the old overflow-x tab bar hid
    Bulk Send / Goal / Self-Test / Samasya / Mulaqat / Plan / Overview / Scheduled off the right edge),
  * clicks it with a real mouse/tap at its on-screen coordinates (no programmatic scroll-into-view),
  * checks its panel becomes the only visible .tab-content.
Fails on any console error / uncaught page error / failed same-origin request.
Also checks the mobile quick-add panel is present and the page has no horizontal overflow on mobile.

Env: UI_BASE_URL=http://host  -> run against a running server instead (read-only clicks only).
     UI_SCREENSHOT_DIR=/path  -> save a screenshot per tab.
     CHROMIUM_PATH=/usr/bin/chromium (auto-detected); skips (exit 0) when no browser/playwright is available
     unless UI_REQUIRED=1.
"""
import os, sys, json, time, random, shutil, signal, subprocess, tempfile, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PIN = os.environ.get('UI_PIN', '2026')
REQUIRED = os.environ.get('UI_REQUIRED') == '1'


def skip(msg):
    print('SKIP test:ui -', msg)
    sys.exit(1 if REQUIRED else 0)


try:
    from playwright.sync_api import sync_playwright
except Exception:
    skip('python playwright not installed (pip install playwright)')

chromium = os.environ.get('CHROMIUM_PATH') or next((p for p in ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'] if os.path.exists(p)), None)

passed = failed = 0


def check(name, cond, extra=''):
    global passed, failed
    if cond:
        passed += 1; print('PASS', name)
    else:
        failed += 1; print('FAIL', name, extra)


def start_server():
    port = 34000 + random.randint(0, 900)
    tmp = tempfile.mkdtemp(prefix='ui_test_')
    env = dict(os.environ, DASHBOARD_ONLY='true', PORT=str(port), CAMPAIGN_PIN=PIN,
               BROADCAST_STATE_PATH=os.path.join(tmp, 'bc.json'), CONTACTS_DB_PATH=os.path.join(tmp, 'contacts.json'),
               CAMPAIGN_AGENDA_PATH=os.path.join(tmp, 'agenda.json'))
    proc = subprocess.Popen(['node', 'server.js'], cwd=HERE, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = 'http://127.0.0.1:%d' % port
    for _ in range(300):
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(base + '/health', timeout=2) as r:
                if r.status == 200:
                    return proc, base, tmp
        except Exception:
            time.sleep(0.2)
    proc.kill()
    raise SystemExit('server did not start')


def run(base):
    shots = os.environ.get('UI_SCREENSHOT_DIR')
    if shots:
        os.makedirs(shots, exist_ok=True)
    with sync_playwright() as p:
        try:
            kw = {'args': ['--no-sandbox', '--no-proxy-server']}
            if chromium:
                kw['executable_path'] = chromium
            browser = p.chromium.launch(**kw)
        except Exception as e:
            skip('no chromium available: %s' % str(e)[:120])
        for name, vp, mobile in [('desktop', {'width': 1366, 'height': 800}, False), ('mobile', {'width': 390, 'height': 844}, True)]:
            ctx = browser.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile)
            page = ctx.new_page()
            errors = []
            page.on('console', lambda m: errors.append('console: ' + m.text + ' @ ' + str(m.location.get('url', ''))) if m.type == 'error' else None)
            page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
            page.on('response', lambda r: errors.append('HTTP %d %s' % (r.status, r.url)) if r.status >= 400 and r.url.startswith(base) else None)
            page.goto(base + '/?pin=' + PIN, wait_until='domcontentloaded', timeout=60000)
            page.wait_for_timeout(2500)
            n_tabs = page.evaluate("document.querySelectorAll('.tabs .tab-btn').length")
            check('%s: tab buttons rendered (%d)' % (name, n_tabs), n_tabs >= 15)
            check('%s: quick-add panel present' % name, page.query_selector('#qa-panel') is not None)
            if mobile:
                ow = page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
                check('mobile: no horizontal page overflow (%dpx)' % ow, ow <= 2)
            for i in range(n_tabs):
                btn = page.query_selector_all('.tabs .tab-btn')[i]
                tid = (btn.get_attribute('id') or '').replace('tab-btn-', '')
                label = btn.inner_text().strip().split('\n')[0][:40]
                # bring the tab bar into the viewport vertically only (a human scrolls the page, not the tab strip)
                page.evaluate("y => window.scrollTo(0, y)", page.evaluate("() => document.querySelector('.tabs').getBoundingClientRect().top + window.scrollY - 10"))
                box = btn.bounding_box()
                bar = page.evaluate("() => { const r = document.querySelector('.tabs').getBoundingClientRect(); return {l: r.left, r: r.right}; }")
                on_screen = box and box['x'] >= max(0, bar['l'] - 1) and box['x'] + box['width'] <= min(vp['width'], bar['r'] + 1) and box['y'] >= 0 and box['y'] + box['height'] <= vp['height']
                check('%s: [%s] button fully visible without side-scrolling' % (name, label), on_screen, json.dumps(box))
                if mobile:
                    check('%s: [%s] tap target >= 40px tall' % (name, label), box and box['height'] >= 40, json.dumps(box))
                n_err = len(errors)
                cx, cy = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
                hit = page.evaluate("([x, y]) => { const e = document.elementFromPoint(x, y); const b = e && e.closest('.tab-btn'); return b ? b.id : (e ? e.tagName + '#' + e.id : null); }", [cx, cy])
                check('%s: [%s] nothing covers the button' % (name, label), hit == 'tab-btn-' + tid, str(hit))
                if mobile:
                    page.touchscreen.tap(cx, cy)
                else:
                    page.mouse.click(cx, cy)
                page.wait_for_timeout(700)
                vis = page.evaluate("() => [...document.querySelectorAll('.tab-content')].filter(e => getComputedStyle(e).display !== 'none').map(e => e.id)")
                check('%s: [%s] opens #tab-%s only' % (name, label, tid), vis == ['tab-' + tid], str(vis))
                check('%s: [%s] no console errors' % (name, label), len(errors) == n_err, str(errors[n_err:][:3]))
                if shots:
                    page.screenshot(path=os.path.join(shots, '%s_%s.png' % (name, tid)))
            check('%s: zero console errors overall' % name, not errors, str(errors[:5]))
            ctx.close()
        browser.close()


if __name__ == '__main__':
    ext = os.environ.get('UI_BASE_URL')
    proc = tmp = None
    if ext:
        base = ext.rstrip('/')
    else:
        proc, base, tmp = start_server()
    try:
        run(base)
    finally:
        if proc:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(5)
            except Exception:
                proc.kill()
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
    print('\nUI: %d passed, %d failed' % (passed, failed))
    sys.exit(1 if failed else 0)
