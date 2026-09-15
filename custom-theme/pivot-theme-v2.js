/**
 * PivotAI Dynamic Cyber Engine — LobeHub 2.x Edition (v4 "star cosmos")
 * Brand: PivotAI  |  Slogan: 从对话到执行 / Chat less. Ship more.
 * Colors: Primary #3B82F6 · Accent #06B6D4
 * Layers (deepest → top): AI face mat → faint milky band + grain → star field.
 * Capabilities:
 *   - Star universe: depth-tiered stars (near big/fast, far small/slow), twinkle,
 *     blue-white + rare warm stars, constellation links, cursor interact,
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
        '<span style="font-weight:800;font-size:14px;background:linear-gradient(135deg,#60A5FA 0%,#22D3EE 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-0.01em;">' +
        BRAND_NAME +
        '</span>' +
        '<span style="font-size:11px;color:#94A3B8;border-left:1px solid rgba(59,130,246,0.3);padding-left:8px;font-weight:400;">' +
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
  function initFaceMat() {
    if (!document.body || document.getElementById('pivot-face-mat')) return;
    var mat = document.createElement('div');
    mat.id = 'pivot-face-mat';
    var first = document.getElementById('pivot-particle-canvas');
    if (first && first.parentNode) first.parentNode.insertBefore(mat, first);
    else document.body.appendChild(mat);
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
        var hue = cr < 0.09 ? 3 : (cr < 0.64 ? 0 : (cr < 0.90 ? 1 : 2)); // blue / cyan / violet / rare warm
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
      g.addColorStop(0, 'rgba(80,110,190,0)');
      g.addColorStop(0.5, 'rgba(96,130,210,0.05)');
      g.addColorStop(1, 'rgba(80,110,190,0)');
      c.fillStyle = g;
      c.fillRect(-bw * 0.9, -bh * 0.34, bw * 1.8, bh * 0.68);
      for (var i = 0; i < 9; i++) {
        var bx = -bw * 0.8 + bw * 1.6 * (i / 8);
        var by = Math.sin(i * 2.7) * bh * 0.18;
        var rr = bh * (0.10 + 0.12 * Math.abs(Math.sin(i * 1.3)));
        var rg = c.createRadialGradient(bx, by, 0, bx, by, rr);
        rg.addColorStop(0, 'rgba(120,150,230,0.045)');
        rg.addColorStop(1, 'rgba(120,150,230,0)');
        c.fillStyle = rg;
        c.beginPath(); c.arc(bx, by, rr, 0, 6.283); c.fill();
      }
      c.restore();
      for (var y = 0; y < bh; y += 3) for (var x = 0; x < bw; x += 3) {
        if (Math.random() < 0.5) continue;
        c.fillStyle = 'rgba(190,210,255,' + (Math.random() * 0.05).toFixed(3) + ')';
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
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.3, 'rgba(220,240,255,0.5)');
      g.addColorStop(1, 'rgba(150,200,255,0)');
      c2.fillStyle = g;
      c2.fillRect(0, 0, 64, 64);
      return s;
    })();
    var HUES = [
      ['rgba(147,197,253,', 'rgba(96,165,250,'],
      ['rgba(103,232,249,', 'rgba(34,211,238,'],
      ['rgba(196,181,253,', 'rgba(167,139,250,'],
      ['rgba(253,230,190,', 'rgba(245,200,150,']
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
            a = (1 - d / LINK) * 0.18 * ((p.bright + q.bright) * 0.5);
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
          a = (1 - d / 170) * 0.30;
          ctx.strokeStyle = 'rgba(103,232,249,' + a.toFixed(3) + ')';
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
        a = 0.62 * p.bright * (0.30 + 0.70 * (0.5 + 0.5 * Math.sin(now * 0.0026 * p.tw + p.ph))) * fadeIn;
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
        gr.addColorStop(0, 'rgba(186,230,253,' + fade.toFixed(3) + ')');
        gr.addColorStop(1, 'rgba(59,130,246,0)');
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
    'background:#3B82F6;color:#fff;border-radius:4px;padding:2px 6px;font-weight:bold;',
    'background:#06B6D4;color:#000;border-radius:4px;padding:2px 6px;font-weight:bold;'
  );
  } catch (err) { /* PivotAI engine must never break the app */ }
})();
