// Force-directed network on a canvas, built on the vendored d3 (window.d3).
// Positions persist across redraws, so a filter change or the history playback
// grows the map in place instead of reshuffling it.

const TAU = Math.PI * 2;

export function createNetwork(host, { onSelect = () => {}, onHover = () => {}, label = 'Network' } = {}) {
  const d3 = window.d3;
  const canvas = document.createElement('canvas');
  canvas.className = 'net-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', label);
  host.append(canvas);
  const ctx2d = canvas.getContext('2d');
  const positions = new Map();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0, height = 0, dpr = 1, transform = d3.zoomIdentity;
  let nodes = [], links = [], byId = new Map(), adjacency = new Map();
  let style = {}, opts = {}, selected = null, hovered = null, frame = 0, fitted = false;
  const sim = d3.forceSimulation().alphaDecay(0.03).velocityDecay(0.35).stop();

  const radius = n => n._r;
  function readColors() {
    const css = getComputedStyle(host);
    const v = name => css.getPropertyValue(name).trim();
    style = { surface: v('--surface-1') || '#fff', ink: v('--text-primary') || '#111', soft: v('--text-secondary') || '#555',
      edge: v('--net-edge') || '#999', newInk: v('--net-new') || '#111', muted: v('--net-muted') || '#bbb' };
  }

  function resize() {
    const box = host.getBoundingClientRect();
    width = Math.max(200, box.width); height = Math.max(240, box.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    if (!fitted && nodes.length) fit(false);
    draw();
  }
  const observer = new ResizeObserver(() => resize());
  observer.observe(host);
  resize();

  function schedule() { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); }); }

  function shape(n, r) {
    const x = n.x, y = n.y;
    ctx2d.beginPath();
    if (n._shape === 'square') ctx2d.rect(x - r * 0.88, y - r * 0.88, r * 1.76, r * 1.76);
    else if (n._shape === 'diamond') { ctx2d.moveTo(x, y - r * 1.2); ctx2d.lineTo(x + r * 1.2, y); ctx2d.lineTo(x, y + r * 1.2); ctx2d.lineTo(x - r * 1.2, y); ctx2d.closePath(); }
    else ctx2d.arc(x, y, r, 0, TAU);
  }

  function draw() {
    if (!width) return;
    const k = transform.k;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.fillStyle = style.surface;
    ctx2d.fillRect(0, 0, width, height);
    ctx2d.translate(transform.x, transform.y);
    ctx2d.scale(k, k);
    const focus = selected || hovered;
    const near = focus ? adjacency.get(focus.id) || new Set() : null;
    const maxW = opts.maxWeight || 1;

    // Links: recessive by default; new ones in ink, focused ones stronger.
    for (const l of links) {
      const on = focus && (l.source === focus || l.target === focus);
      const dim = focus && !on;
      const w = 0.6 + 2.4 * Math.sqrt(l.weight / maxW);
      ctx2d.globalAlpha = dim ? 0.06 : on ? 0.9 : l.isNew && opts.showNew ? 0.85 : 0.18 + 0.4 * (l.weight / maxW);
      ctx2d.strokeStyle = l.isNew && opts.showNew ? style.newInk : on ? style.soft : style.edge;
      ctx2d.lineWidth = (l.isNew && opts.showNew ? Math.max(w, 1.6) : w) / Math.sqrt(k);
      if (l.isNew && opts.showNew) ctx2d.setLineDash([4 / k, 3 / k]); else ctx2d.setLineDash([]);
      ctx2d.beginPath(); ctx2d.moveTo(l.source.x, l.source.y); ctx2d.lineTo(l.target.x, l.target.y); ctx2d.stroke();
    }
    ctx2d.setLineDash([]);

    // Nodes: fill, 2px surface ring so overlaps stay legible, ink ring when new.
    for (const n of nodes) {
      const dim = focus && n !== focus && !near.has(n.id);
      const r = radius(n);
      ctx2d.globalAlpha = dim ? 0.18 : 1;
      shape(n, r);
      ctx2d.fillStyle = n._fill;
      ctx2d.fill();
      ctx2d.lineWidth = 2 / k;
      ctx2d.strokeStyle = style.surface;
      ctx2d.stroke();
      if (n._hollow) { shape(n, Math.max(r - 3 / k, r * 0.45)); ctx2d.fillStyle = style.surface; ctx2d.fill(); }
      if ((n.isNew && opts.showNew) || n === selected) {
        shape(n, r + 3.5 / k);
        ctx2d.lineWidth = (n === selected ? 2.5 : 1.6) / k;
        ctx2d.strokeStyle = style.newInk;
        ctx2d.stroke();
      }
    }

    // Labels: biggest first, skipping any that would overlap one already drawn; the focus
    // and its neighbours go first so they are never the ones dropped.
    ctx2d.globalAlpha = 1;
    ctx2d.textAlign = 'center';
    ctx2d.textBaseline = 'top';
    const font = 11.5 / k;
    ctx2d.font = `500 ${font}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx2d.lineJoin = 'round';
    const rank = n => (n === focus ? 3 : near && near.has(n.id) ? 2 : n._labelAlways ? 1 : 0) * 1e6 + radius(n);
    const placed = [];
    for (const n of [...nodes].sort((a, b) => rank(b) - rank(a))) {
      const r = radius(n);
      const show = n === focus || (near && near.has(n.id) && (n._labelAlways || r * k > 5)) || (!focus && (r * k >= (opts.labelAt || 11) || n._labelAlways));
      if (!show) continue;
      let text = n._label;
      if (text.length > 42) text = text.slice(0, 40) + '…';
      const w = ctx2d.measureText(text).width, x0 = n.x - w / 2, y0 = n.y + r + 3 / k, h = font * 1.25;
      if (n !== focus && placed.some(b => x0 < b[2] && x0 + w > b[0] && y0 < b[3] && y0 + h > b[1])) continue;
      placed.push([x0 - 2 / k, y0, x0 + w + 2 / k, y0 + h]);
      ctx2d.lineWidth = 3.2 / k;
      ctx2d.strokeStyle = style.surface;
      ctx2d.strokeText(text, n.x, y0);
      ctx2d.fillStyle = n === focus ? style.ink : style.soft;
      ctx2d.fillText(text, n.x, y0);
    }
  }

  // ---- interaction -------------------------------------------------------------
  const toGraph = (x, y) => transform.invert([x, y]);
  function nodeAt(x, y) {
    const [gx, gy] = toGraph(x, y);
    let best = null, bestD = Infinity;
    for (const n of nodes) {
      const d = Math.hypot(n.x - gx, n.y - gy);
      if (d < Math.max(radius(n) + 4 / transform.k, 9 / transform.k) && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }
  const zoom = d3.zoom().scaleExtent([0.15, 8])
    .filter(e => (e.type === 'wheel' || e.type.startsWith('touch') || !nodeAt(...d3.pointer(e, canvas))) && !e.button)
    .on('zoom', e => { transform = e.transform; schedule(); });
  const drag = d3.drag().container(canvas)
    .subject(e => { const n = nodeAt(e.x, e.y); return n ? { node: n, x: e.x, y: e.y } : null; })
    .on('start', e => { e.subject.moved = false; if (!e.active && !reduce.matches) sim.alphaTarget(0.15).restart(); const n = e.subject.node; n.fx = n.x; n.fy = n.y; })
    .on('drag', e => { e.subject.moved = true; const [gx, gy] = toGraph(e.x, e.y); const n = e.subject.node; n.fx = gx; n.fy = gy; n.x = gx; n.y = gy; schedule(); })
    .on('end', e => {
      sim.alphaTarget(0);
      const n = e.subject.node;
      if (!e.subject.moved) { n.fx = null; n.fy = null; select(n.id, true); }
      else positions.set(n.id, { x: n.x, y: n.y });
    });
  d3.select(canvas).call(drag).call(zoom).on('dblclick.zoom', null);
  canvas.addEventListener('click', e => { if (!nodeAt(e.offsetX, e.offsetY) && selected) select(null, true); });
  canvas.addEventListener('pointermove', e => {
    const n = nodeAt(e.offsetX, e.offsetY);
    canvas.style.cursor = n ? 'pointer' : 'grab';
    if (n !== hovered) { hovered = n; onHover(n, e); schedule(); } else if (n) onHover(n, e);
  });
  canvas.addEventListener('pointerleave', () => { if (hovered) { hovered = null; onHover(null); schedule(); } });

  sim.on('tick', () => {
    for (const n of nodes) positions.set(n.id, { x: n.x, y: n.y });
    if (!fitted && sim.alpha() < 0.25) fit(false);
    schedule();
  });

  function fit(animate = true) {
    if (!nodes.length || !width || !host.isConnected) return;
    fitted = true;
    const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pad = 46;
    const k = Math.min(2.2, Math.max(0.15, Math.min((width - pad * 2) / Math.max(1, x1 - x0), (height - pad * 2) / Math.max(1, y1 - y0))));
    const t = d3.zoomIdentity.translate(width / 2 - k * (x0 + x1) / 2, height / 2 - k * (y0 + y1) / 2).scale(k);
    const sel = d3.select(canvas);
    if (animate && !reduce.matches) sel.transition().duration(450).call(zoom.transform, t); else sel.call(zoom.transform, t);
  }

  function select(id, fromUser = false) {
    selected = id ? byId.get(id) || null : null;
    schedule();
    if (fromUser) onSelect(selected);
  }

  /**
   * graph: {nodes, links}; look: {fill(n), shape(n), size(n), label(n), hollow(n), labelAlways(n), showNew}
   */
  function render(graph, look) {
    readColors();
    opts = look;
    const prevSelected = selected?.id;
    nodes = graph.nodes.map(n => ({ ...n }));
    byId = new Map(nodes.map(n => [n.id, n]));
    links = graph.links.filter(l => byId.has(l.source) && byId.has(l.target)).map(l => ({ ...l, source: byId.get(l.source), target: byId.get(l.target) }));
    adjacency = new Map(nodes.map(n => [n.id, new Set()]));
    for (const l of links) { adjacency.get(l.source.id).add(l.target.id); adjacency.get(l.target.id).add(l.source.id); }
    opts.maxWeight = Math.max(1, ...links.map(l => l.weight));
    const maxCount = Math.max(1, ...nodes.map(n => n.count));
    let known = 0;
    for (const n of nodes) {
      n._r = look.size ? look.size(n, maxCount) : 4 + 14 * Math.sqrt(n.count / maxCount);
      n._fill = look.fill(n); n._shape = look.shape ? look.shape(n) : 'circle';
      n._label = look.label ? look.label(n) : n.label; n._hollow = look.hollow ? look.hollow(n) : false;
      n._labelAlways = look.labelAlways ? look.labelAlways(n) : false;
      const p = positions.get(n.id);
      if (p) { n.x = p.x; n.y = p.y; known++; }
    }
    // New nodes start next to a neighbour that already has a place.
    for (const n of nodes) if (n.x == null) {
      const anchor = [...adjacency.get(n.id)].map(id => byId.get(id)).find(m => m.x != null);
      const a = Math.random() * TAU, d = 20 + Math.random() * 30;
      n.x = (anchor ? anchor.x : 0) + Math.cos(a) * d; n.y = (anchor ? anchor.y : 0) + Math.sin(a) * d;
    }
    // Bigger graphs need more room: stronger repulsion, longer and softer links.
    const big = Math.min(1, nodes.length / 120);
    const linkDist = l => 30 + 30 * big + radius(l.source) + radius(l.target) + 40 / Math.sqrt(l.weight);
    sim.nodes(nodes)
      .force('link', d3.forceLink(links).id(n => n.id).distance(linkDist).strength(l => Math.min(0.7, 0.04 + (0.5 - 0.3 * big) * Math.sqrt(l.weight / opts.maxWeight))))
      .force('charge', d3.forceManyBody().strength(n => -(30 + 40 * big) - (5 + 6 * big) * radius(n)).distanceMax(600))
      .force('collide', d3.forceCollide(n => radius(n) + 3).iterations(2))
      .force('x', d3.forceX(0).strength(0.045)).force('y', d3.forceY(0).strength(0.045));
    const fresh = known < nodes.length * 0.5;
    if (fresh) { fitted = false; sim.alpha(1); sim.tick(reduce.matches ? 300 : 90); }
    else sim.alpha(Math.min(0.5, 0.12 + (nodes.length - known) / Math.max(10, nodes.length)));
    selected = prevSelected ? byId.get(prevSelected) || null : null;
    if (reduce.matches) { sim.tick(200); sim.stop(); for (const n of nodes) positions.set(n.id, { x: n.x, y: n.y }); fit(false); draw(); }
    else sim.restart();
    if (fresh && !reduce.matches) { fit(false); }
    draw();
  }

  function center(id) {
    const n = byId.get(id);
    if (!n) return;
    const k = Math.max(transform.k, 1.2);
    d3.select(canvas).transition().duration(reduce.matches ? 0 : 400).call(zoom.transform, d3.zoomIdentity.translate(width / 2 - k * n.x, height / 2 - k * n.y).scale(k));
  }

  function find(text) {
    const q = String(text || '').toLowerCase().trim();
    if (!q) return null;
    const hit = nodes.filter(n => n._label.toLowerCase().includes(q)).sort((a, b) => b.count - a.count)[0];
    if (hit) {
      select(hit.id, true);
      const k = Math.max(transform.k, 1.4);
      d3.select(canvas).transition().duration(reduce.matches ? 0 : 400).call(zoom.transform, d3.zoomIdentity.translate(width / 2 - k * hit.x, height / 2 - k * hit.y).scale(k));
    }
    return hit;
  }

  return {
    render, select, find, fit, resize, center,
    neighbours: id => [...(adjacency.get(id) || [])].map(x => byId.get(x)),
    linksOf: id => links.filter(l => l.source.id === id || l.target.id === id),
    node: id => byId.get(id),
    stop: () => sim.stop(),
    destroy: () => { sim.stop(); observer.disconnect(); canvas.remove(); },
  };
}
