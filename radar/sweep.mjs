// Radar sweep behind the Latest page title: a dot grid, and a beam turning around a
// point on the right that lights the dots it passes (they fade out behind it).
// Colours come from the --dot and --hot tokens ("r,g,b"), read when the band mounts,
// so a theme change (which re-renders the page) picks up the new colours.
// The loop stops when the canvas leaves the page, is scrolled out of view or the tab
// is hidden. With "reduce motion", the beam is drawn once, standing still.
const GAP = 20, TURN = 9000; // px between dots, ms per turn of the beam

export function mountSweeps(root = document) {
  for (const canvas of root.querySelectorAll('canvas.sweep-field:not([data-on])')) mount(canvas);
}

function mount(canvas) {
  canvas.dataset.on = '1';
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(canvas);
  const DOT = css.getPropertyValue('--dot').trim() || '134,139,148';
  const HOT = css.getPropertyValue('--hot').trim() || '123,140,255';
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let w = 0, h = 0, raf = 0, visible = true;

  const draw = now => {
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    const cx = w * 0.84, cy = h * 0.55, reach = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
    const beam = still.matches ? 300 : (now / TURN * 360) % 360; // degrees, clockwise from 12 o'clock
    for (let y = GAP / 2; y < h; y += GAP) {
      for (let x = GAP / 2; x < w; x += GAP) {
        const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
        const fade = Math.min(1, Math.max(0.12, (x / w - 0.2) / 0.5)); // quieter behind the title text
        const phi = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
        const behind = ((beam - phi) % 360 + 360) % 360;              // degrees since the beam passed
        const k = behind < 110 ? Math.pow(1 - behind / 110, 2.2) * (1 - d / reach * 0.6) : 0;
        const r = 0.8 + k * 1.6;
        ctx.fillStyle = k > 0.03 ? `rgba(${HOT},${(0.25 + 0.7 * k) * fade})` : `rgba(${DOT},${0.32 * fade})`;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
    }
    // The beam itself: a thin line from the centre, and two range rings
    ctx.strokeStyle = `rgba(${HOT},${0.18})`;
    ctx.lineWidth = 1;
    for (const f of [0.18, 0.36]) { ctx.beginPath(); ctx.arc(cx, cy, reach * f, 0, Math.PI * 2); ctx.stroke(); }
    const a = (beam - 90) * Math.PI / 180;
    ctx.strokeStyle = `rgba(${HOT},0.55)`;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * reach, cy + Math.sin(a) * reach); ctx.stroke();
  };
  const loop = now => {
    raf = 0;
    if (!canvas.isConnected) return;
    draw(now);
    if (visible && !still.matches && !document.hidden) raf = requestAnimationFrame(loop);
  };
  const onMotion = () => { size(); kick(); };
  const kick = () => {
    if (!canvas.isConnected) { document.removeEventListener('visibilitychange', kick); still.removeEventListener('change', onMotion); return; }
    if (!raf) raf = requestAnimationFrame(loop);
  };
  const size = () => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(performance.now());
  };
  new ResizeObserver(size).observe(canvas);
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) kick(); }).observe(canvas);
  document.addEventListener('visibilitychange', kick);
  still.addEventListener('change', onMotion);
  size();
  kick();
}
