/**
 * PivotAI Dynamic Cyber Engine — LobeHub 2.x Edition (v4 "star cosmos")
 * Brand: PivotAI  |  Slogan: 从对话到执行 / Chat less. Ship more.
 * Colors: Primary #16A34A · Accent #34D399  (fresh light green / mint)
 * Layers (deepest → top): AI face mat → faint milky band + grain → star field.
 * Capabilities:
 *   - Brand dark default: seeds localStorage.theme='dark' before the app theme store
 *     reads it (LobeChat's own default is light — see DEPLOY-NOTES §9.6)
 *   - Star universe: depth-tiered stars (near big/fast, far small/slow), twinkle,
 *     green-white + rare mint stars, constellation links, cursor interact,
 *     shooting stars (light streaks) — all 60fps canvas 2D
 *   - Live brand & slogan replacement ("PivotAI") + floating brand widget
 * Injected by apply-theme-v2.ps1 (managed block — edit the repo copy only).
 * Idempotent & defensive: safe under React re-renders, respects reduced motion.
 */
(function () {
  '__PIVOT_ENGINE_GUARD__';
  try {
  if (typeof window === 'undefined') return;
  if (window.__PIVOT_AI_INITIALIZED__) return;
  if (window.self !== window.top) return; // skip iframes (share embeds etc.)
  window.__PIVOT_AI_INITIALIZED__ = true;

  /* ---- 0. 品牌默认深色（LobeChat 默认是 light） --------------------------------
     实测（_scratch/probe-theme-store.sh + verify-theme-boot.sh）：
       · 全新会话 localStorage 为空      -> html[data-theme="light"]、color-scheme:light
       · 手写 localStorage.theme='dark'  -> 重新打开后 html[data-theme="dark"]
     即「未存过主题时 app 默认浅色」，与星野品牌冲突。app 在启动时读这个 key，
     而本块注入在 vendor-ui-runtime（早于业务模块求值），所以这里能抢先种下 dark。
     只补「从未选择过」（key 缺失）与 'auto'（跟随系统，在浅色系统上仍会变白）两种情况；
     用户显式选过 dark / light 就不动它。存储被禁用时静默跳过，交给 CSS 兜底。 */
  try {
    var savedTheme = window.localStorage.getItem('theme');
    if (savedTheme === null || savedTheme === 'auto') {
      window.localStorage.setItem('theme', 'dark');
    }
  } catch (e) { /* 隐私模式 / 存储被禁 -> 由 html,body 的深色底兜底 */ }

  var BRAND_NAME = 'PivotAI';
  var BRAND_SLOGAN = '从对话到执行';
  var FULL_TITLE = 'PivotAI - 从对话到执行 | Chat less. Ship more.';
  var REDUCED = false;
  try {
    REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { /* ignore */ }

  /* ---- 1. Dynamic title & brand text ---- */
  function updateTitle() {
    if (document.title !== FULL_TITLE) document.title = FULL_TITLE;
  }

  var brandScheduled = false;
  function scheduleBrandPass() {
    if (brandScheduled) return;
    brandScheduled = true;
    requestAnimationFrame(function () {
      brandScheduled = false;
      replaceBrandText();
    });
  }

  function replaceBrandText() {
    updateTitle();
    if (!document.body) return;
    // 1) text nodes: LobeChat/LobeHub -> PivotAI
    try {
      var walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      var n;
      while ((n = walk.nextNode())) {
        var v = n.nodeValue;
        if (v && v.length < 400 && (v.indexOf('LobeChat') !== -1 || v.indexOf('LobeHub') !== -1)) {
          n.nodeValue = v.replace(/LobeChat/g, BRAND_NAME).replace(/LobeHub/g, BRAND_NAME);
        }
      }
    } catch (e) { /* ignore */ }

    // 2) floating brand badge
    if (!document.getElementById('pivot-brand-widget')) {
      var widget = document.createElement('div');
      widget.id = 'pivot-brand-widget';
      widget.className = 'pivot-brand-header';
      widget.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;">' +
        '<div class="pivot-brand-dot"></div>' +
        '<span style="font-weight:800;font-size:14px;background:linear-gradient(135deg,#4ADE80 0%,#34D399 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-0.01em;">' +
        BRAND_NAME +
        '</span>' +
        '<span style="font-size:11px;color:#94A3B8;border-left:1px solid rgba(34,197,94,0.3);padding-left:8px;font-weight:400;">' +
        BRAND_SLOGAN +
        '</span>' +
        '</div>';
      document.body.appendChild(widget);
    }
  }

  setTimeout(replaceBrandText, 500);
  setInterval(updateTitle, 2500);
  try {
    var observer = new MutationObserver(scheduleBrandPass);
    var startObserve = function () {
      if (document.body) observer.observe(document.body, { childList: true, subtree: true });
      else document.addEventListener('DOMContentLoaded', function () {
        observer.observe(document.body, { childList: true, subtree: true });
      });
    };
    startObserve();
  } catch (e) { /* ignore */ }

  /* ---- 1.5 AI face mat layer (deepest visual layer) ---- */

  /* Last known backdrop verdict, shared with the star field.
     On a WHITE page the star field needs a much higher alpha to register at all:
     a mid star at a=0.62 paints 255*0.38 + green*0.62, which on white lands
     around (160,230,185) — a whisper. On black the same alpha glows. So the
     particle alphas are scaled by this flag (see ALPHA_BOOST in frame()).
     Kept in sync by syncFaceBlend() below. */
  var LIGHT_BG = true;

  /* Decide whether the page the face floats over is LIGHT or DARK.

     Preference order:
       1. What the app says it is. LobeChat resolves the theme and writes it to
          <html data-theme="…"> plus an INLINE `color-scheme` — measured:
            light -> data-theme="light", style="color-scheme: light;"
            dark  -> data-theme="dark",  style="color-scheme: dark;"
            auto  -> data-theme="auto",  no inline style at all
          `documentElement.style` reads the inline attribute only, so our own
          stylesheet (`html { color-scheme: dark !important }`) cannot leak in.
       2. "auto", or no declaration at all -> follow the OS media query.
       3. Last resort: sample the element stack and walk from the TOP down to
          the first element that really paints a colour.

     The top-down direction is the fix for a bug this heuristic shipped with:
     it used to walk BOTTOM-UP, which was only equivalent while html and body
     were transparent. Once html/body got a real background (§9.2) the walk
     always stopped at html and reported "dark" — even on a white page — so the
     face silently fell back to `screen` and vanished on light backdrops. */
  function backdropIsLight() {
    try {
      var dt = String(document.documentElement.getAttribute('data-theme') || '').toLowerCase();
      if (dt === 'light') return true;
      if (dt === 'dark') return false;
      var inline = String(document.documentElement.style.colorScheme || '').toLowerCase();
      if (inline.indexOf('dark') !== -1) return false;
      if (inline.indexOf('light') !== -1) return true;
    } catch (e) { /* fall through to the media query */ }

    try {
      if (window.matchMedia) {
        if (window.matchMedia('(prefers-color-scheme: dark)').matches) return false;
        if (window.matchMedia('(prefers-color-scheme: light)').matches) return true;
      }
    } catch (e) { /* fall through to sampling */ }

    return sampledBackdropIsLight();
  }

  function sampledBackdropIsLight() {
    var x = Math.round(window.innerWidth * 0.85);
    var y = Math.round(window.innerHeight * 0.5);
    var stack = [];
    try { stack = document.elementsFromPoint(x, y) || []; } catch (e) { stack = []; }
    var minArea = window.innerWidth * window.innerHeight * 0.5;
    var found = null;
    for (var i = 0; i < stack.length; i++) {           /* topmost -> bottom */
      var el = stack[i];
      if (!el) continue;
      if (el.id === 'pivot-face-mat' || el.id === 'pivot-particle-canvas') continue;
      var cs = getComputedStyle(el);
      var m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/.exec(cs.backgroundColor || '');
      if (!m || !(m[4] === undefined || parseFloat(m[4]) > 0.5)) continue;
      var lum = (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
      /* A small opaque widget (button, card) is not "the backdrop" — keep the
         first painted layer that actually spans the page, and only fall back to
         the first painted layer of any size if nothing spans it. */
      try {
        var r = el.getBoundingClientRect();
        if (r.width * r.height >= minArea) return lum > 0.5;
      } catch (e2) { /* ignore */ }
      if (found === null) found = lum > 0.5;
    }
    return found === null ? true : found; /* nothing painted -> browser default white */
  }

  /* Re-sample the backdrop and keep the blend mode in sync.

     A single sample at init is NOT enough, and getting this wrong reproduces the
     original bug inverted. Measured on the real auth page: at `initFaceMat()`
     time the app has not applied its persisted theme yet, so the backdrop is
     still the browser's white -> we latch `.pivot-face-light` (multiply). Then
     the app hydrates and flips to dark, and `multiply` on a dark page makes the
     face invisible — the same symptom we set out to fix, just mirrored.
     So: re-sample on a short bounded schedule, on any attribute change to
     <html> (that is where the theme lands), and on OS colour-scheme change
     (for "Auto"). */
  function syncFaceBlend() {
    var mat = document.getElementById('pivot-face-mat');
    var light = true;
    try { light = backdropIsLight(); } catch (e) { return; }
    LIGHT_BG = light;
    if (!mat) return;
    mat.classList.toggle('pivot-face-light', light);
  }

  /* rAF-throttle: the <html> observer can fire in bursts during hydration. */
  var syncQueued = false;
  function scheduleFaceBlendSync() {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(function () { syncQueued = false; syncFaceBlend(); });
  }

  function watchFaceBlend() {
    syncFaceBlend();
    /* the theme lands after hydration -> a few bounded re-checks */
    [120, 400, 900, 1800, 3000, 5000].forEach(function (t) { setTimeout(syncFaceBlend, t); });
    /* theme switches mutate <html> (class / data-theme / style / color-scheme) */
    try {
      new MutationObserver(scheduleFaceBlendSync).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme', 'lang']
      });
    } catch (e) { /* observer unsupported -> the timers above still cover us */ }
    /* "Auto" mode follows the OS */
    try {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', scheduleFaceBlendSync);
      else if (mq.addListener) mq.addListener(scheduleFaceBlendSync);
    } catch (e) { /* ignore */ }
  }

  function initFaceMat() {
    if (!document.body || document.getElementById('pivot-face-mat')) return;
    var mat = document.createElement('div');
    mat.id = 'pivot-face-mat';
    var first = document.getElementById('pivot-particle-canvas');
    if (first && first.parentNode) first.parentNode.insertBefore(mat, first);
    else document.body.appendChild(mat);
    watchFaceBlend();
    requestAnimationFrame(function () { mat.classList.add('pivot-face-on'); });
  }

  /* ---- 2. star cosmos field (drift + constellation links + cursor + shooting stars) ---- */
  function initParticles() {
    if (REDUCED) return; // respect reduced motion (static wash remains)
    var canvas = document.getElementById('pivot-particle-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'pivot-particle-canvas';
      (document.body || document.documentElement).appendChild(canvas);
    }
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = 0, H = 0;
    function resize() {
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = Math.floor(W * dpr); canvas.height = Math.floor(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      rebuild();
      paintBackdrop();
    }

    var N = 0, ps = [], LINK = 128;
    function rebuild() {
      var area = W * H;
      var base = Math.round(area / 7000);
      if (W < 768) base = Math.round(base * 0.62);
      N = Math.max(80, Math.min(360, base));
      LINK = W < 768 ? 104 : 128;
      ps = [];
      for (var i = 0; i < N; i++) {
        var tier = Math.random();
        var far = tier < 0.50, near = tier > 0.84;
        var r = far ? 0.6 + Math.random() * 0.4 : near ? 2.0 + Math.random() * 1.2 : 1.2 + Math.random() * 0.8;
        var spd = far ? 0.42 : near ? 1.45 : 1.0;
        var bright = far ? 0.45 : near ? 1.6 : 0.95;
        var cr = Math.random();
        var hue = cr < 0.09 ? 3 : (cr < 0.64 ? 0 : (cr < 0.90 ? 1 : 2)); // 四档浅绿/薄荷层次
        ps.push({
          x: Math.random() * W, y: Math.random() * H,
          r: r, bright: bright,
          vx: ((Math.random() - 0.5) * 12 - 5) * spd,
          vy: -(12 + Math.random() * 26) * spd,
          ph: Math.random() * 6.283,
          tw: 0.5 + Math.random() * 1.6,
          hue: hue
        });
      }
      window.__PDBG = {
        frames: 0,
        getSample: function () { return ps.slice(0, 8).map(function (p) { return { x: Math.round(p.x), y: Math.round(p.y) }; }); },
        count: function () { return N; }
      };
    }

    /* faint milky band + film grain, pre-rendered once per resize */
    var backdrop = document.createElement('canvas');
    function paintBackdrop() {
      var bw = canvas.width, bh = canvas.height;
      backdrop.width = bw; backdrop.height = bh;
      var c = backdrop.getContext('2d');
      c.clearRect(0, 0, bw, bh);
      c.save();
      c.translate(bw * 0.5, bh * 0.5);
      c.rotate(-0.45);
      var g = c.createLinearGradient(0, -bh * 0.34, 0, bh * 0.34);
      g.addColorStop(0, 'rgba(60,180,120,0)');
      g.addColorStop(0.5, 'rgba(70,200,140,0.05)');
      g.addColorStop(1, 'rgba(60,180,120,0)');
      c.fillStyle = g;
      c.fillRect(-bw * 0.9, -bh * 0.34, bw * 1.8, bh * 0.68);
      for (var i = 0; i < 9; i++) {
        var bx = -bw * 0.8 + bw * 1.6 * (i / 8);
        var by = Math.sin(i * 2.7) * bh * 0.18;
        var rr = bh * (0.10 + 0.12 * Math.abs(Math.sin(i * 1.3)));
        var rg = c.createRadialGradient(bx, by, 0, bx, by, rr);
        rg.addColorStop(0, 'rgba(100,210,160,0.045)');
        rg.addColorStop(1, 'rgba(100,210,160,0)');
        c.fillStyle = rg;
        c.beginPath(); c.arc(bx, by, rr, 0, 6.283); c.fill();
      }
      c.restore();
      for (var y = 0; y < bh; y += 3) for (var x = 0; x < bw; x += 3) {
        if (Math.random() < 0.5) continue;
        c.fillStyle = 'rgba(200,245,215,' + (Math.random() * 0.05).toFixed(3) + ')';
        c.fillRect(x, y, 1, 1);
      }
    }
    resize();
    window.addEventListener('resize', resize);

    var sprite = (function () {
      var s = document.createElement('canvas');
      s.width = s.height = 64;
      var c2 = s.getContext('2d');
      var g = c2.createRadialGradient(32, 32, 0, 32, 32, 32);
      /* 浅绿实心核 + 短衰减。
         原来核是纯白 (255,255,255)，在白底上等于隐身；而且衰减一路拖到 100%，
         近景大星 (r 2.0~3.2 -> 画布 20~32px) 在白底上会糊成一团绿斑。
         收成「实心核 + 快速衰减」后，白底上读作清脆的绿点，深底上仍是发光星。 */
      g.addColorStop(0,    'rgba(34,197,94,1)');      // green-500 实心核（低 alpha 时渲染成浅绿）
      g.addColorStop(0.28, 'rgba(74,222,128,0.88)');  // green-400
      g.addColorStop(0.58, 'rgba(52,211,153,0.20)');  // emerald-400 短晕
      g.addColorStop(1,    'rgba(16,185,129,0)');     // emerald-500 收干净
      c2.fillStyle = g;
      c2.fillRect(0, 0, 64, 64);
      return s;
    })();
    /* 星座连线配色：全部收进「浅绿 / 薄荷」家族，保留四档细微层次。
       原来是蓝 / 青 / 紫 / 沙，与新的绿色主调冲突。 */
    var HUES = [
      ['rgba(134,239,172,', 'rgba(74,222,128,'],   // green-300   -> green-400
      ['rgba(110,231,183,', 'rgba(52,211,153,'],   // emerald-300 -> emerald-400
      ['rgba(167,243,208,', 'rgba(16,185,129,'],   // green-200   -> emerald-500
      ['rgba(74,222,128,',  'rgba(34,197,94,']     // green-400   -> green-500
    ];

    var mouse = { x: -9999, y: -9999 };
    window.addEventListener('pointermove', function (e) { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
    window.addEventListener('pointerleave', function () { mouse.x = -9999; mouse.y = -9999; }, { passive: true });

    var streaks = [];
    var nextStreakAt = performance.now() + 2600 + Math.random() * 4200;
    var last = performance.now();
    var born = last;

    function frame(now) {
      var dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      var fadeIn = Math.min(1, (now - born) / 1400);

      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(backdrop, 0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      window.__PDBG.frames++;

      var i, j, p, q, dx, dy, d2, d, a;

      /* motion + wrap + cursor repulsion */
      for (i = 0; i < N; i++) {
        p = ps[i];
        p.x += p.vx * dt + Math.sin(now * 0.0007 + p.ph) * 18 * dt;
        p.y += p.vy * dt;
        if (p.y < -12) { p.y = H + 10; p.x = Math.random() * W; }
        if (p.y > H + 12) p.y = -10;
        if (p.x < -12) p.x = W + 10;
        if (p.x > W + 12) p.x = -10;
        dx = p.x - mouse.x; dy = p.y - mouse.y;
        d2 = dx * dx + dy * dy;
        if (d2 < 140 * 140 && d2 > 1) {
          d = Math.sqrt(d2);
          var f = (140 - d) / 140;
          p.x += (dx / d) * f * 60 * dt;
          p.y += (dy / d) * f * 60 * dt;
        }
      }

      /* constellation links + cursor links */
      var LINK2 = LINK * LINK;
      for (i = 0; i < N; i++) {
        p = ps[i];
        for (j = i + 1; j < N; j++) {
          q = ps[j];
          dx = p.x - q.x; dy = p.y - q.y;
          d2 = dx * dx + dy * dy;
          if (d2 < LINK2) {
            d = Math.sqrt(d2);
            /* 连线在白底上要比光点克制得多：点多是「星」，线多了就是「网」。
               实测 0.34 会让整页变成绿色蛛网，压到 0.20 才只剩暗示。 */
            a = (1 - d / LINK) * (LIGHT_BG ? 0.20 : 0.18) * ((p.bright + q.bright) * 0.5);
            ctx.strokeStyle = HUES[p.hue][1] + a.toFixed(3) + ')';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.stroke();
          }
        }
        dx = p.x - mouse.x; dy = p.y - mouse.y;
        d2 = dx * dx + dy * dy;
        if (d2 < 170 * 170 && d2 > 1) {
          d = Math.sqrt(d2);
          a = (1 - d / 170) * (LIGHT_BG ? 0.46 : 0.30);
          ctx.strokeStyle = 'rgba(134,239,172,' + a.toFixed(3) + ')';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(mouse.x, mouse.y);
          ctx.stroke();
        }
      }

      /* stars */
      for (i = 0; i < N; i++) {
        p = ps[i];
        /* 白底需要更高 alpha 才看得见；深底沿用原来的 0.62（已调好，别动）。 */
        a = (LIGHT_BG ? 0.95 : 0.62) * p.bright * (0.30 + 0.70 * (0.5 + 0.5 * Math.sin(now * 0.0026 * p.tw + p.ph))) * fadeIn;
        ctx.globalAlpha = Math.min(1, a);
        var rr = p.r * 5;
        ctx.drawImage(sprite, p.x - rr, p.y - rr, rr * 2, rr * 2);
      }
      ctx.globalAlpha = 1;

      /* shooting stars */
      if (now > nextStreakAt && streaks.length < 3) {
        streaks.push({
          x: Math.random() * W * 0.7 + W * 0.15, y: Math.random() * H * 0.35,
          vx: 240 + Math.random() * 200, vy: 110 + Math.random() * 90,
          life: 0, max: 1.5
        });
        nextStreakAt = now + 3000 + Math.random() * 3600;
      }
      for (j = streaks.length - 1; j >= 0; j--) {
        var st = streaks[j];
        st.life += dt;
        var k = st.life / st.max;
        if (k >= 1 || st.x > W + 80 || st.y > H + 80) { streaks.splice(j, 1); continue; }
        var tailX = st.x - st.vx * 0.24, tailY = st.y - st.vy * 0.24;
        var gr = ctx.createLinearGradient(st.x, st.y, tailX, tailY);
        var fade = Math.sin(Math.PI * Math.min(1, k)) * 0.9 * fadeIn;
        gr.addColorStop(0, 'rgba(209,250,229,' + fade.toFixed(3) + ')');
        gr.addColorStop(1, 'rgba(34,197,94,0)');
        ctx.strokeStyle = gr;
        ctx.lineWidth = 2.0;
        ctx.beginPath();
        ctx.moveTo(st.x, st.y);
        ctx.lineTo(tailX, tailY);
        ctx.stroke();
        st.x += st.vx * dt; st.y += st.vy * dt;
      }

      ctx.globalCompositeOperation = 'source-over';
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { initFaceMat(); initParticles(); });
  } else {
    initFaceMat();
    initParticles();
  }

  console.log(
    '%c [PivotAI] %c Star Cosmos engine active (LobeHub 2.x) ',
    'background:#16A34A;color:#fff;border-radius:4px;padding:2px 6px;font-weight:bold;',
    'background:#34D399;color:#000;border-radius:4px;padding:2px 6px;font-weight:bold;'
  );
  } catch (err) { /* PivotAI engine must never break the app */ }
})();
