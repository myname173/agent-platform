/**
 * PivotAI Dynamic Cyber Engine — LobeHub 2.x Edition
 * Brand: PivotAI  |  Slogan: 从对话到执行 / Chat less. Ship more.
 * Colors: Primary #3B82F6 · Accent #06B6D4
 * Capabilities:
 *   - 60fps fluid aurora mesh with Lerp mouse parallax (Canvas, GPU-friendly)
 *   - Live brand & slogan replacement ("PivotAI")
 *   - Floating brand indicator widget (top-right, glowing status dot)
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

  /* ---- 2. Aurora canvas with Lerp mouse parallax ---- */
  function initAurora() {
    if (REDUCED) return; // respect reduced motion (static CSS wash remains)
    var canvas = document.getElementById('pivot-aurora-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'pivot-aurora-canvas';
      (document.body || document.documentElement).appendChild(canvas);
    }
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = 0, H = 0;
    function resize() {
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    // 4 organic blobs: blue / cyan / indigo / violet family
    var blobs = [
      { hue: 'rgba(59,130,246,', base: 0.55, r: 0.42, x: 0.22, y: 0.28, sx: 0.9, sy: 0.7, px: 26, py: 18, dx: 0.0, dy: 0.0 },
      { hue: 'rgba(6,182,212,',  base: 0.5,  r: 0.36, x: 0.78, y: 0.24, sx: 0.7, sy: 0.9, px: -30, py: 22, dx: 0.0, dy: 0.0 },
      { hue: 'rgba(99,102,241,', base: 0.4,  r: 0.44, x: 0.68, y: 0.78, sx: 1.1, sy: 0.8, px: 18, py: -26, dx: 0.0, dy: 0.0 },
      { hue: 'rgba(34,211,238,', base: 0.38, r: 0.3,  x: 0.28, y: 0.76, sx: 0.8, sy: 1.0, px: -22, py: -18, dx: 0.0, dy: 0.0 }
    ];

    var mouse = { x: 0, y: 0 }, target = { x: 0, y: 0 };
    window.addEventListener('pointermove', function (e) {
      target.x = (e.clientX / W - 0.5) * 2;
      target.y = (e.clientY / H - 0.5) * 2;
    }, { passive: true });

    var t0 = performance.now();
    function frame(now) {
      var t = ((now || performance.now()) - t0) / 1000;
      // lerp mouse for smooth depth parallax
      mouse.x += (target.x - mouse.x) * 0.045;
      mouse.y += (target.y - mouse.y) * 0.045;

      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < blobs.length; i++) {
        var b = blobs[i];
        var bx = (b.x + Math.sin(t * b.sx * 0.12 + i * 1.7) * 0.08) * W;
        var by = (b.y + Math.cos(t * b.sy * 0.1 + i * 2.3) * 0.07) * H;
        // parallax offset (deeper blobs move more)
        var depth = 0.4 + (i % 3) * 0.3;
        bx += mouse.x * b.px * depth;
        by += mouse.y * b.py * depth;
        var rr = b.r * Math.min(W, H) * (1 + Math.sin(t * 0.18 + i) * 0.06);
        var g = ctx.createRadialGradient(bx, by, 0, bx, by, rr);
        var a = b.base * (0.85 + Math.sin(t * 0.25 + i * 1.1) * 0.15);
        g.addColorStop(0, b.hue + a.toFixed(3) + ')');
        g.addColorStop(1, b.hue + '0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(bx, by, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAurora);
  } else {
    initAurora();
  }

  console.log(
    '%c [PivotAI] %c Cyber Glassmorphism & Aurora active (LobeHub 2.x) ',
    'background:#3B82F6;color:#fff;border-radius:4px;padding:2px 6px;font-weight:bold;',
    'background:#06B6D4;color:#000;border-radius:4px;padding:2px 6px;font-weight:bold;'
  );
  } catch (err) { /* PivotAI engine must never break the app */ }
})();
