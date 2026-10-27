/**
 * PivotAI Dynamic Cyber Engine
 * Brand: PivotAI
 * Slogan: 从对话到执行 / Chat less. Ship more.
 * Colors: Primary #3B82F6, Accent #06B6D4
 * Capabilities:
 *   - 60fps Fluid Aurora Mesh with Lerp Mouse Parallax
 *   - Live Brand & Slogan Replacement ("PivotAI")
 *   - Floating Brand Indicator Widget
 *   - Message Bubble & Focus Enhancer
 */

(function () {
  if (typeof window === 'undefined') return;
  if (window.__PIVOT_AI_INITIALIZED__) return;
  window.__PIVOT_AI_INITIALIZED__ = true;

  console.log(
    '%c [PivotAI] %c Cyber Glassmorphism & Aurora Active! ',
    'background: #3B82F6; color: white; border-radius: 4px; padding: 2px 6px; font-weight: bold;',
    'background: #06B6D4; color: black; border-radius: 4px; padding: 2px 6px; font-weight: bold;'
  );

  /* --- 1. Dynamic Title & Branding Guard --- */
  const BRAND_NAME = 'PivotAI';
  const BRAND_SLOGAN = '从对话到执行 / Chat less. Ship more.';
  const FULL_TITLE = 'PivotAI - 从对话到执行 | Chat less. Ship more.';

  function updateTitle() {
    if (document.title !== FULL_TITLE) {
      document.title = FULL_TITLE;
    }
  }
  updateTitle();
  setInterval(updateTitle, 2500);

  /* --- 2. Live DOM Branding Replacement --- */
  function replaceBrandText() {
    updateTitle();

    // 1. Text node replacements for headings/titles
    const walk = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );

    let n;
    while ((n = walk.nextNode())) {
      if (n.nodeValue && (n.nodeValue.includes('LobeChat') || n.nodeValue.includes('LobeHub'))) {
        n.nodeValue = n.nodeValue
          .replace(/LobeChat/g, BRAND_NAME)
          .replace(/LobeHub/g, BRAND_NAME);
      }
    }

    // 2. Floating Top-Right Brand Badge if not present
    if (!document.getElementById('pivot-brand-widget')) {
      const widget = document.createElement('div');
      widget.id = 'pivot-brand-widget';
      widget.className = 'pivot-brand-header';
      widget.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 8px; height: 8px; border-radius: 50%; background: #06B6D4; box-shadow: 0 0 10px #06B6D4; animation: pivotAiPulse 3s infinite;"></div>
          <span style="font-weight: 800; font-size: 14px; background: linear-gradient(135deg, #60A5FA 0%, #22D3EE 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; letter-spacing: -0.01em;">${BRAND_NAME}</span>
          <span style="font-size: 11px; color: #94A3B8; border-left: 1px solid rgba(59, 130, 246, 0.3); padding-left: 8px; font-weight: 400;">从对话到执行</span>
        </div>
      `;
      document.body.appendChild(widget);
    }
  }

  setTimeout(replaceBrandText, 600);
  const observer = new MutationObserver(() => {
    replaceBrandText();
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    window.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  /* --- 3. 60fps Fluid Aurora Canvas with Lerp Mouse Parallax --- */
  function initAuroraCanvas() {
    let canvas = document.getElementById('pivot-aurora-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'pivot-aurora-canvas';
      document.body.prepend(canvas);
    }

    const ctx = canvas.getContext('2d');
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    window.addEventListener('resize', () => {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    });

    // Mouse coordinates with smooth lerp interpolation
    let mouseX = width / 2;
    let mouseY = height / 2;
    let targetMouseX = mouseX;
    let targetMouseY = mouseY;

    window.addEventListener('mousemove', (e) => {
      targetMouseX = e.clientX;
      targetMouseY = e.clientY;
    });

    // 4 Organic Floating Aurora Blobs (Primary #3B82F6, Accent #06B6D4, Indigo, Sky Blue)
    const blobs = [
      {
        x: width * 0.18,
        y: height * 0.22,
        radius: 460,
        color: 'rgba(6, 182, 212, 0.22)',
        speedX: 0.0008,
        speedY: 0.0006,
        phase: 0
      },
      {
        x: width * 0.82,
        y: height * 0.32,
        radius: 540,
        color: 'rgba(59, 130, 246, 0.24)',
        speedX: 0.0006,
        speedY: 0.0008,
        phase: 2
      },
      {
        x: width * 0.48,
        y: height * 0.78,
        radius: 580,
        color: 'rgba(99, 102, 241, 0.18)',
        speedX: 0.0007,
        speedY: 0.0005,
        phase: 4
      },
      {
        x: width * 0.72,
        y: height * 0.68,
        radius: 420,
        color: 'rgba(2, 132, 199, 0.2)',
        speedX: 0.0009,
        speedY: 0.0007,
        phase: 1.5
      }
    ];

    const startTime = Date.now();

    function render() {
      const now = Date.now();
      const elapsed = (now - startTime) * 0.001;

      // Smooth lerp interpolation for 60fps buttery mouse parallax
      mouseX += (targetMouseX - mouseX) * 0.04;
      mouseY += (targetMouseY - mouseY) * 0.04;

      const parallaxOffsetX = (mouseX / width - 0.5) * 65;
      const parallaxOffsetY = (mouseY / height - 0.5) * 65;

      ctx.clearRect(0, 0, width, height);

      blobs.forEach((b, i) => {
        const cx = b.x + Math.sin(elapsed * b.speedX * 1000 + b.phase) * 85 + parallaxOffsetX * (1 + i * 0.25);
        const cy = b.y + Math.cos(elapsed * b.speedY * 1000 + b.phase) * 75 + parallaxOffsetY * (1 + i * 0.25);

        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, b.radius);
        grad.addColorStop(0, b.color);
        grad.addColorStop(0.5, b.color.replace(/[\d\.]+\)$/, '0.07)'));
        grad.addColorStop(1, 'rgba(3, 7, 18, 0)');

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, b.radius, 0, Math.PI * 2);
        ctx.fill();
      });

      requestAnimationFrame(render);
    }

    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuroraCanvas);
  } else {
    initAuroraCanvas();
  }
})();
