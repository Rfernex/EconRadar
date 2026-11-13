// Focus tab: one literature followed in depth (radar/focus.json, data/focus-<area>.json).
// Loaded by app.mjs only on devices where the tab was switched on (open the app with #focus).
import * as FC from './focus-core.mjs?v=4';

let A = null; // helpers handed over by app.mjs
const st = { F: null, spec: null, updated: '', f: null, tab: 'overview', limit: 40, net: null, upTo: 0, maxNodes: 250, shared: true, selected: null, play: 0, loading: null, bound: false };
const KEYS = { filters: 'radar.focus.filters.v1', tab: 'radar.focus.tab.v1' };
const TABS = { overview: 'Overview', papers: 'Papers', map: 'Citation map', authors: 'Authors' };

const esc = s => A.esc(s), fmt = n => A.fmt(n), plural = (n, a, b) => A.plural(n, a, b);
const strandVar = key => { const c = st.F.strands.get(key)?.color; return c ? `var(--series-${c})` : 'var(--series-other)'; };
const strandColor = key => { const c = st.F.strands.get(key)?.color; return getComputedStyle(document.documentElement).getPropertyValue(c ? `--series-${c}` : '--series-other').trim(); };
const strandLabel = key => st.F.strands.get(key)?.label || key;
const outcomeLabel = key => st.F.outcomes.get(key)?.label || key;
const dot = key => `<i class="dot" style="background:${strandVar(key)}" aria-hidden="true"></i>`;
const yearOf = p => p.year || '';

async function load() {
  const cfg = await A.getJSON('focus.json');
  const spec = cfg.areas?.[0];
  if (!spec) throw new Error('focus.json lists no area');
  const data = await A.getJSON(`data/focus-${spec.key}.json`).catch(() => ({ papers: [] }));
  st.spec = spec; st.updated = data.updated || '';
  st.F = FC.prepareFocus(data, spec, { radar: A.S.papers, ctx: A.S.ctx });
  A.getJSON(`data/focus-${spec.key}-abstracts.json`).then(abs => FC.attachAbstracts(st.F, abs)).catch(() => {});
  st.f = FC.cleanFocusFilters(A.local.get(KEYS.filters, {}), spec);
  st.tab = TABS[A.local.get(KEYS.tab, 'overview')] ? A.local.get(KEYS.tab, 'overview') : 'overview';
  st.upTo = 0;
}

export async function show(main, api) {
  A = api;
  if (!st.F) {
    main.innerHTML = '<div class="empty"><p class="muted">Loading the focus area…</p></div>';
    try { st.loading ||= load(); await st.loading; }
    catch (e) { st.loading = null; main.innerHTML = `<div class="empty"><h2>The focus area could not load</h2><p>${esc(e.message)}</p></div>`; return; }
  }
  if (!st.bound) bindDialog();
  render();
}
export function leave() { stopPlay(); if (st.net) { st.net.destroy(); st.net = null; } }

function setF(mut, { keepTab = true } = {}) {
  mut(st.f); st.f = FC.cleanFocusFilters(st.f, st.spec); A.local.set(KEYS.filters, st.f); st.limit = 40;
  if (!keepTab) st.tab = 'papers';
  render();
}
function setTab(tab) { st.tab = tab; A.local.set(KEYS.tab, tab); render(); window.scrollTo(0, 0); }

// ---- layout ---------------------------------------------------------------------------
function render() {
  const main = A.$('#main');
  if (st.tab !== 'map') leave();
  const list = FC.filterFocus(st.F, st.f, { user: A.S.user });
  const total = st.F.papers.length;
  A.$('#top-count').textContent = list.length === total ? plural(total, 'paper') : `${fmt(list.length)} of ${plural(total, 'paper')}`;
  const body = { overview: overviewHtml, papers: papersHtml, map: () => mapShellHtml(list), authors: authorsHtml }[st.tab](list);
  main.innerHTML = `<div id="focus-root">
    <div class="heading"><div><span class="eyebrow">Focus · personal${st.updated ? ' · updated ' + A.dayLabel(st.updated) : ''}</span><h1>${esc(st.spec.title)}</h1>
      <p>${plural(total, 'paper')} published since ${A.dayLabel(st.spec.since, { month: 'long', year: 'numeric' })}, from any journal, working-paper series or book indexed by OpenAlex, plus matching papers from the radar. ${list.length !== total ? `<b>${fmt(list.length)}</b> in view${st.f.all ? '' : ' (established venues only: core journals, known working-paper series, papers cited 5+ times; switch on <i>All venues</i> to see the rest)'}.` : ''}</p></div>
      <div class="seg" role="group" aria-label="Focus view">${Object.entries(TABS).map(([k, l]) => `<button type="button" data-ftab="${k}" aria-pressed="${st.tab === k}">${l}</button>`).join('')}</div></div>
    ${filtersHtml()}
    <div id="focus-body">${body}</div>
    <p class="small muted" style="margin-top:28px">This tab is only shown on devices where it was switched on. <button type="button" class="text-btn" data-f="hide">Hide it on this device</button></p>
  </div>`;
  const root = A.$('#focus-root');
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  if (st.tab === 'map') drawMap(list, true);
}

function counts(key) { const o = {}; for (const p of st.F.papers) for (const k of [].concat(p[key])) o[k] = (o[k] || 0) + 1; return o; }
function pick(key, label, options) {
  const n = st.f[key].length;
  return `<details class="pick ${n ? 'on' : ''}" data-pick="f-${key}"><summary>${esc(label)} <b ${n ? '' : 'hidden'}>${n}</b></summary><div class="pick-panel"><div class="pick-group">${options.map(o => `<label class="pick-opt"><input type="checkbox" data-ff="${key}" value="${esc(o.value)}" ${st.f[key].includes(o.value) ? 'checked' : ''}>${o.dot || ''}<span>${esc(o.label)}</span><span class="n">${o.count ? fmt(o.count) : ''}</span></label>`).join('')}</div></div></details>`;
}
function filtersHtml() {
  const f = st.f, sN = counts('strands'), oN = counts('outcomes'), dN = counts('disc'), kN = counts('kind');
  const years = st.F.papers.map(p => p.year).filter(Boolean), y0 = Math.min(...years, new Date().getFullYear()), y1 = Math.max(...years, y0);
  const yearOpts = (sel, none) => `<option value="0">${none}</option>` + Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i).map(y => `<option ${sel === y ? 'selected' : ''}>${y}</option>`).join('');
  const mN = counts('methods');
  const methods = A.S.config.methods.filter(m => mN[m.key]).sort((a, b) => mN[b.key] - mN[a.key]).map(m => ({ value: m.key, label: m.label, count: mN[m.key] }));
  const chips = [];
  const chip = (kind, value, text, d = '') => chips.push(`<span class="chip removable">${d}${esc(text)}<button type="button" data-fremove="${kind}" data-value="${esc(value)}" aria-label="Remove ${esc(text)}">×</button></span>`);
  if (f.q) chip('q', '', `“${f.q}”`);
  f.outcomes.forEach(k => chip('outcomes', k, outcomeLabel(k)));
  f.disc.forEach(k => chip('disc', k, k));
  f.kinds.forEach(k => chip('kinds', k, FC.KINDS[k]));
  f.methods.forEach(k => chip('methods', k, A.S.ctx.label('method', k)));
  if (f.from || f.to) chip('years', '', `${f.from || '…'}–${f.to || '…'}`);
  if (f.author) chip('author', '', 'Author: ' + (FC.focusAuthors(st.F.papers).find(a => a.key === f.author)?.name || f.author));
  const more = f.q || f.outcomes.length || f.methods.length || f.disc.length || f.kinds.length || f.from || f.to || f.saved || f.all;
  return `<div class="focus-filters ${st.filtersOpen ? 'open' : ''}">
    <div class="chips strand-chips" role="group" aria-label="Strands">${st.spec.strands.map(s => `<button type="button" class="chip btnish" data-fstrand="${s.key}" aria-pressed="${f.strands.includes(s.key)}">${dot(s.key)}${esc(s.label)} <span class="muted">${fmt(sN[s.key] || 0)}</span></button>`).join('')}</div>
    <button type="button" class="btn ghost small ff-toggle" data-f="filters" aria-expanded="${!!st.filtersOpen}">${st.filtersOpen ? 'Hide filters' : 'Search & filters'}${more ? ' · on' : ''}</button>
    <div class="filter-row">
      <input type="search" id="ff-q" placeholder="Search this literature: titles, abstracts, authors, places…" aria-label="Search this literature" value="${esc(f.q)}">
      ${pick('outcomes', 'Outcome', (st.spec.outcomes || []).map(o => ({ value: o.key, label: o.label, count: oN[o.key] })).filter(o => o.count))}
      ${pick('methods', 'Method', methods)}
      ${pick('disc', 'Discipline', Object.entries(dN).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ value: k, label: k, count: n })))}
      ${pick('kinds', 'Type', Object.entries(FC.KINDS).filter(([k]) => kN[k]).map(([k, l]) => ({ value: k, label: l, count: kN[k] })))}
      <span class="toolbar"><select id="ff-from" aria-label="Published from">${yearOpts(f.from, 'From')}</select><select id="ff-to" aria-label="Published until">${yearOpts(f.to, 'To')}</select></span>
      <button type="button" class="btn ghost small" data-f="saved" aria-pressed="${f.saved}">★ Saved</button>
      <button type="button" class="btn ghost small" data-f="all" aria-pressed="${f.all}" title="Off: only core journals, known working-paper series, cited work and radar papers">All venues</button>
      <button type="button" class="text-btn" data-f="clear">Clear all</button>
    </div>
    <div class="active-filters">${chips.join('')}</div></div>`;
}

// ---- overview -------------------------------------------------------------------------
function mini(p, extra = '') {
  return `<div class="mini-paper"><button type="button" data-fopen="${esc(p.id)}">${esc(p.title)}</button><small>${dot(p.strands[0])}${esc(FC.shortLabel(p))} · ${esc(p.venue || FC.KINDS[p.kind])}${extra ? ' · ' + extra : ''}</small></div>`;
}
function overviewHtml(list) {
  if (!list.length) return emptyHtml();
  const today = A.S.today, monthAgo = A.C.addDays(today, -30);
  const fresh = list.filter(p => p.published >= monthAgo).length;
  const working = list.filter(p => p.kind === 'working').length;
  const latest = FC.sortFocus(list, 'newest').slice(0, 8);
  const found = FC.sortFocus(list.filter(p => p.citedBy.length), 'local').slice(0, 10);
  const rising = FC.sortFocus(list.filter(p => p.cy && FC.recentCitations(p) > 0 && p.year >= new Date().getFullYear() - 5), 'rising').slice(0, 8);
  const ties = list.reduce((s, p) => s + p.cites.length, 0);
  return `<div class="stats">
      <div class="stat"><strong>${fmt(list.length)}</strong><span>papers in view</span></div>
      <div class="stat"><strong>${fmt(fresh)}</strong><span>published in the past 30 days</span></div>
      <div class="stat"><strong>${A.pct(list.length ? working / list.length : 0)}</strong><span>working papers</span></div>
      <div class="stat"><strong>${fmt(ties)}</strong><span>citations between these papers</span></div></div>
    <div class="grid-2">
      <div class="panel"><span class="eyebrow">Latest in this literature</span>${latest.map(p => mini(p, A.dayLabel(p.published))).join('')}
        <button type="button" class="text-btn" data-ftab="papers" style="margin-top:8px">All ${plural(list.length, 'paper')} →</button></div>
      <div class="panel"><span class="eyebrow">Foundations: most cited within this literature</span>${found.map(p => mini(p, `cited by ${plural(p.citedBy.length, 'paper')} here`)).join('') || '<p class="muted small">No citation links yet.</p>'}</div></div>
    <section class="section"><div class="section-head"><h2>Papers per year</h2><p>Each paper counted once, under its first strand</p></div>${yearChart(list)}</section>
    <section class="section"><div class="section-head"><h2>What is studied</h2><p>Outcomes by strand (a paper counts in each of its strands). Click a cell to list the papers.</p></div>${matrixHtml(list)}</section>
    <div class="grid-2">
      <div class="panel"><span class="eyebrow">Rising: most cited in the past two years</span>${rising.map(p => mini(p, `${fmt(FC.recentCitations(p))} recent citations`)).join('') || '<p class="muted small">No citation counts yet.</p>'}</div>
      <div class="panel"><span class="eyebrow">Where the evidence comes from</span>${placesHtml(list)}</div></div>`;
}

function yearChart(list) {
  const { years, series } = FC.yearlyByStrand(st.F, list, { from: +st.spec.since.slice(0, 4) });
  if (!years.length) return '<p class="muted">No dated papers.</p>';
  const totals = years.map((_, i) => series.reduce((s, x) => s + x.values[i], 0));
  const W = 920, H = 260, m = { l: 40, r: 8, t: 12, b: 28 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = Math.max(1, ...totals), band = iw / years.length, bw = Math.min(48, band * 0.66);
  const raw = max / 4, mag = 10 ** Math.floor(Math.log10(raw || 1)), step = Math.max(1, [1, 2, 5, 10].map(x => x * mag).find(x => x >= raw));
  const y = v => m.t + ih - (v / max) * ih;
  let marks = '';
  years.forEach((yr, i) => {
    let acc = 0;
    const x = m.l + band * i + (band - bw) / 2;
    const top = series.map((s, si) => (s.values[i] ? si : -1)).filter(v => v >= 0).at(-1);
    series.forEach((s, si) => {
      const v = s.values[i]; if (!v) return;
      const y0 = y(acc), y1 = y(acc + v); acc += v;
      const h = Math.max(0, y0 - y1 - (si === top ? 0 : 2));
      const r = si === top ? Math.min(4, h / 2, bw / 2) : 0;
      const d = `M${x},${y1 + h}V${y1 + r}${r ? `Q${x},${y1} ${x + r},${y1}` : ''}H${x + bw - r}${r ? `Q${x + bw},${y1} ${x + bw},${y1 + r}` : ''}V${y1 + h}Z`;
      marks += `<path d="${d}" fill="${strandVar(s.key)}" data-tip="${esc(`<b>${esc(strandLabel(s.key))}</b><span>${yr}: ${v} of ${totals[i]} papers</span>`)}"></path>`;
    });
  });
  const ticks = []; for (let v = 0; v <= max; v += step) ticks.push(v);
  const yl = ticks.map(v => `<g class="grid"><line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"></line></g><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('');
  const xl = years.map((yr, i) => `<text x="${m.l + band * i + band / 2}" y="${H - 8}" text-anchor="middle">${yr}</text>`).join('');
  const table = `<details class="more"><summary>Show as table</summary><div class="table-scroll"><table class="data"><thead><tr><th>Strand</th>${years.map(yr => `<th class="num">${yr}</th>`).join('')}</tr></thead><tbody>${series.map(s => `<tr><td>${esc(strandLabel(s.key))}</td>${s.values.map(v => `<td class="num">${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
  return `<div class="legend">${series.map(s => `<span><i style="background:${strandVar(s.key)}"></i>${esc(strandLabel(s.key))}</span>`).join('')}</div>
    <div class="chart" data-chart><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Papers per year by strand">${yl}${marks}${xl}</svg></div>${table}`;
}

function matrixHtml(list) {
  const rows = FC.outcomeMatrix(st.F, list);
  if (!rows.length) return '<p class="muted">No outcomes tagged yet.</p>';
  const keys = [...st.F.strands.keys()];
  const cols = keys.map((k, i) => [k, i]).filter(([, i]) => rows.some(r => r.cells[i]));
  const max = Math.max(1, ...rows.flatMap(r => cols.map(([, i]) => r.cells[i])));
  const level = v => (v ? Math.min(6, 1 + Math.floor(5 * Math.sqrt(v / max))) : 0);
  return `<div class="table-scroll"><table class="heat"><thead><tr><th></th>${cols.map(([k]) => `<th title="${esc(strandLabel(k))}">${dot(k)}<br>${esc(strandLabel(k).split(/[ &,]/)[0])}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr><th class="row" scope="row">${esc(outcomeLabel(r.key))} <span class="muted">${fmt(r.total)}</span></th>${cols.map(([k, i]) => { const v = r.cells[i]; return v ? `<td class="l${level(v)}"><button type="button" class="cell" data-fcell="${esc(k)}|${esc(r.key)}" title="${esc(`${outcomeLabel(r.key)} · ${strandLabel(k)}: ${v} papers`)}">${v}</button></td>` : '<td></td>'; }).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function placesHtml(list) {
  const n = {};
  for (const p of list) for (const g of p.geo) n[g] = (n[g] || 0) + 1;
  const top = Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 18);
  return top.length ? `<div class="chips" style="margin-top:8px">${top.map(([g, v]) => `<button type="button" class="chip btnish" data-fsearch="${esc(g)}">${esc(g)} <span class="muted">${v}</span></button>`).join('')}</div><p class="small muted" style="margin-top:8px">Countries and regions named in titles and abstracts.</p>` : '<p class="muted small">No places detected.</p>';
}
const emptyHtml = () => `<div class="empty"><h2>No papers match</h2><p>${st.F.papers.length ? 'Loosen the filters above.' : 'The collector has not filled this area yet: it runs with each update (tools/collect_focus.py).'}</p></div>`;

// ---- papers ---------------------------------------------------------------------------
function card(p) {
  const saved = !!A.S.user.saved[p.id], read = !!A.S.user.read[p.id], model = p.by !== 'rules';
  const auto = model ? '' : ' auto';
  const cites = [p.citedBy.length ? `cited by ${plural(p.citedBy.length, 'paper')} here` : '', p.cited != null ? `${fmt(p.cited)} citations overall` : ''].filter(Boolean).join(' · ');
  const design = p.methods.filter(m => A.S.ctx.methods.get(m)?.group !== 'other').map(m => A.S.ctx.label('method', m));
  const { contribution, ident } = lines(p, design);
  return `<article class="paper ${read ? 'is-read' : ''}" data-id="${esc(p.id)}">
    <div class="p-meta"><span class="journal">${esc(p.venue || FC.KINDS[p.kind])}</span><span>${p.published ? A.dayLabel(p.published, p.published.endsWith('-01-01') ? { year: 'numeric' } : undefined) : ''}</span>${p.kind !== 'article' ? `<span class="badge auto">${esc(FC.KINDS[p.kind].toUpperCase())}</span>` : ''}${p.radar ? '<span class="badge new">IN THE RADAR</span>' : ''}${cites ? `<span class="muted">${cites}</span>` : ''}</div>
    <h3 class="p-title"><button type="button" data-fopen="${esc(p.id)}">${esc(p.title)}</button></h3>
    <div class="p-authors">${p.authors.slice(0, 8).map(a => `<button type="button" data-fauthor="${esc(A.C.authorKey(a))}">${esc(a.n)}</button>`).join('<span aria-hidden="true">·</span>')}${p.authors.length > 8 ? `<span>+${p.authors.length - 8}</span>` : ''}</div>
    ${p.q ? `<p class="p-question${auto}">${model ? '' : '<span class="badge auto">AUTO-EXTRACTED</span> '}${esc(p.q)}</p>` : ''}
    ${contribution ? `<p class="p-line${auto}"><b>Contribution</b>${esc(contribution)}</p>` : ''}${ident ? `<p class="p-line${auto}"><b>Identification</b>${esc(ident)}</p>` : ''}
    ${p.summary ? `<p class="p-summary">${esc(p.summary)}</p>` : p.abstract ? `<details class="more"><summary>Abstract</summary><p class="p-summary">${esc(p.abstract)}</p></details>` : ''}
    <div class="p-tags">${p.strands.map(s => `<button type="button" class="chip btnish" data-fstrand="${s}">${dot(s)}${esc(strandLabel(s))}</button>`).join('')}${p.outcomes.map(o => `<button type="button" class="chip btnish topic" data-foutcome="${o}">${esc(outcomeLabel(o))}</button>`).join('')}</div>
    <div class="p-actions"><button type="button" class="icon-toggle" data-act="save" aria-pressed="${saved}">${saved ? '★ Saved' : '☆ Save'}</button><button type="button" class="icon-toggle" data-act="read" aria-pressed="${read}">${read ? '✓ Read' : 'Mark read'}</button>
      ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">Article ↗</a>` : ''}${p.pdf ? `<a href="${esc(p.pdf)}" target="_blank" rel="noopener">Open-access PDF ↗</a>` : ''}<button type="button" class="text-btn" data-fopen="${esc(p.id)}">Details & links</button></div>
  </article>`;
}
function lines(p, design = []) {
  const seen = new Set([p.q]);
  const once = text => (text && !seen.has(text) ? (seen.add(text), text) : '');
  const contribution = once(p.contribution);
  return { contribution, ident: once(p.ident) || (p.by === 'rules' && design.length ? design.join(' · ') : '') };
}
function papersHtml(list) {
  if (!list.length) return emptyHtml();
  return `<div class="toolbar list-tools"><span class="muted">${plural(list.length, 'paper')}</span>
      <label class="inline">Sort <select id="ff-sort">${Object.entries(FC.SORTS).map(([k, l]) => `<option value="${k}" ${st.f.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <select id="ff-export" aria-label="Export these papers"><option value="">Export…</option><option value="bib">BibTeX</option><option value="ris">RIS (Zotero, EndNote)</option><option value="csv">CSV</option></select></div>
    <div class="papers">${list.slice(0, st.limit).map(card).join('')}</div>
    ${list.length > st.limit ? `<button type="button" class="btn ghost" data-f="more" style="margin-top:16px">Show ${Math.min(40, list.length - st.limit)} more</button>` : ''}`;
}
function asRadar(p) { return { ...p, journal: p.venue || FC.KINDS[p.kind], added: p.added || p.published, conclusion: '', jel: [], text: [] }; }
function exportList(kind, list) {
  const rows = list.map(asRadar), stamp = A.S.today, ctx = A.S.ctx;
  if (kind === 'bib') A.download(`econradar-${st.spec.key}-${stamp}.bib`, rows.map(p => A.C.toBibtex(p, ctx)).join('\n\n'), 'application/x-bibtex');
  if (kind === 'ris') A.download(`econradar-${st.spec.key}-${stamp}.ris`, rows.map(p => A.C.toRis(p, ctx)).join('\r\n'), 'application/x-research-info-systems');
  if (kind === 'csv') A.download(`econradar-${st.spec.key}-${stamp}.csv`, '﻿' + A.C.toCsv(rows, ctx), 'text/csv');
}

// ---- authors --------------------------------------------------------------------------
function authorsHtml(list) {
  if (!list.length) return emptyHtml();
  const rows = FC.focusAuthors(list).filter(a => a.papers.length >= 2 || a.cited >= 50)
    .sort((a, b) => b.papers.length - a.papers.length || b.cited - a.cited).slice(0, 120);
  const bar = a => { const tot = Object.values(a.strands).reduce((s, v) => s + v, 0); return `<span class="mix" aria-hidden="true">${Object.entries(a.strands).sort((x, y) => st.F.strands.get(x[0]).i - st.F.strands.get(y[0]).i).map(([k, v]) => `<i style="background:${strandVar(k)};flex:${v / tot}"></i>`).join('')}</span>`; };
  return `<p class="muted small" style="margin-bottom:10px">Authors with at least two papers here (or one paper cited 50+ times), most papers first. Click a name to list their papers.</p>
    <div class="table-scroll"><table class="data"><thead><tr><th>Author</th><th class="num">Papers</th><th class="num">Citations</th><th class="num">Cited here</th><th>Strands</th><th class="num">Latest</th></tr></thead>
    <tbody>${rows.map(a => `<tr><td><button type="button" class="link" data-fauthor="${esc(a.key)}">${esc(a.name)}</button>${a.inst ? `<small class="muted"> · ${esc(a.inst)}</small>` : ''}</td><td class="num">${a.papers.length}</td><td class="num">${fmt(a.cited)}</td><td class="num">${fmt(a.local)}</td>
      <td title="${esc(Object.entries(a.strands).map(([k, v]) => `${strandLabel(k)}: ${v}`).join(', '))}">${bar(a)}</td><td class="num">${esc(a.last.slice(0, 4))}</td></tr>`).join('')}</tbody></table></div>`;
}

// ---- citation map ---------------------------------------------------------------------
function years() { const ys = st.F.papers.map(p => p.year).filter(Boolean); return [Math.max(+st.spec.since.slice(0, 4), Math.min(...ys)), Math.max(...ys)]; }
function mapShellHtml(list) {
  if (!list.length) return emptyHtml();
  const [y0, y1] = years(), upTo = st.upTo || y1;
  return `<p class="muted" style="margin-bottom:10px">The most cited papers of the selection, each linked to the papers it cites (solid). Dashed ties join papers that cite several of the same works. Size is how often a paper is cited within this literature; colour is its first strand; diamonds are working papers, squares books and chapters.</p>
    <div class="toolbar" style="margin-bottom:12px">
      <label class="inline">Papers <select id="fm-max">${[100, 250, 500, 900].map(v => `<option ${st.maxNodes === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <button type="button" class="btn ghost small" data-f="shared" aria-pressed="${st.shared}">Shared references</button>
      <input type="search" id="fm-find" placeholder="Find a paper or author…" aria-label="Find a paper in the map" style="min-width:190px">
      <button type="button" class="btn ghost small" data-f="fit">Fit to view</button></div>
    <div class="net-layout"><div><div class="net-stage" id="fm-stage"><div class="net-legend" aria-hidden="true">${st.spec.strands.filter(s => list.some(p => p.strands[0] === s.key)).map(s => `<span>${dot(s.key)}${esc(s.label)}</span>`).join('')}</div></div>
      <div class="timeline"><button type="button" class="btn small" data-f="play" aria-pressed="false">▶ Grow by year</button><input type="range" id="fm-year" min="${y0}" max="${y1}" value="${upTo}" aria-label="Show papers published up to this year"><output id="fm-when"></output></div></div>
      <aside class="net-side" id="fm-side" aria-live="polite"></aside></div>`;
}
function drawMap(list, fresh = false) {
  const stage = A.$('#fm-stage'); if (!stage) return;
  if (fresh || !st.net) {
    if (st.net) st.net.destroy();
    st.net = A.createNetwork(stage, {
      label: 'Citation map of the selected papers',
      onSelect: n => { st.selected = n ? n.id : null; side(); },
      onHover: (n, e) => { if (!n || !e) return A.hideTip(); const p = n.paper; A.showTip(`<b>${esc(p.title)}</b><span>${esc(FC.shortLabel(p))} · ${esc(p.venue)}</span><span>Cited by ${p.citedBy.length} here · cites ${p.cites.length} here</span>`, e.clientX, e.clientY); },
    });
  }
  const [, y1] = years(), upTo = st.upTo && st.upTo < y1 ? st.upTo : 0;
  const g = FC.citationGraph(st.F, list, { max: st.maxNodes, upTo, coupling: st.shared });
  const maxCount = Math.max(1, ...g.nodes.map(n => n.count));
  const labelCut = [...g.nodes].sort((a, b) => b.count - a.count)[Math.min(14, g.nodes.length - 1)]?.count || 1;
  st.net.render(g, {
    fill: n => strandColor(n.strand), size: n => 3 + 15 * Math.sqrt(n.count / maxCount), label: n => n.label,
    shape: n => (n.paper.kind === 'working' ? 'diamond' : n.paper.kind === 'chapter' || n.paper.kind === 'book' ? 'square' : 'circle'),
    labelAlways: n => n.count >= labelCut && n.count > 1, showNew: true, labelAt: 12,
  });
  const out = A.$('#fm-when');
  if (out) out.textContent = `${upTo ? 'Published up to ' + upTo : 'All years'} · ${plural(g.shown, 'paper')} with ties, of ${fmt(g.total)} in view`;
  if (st.selected && st.net.node(st.selected)) st.net.select(st.selected); else { st.selected = null; side(); }
}
function side() {
  const box = A.$('#fm-side'); if (!box) return;
  const p = st.selected && st.F.byId.get(st.selected);
  if (!p) { box.innerHTML = '<p class="muted small">Click a paper to see what it builds on and who builds on it, within this literature.</p>'; return; }
  const item = q => `<div class="mini-paper"><button type="button" data-fsel="${esc(q.id)}">${esc(q.title)}</button><small>${dot(q.strands[0])}${esc(FC.shortLabel(q))}</small></div>`;
  const cites = p.cites.map(id => st.F.byId.get(id)).filter(Boolean), by = p.citedBy.map(id => st.F.byId.get(id)).filter(Boolean);
  box.innerHTML = `<span class="eyebrow">${esc(p.venue || FC.KINDS[p.kind])} · ${yearOf(p)}</span><h3><button type="button" class="link" data-fopen="${esc(p.id)}">${esc(p.title)}</button></h3>
    <p class="small muted">${esc(p.authors.map(a => a.n).slice(0, 6).join(', '))}</p>
    <div class="chips" style="margin:8px 0">${p.strands.map(s => `<span class="chip">${dot(s)}${esc(strandLabel(s))}</span>`).join('')}</div>
    <h4>Builds on (${cites.length})</h4>${FC.sortFocus(cites, 'local').slice(0, 6).map(item).join('') || '<p class="muted small">No references within this literature.</p>'}
    <h4 style="margin-top:12px">Cited here by (${by.length})</h4>${FC.sortFocus(by, 'newest').slice(0, 6).map(item).join('') || '<p class="muted small">Not cited here yet.</p>'}
    <button type="button" class="btn small" data-fopen="${esc(p.id)}" style="margin-top:12px">Details</button>`;
}
function stopPlay() { clearInterval(st.play); st.play = 0; const b = document.querySelector('[data-f="play"]'); if (b) { b.textContent = '▶ Grow by year'; b.setAttribute('aria-pressed', 'false'); } }
function play(list) {
  if (st.play) return stopPlay();
  const [y0, y1] = years();
  st.upTo = y0;
  const b = document.querySelector('[data-f="play"]'); b.textContent = '❚❚ Pause'; b.setAttribute('aria-pressed', 'true');
  const tick = () => { A.$('#fm-year').value = st.upTo; drawMap(list); if (st.upTo >= y1) { stopPlay(); st.upTo = 0; return; } st.upTo++; };
  tick(); st.play = setInterval(tick, 1100);
}

// ---- details dialog ---------------------------------------------------------------------
function openPaper(id) {
  const p = st.F.byId.get(id); if (!p) return;
  const saved = !!A.S.user.saved[p.id], read = !!A.S.user.read[p.id], model = p.by !== 'rules';
  const row = (label, value) => (value ? `<dt>${label}</dt><dd>${value}</dd>` : '');
  const list = (title, items, extra) => (items.length ? `<h3 style="margin-top:18px">${title} <span class="muted">(${items.length})</span></h3>${items.slice(0, 8).map(q => `<div class="mini-paper"><button type="button" data-fopen="${esc(q.id)}">${esc(q.title)}</button><small>${dot(q.strands[0])}${esc(FC.shortLabel(q))} · ${esc(q.venue)}${extra ? ' · ' + extra(q) : ''}</small></div>`).join('')}` : '');
  const cites = FC.sortFocus(p.cites.map(x => st.F.byId.get(x)).filter(Boolean), 'local');
  const by = FC.sortFocus(p.citedBy.map(x => st.F.byId.get(x)).filter(Boolean), 'newest');
  const near = FC.coupled(st.F, p);
  A.$('#dialog-content').innerHTML = `<span class="eyebrow">${esc(p.venue || FC.KINDS[p.kind])}${p.published ? ' · ' + A.dayLabel(p.published) : ''} · ${esc(FC.KINDS[p.kind])}</span>
    <h2>${esc(p.title)}</h2>
    <p class="small">${esc(p.authors.map(a => a.n + (a.inst ? ` (${a.inst})` : '')).join(', '))}</p>
    ${p.q ? `<p class="p-question ${model ? '' : 'auto'}" style="margin-top:14px">${esc(p.q)}</p>` : ''}
    ${(() => { const l = lines(p); return `<div style="display:grid;gap:6px;margin:10px 0">${l.contribution ? `<p class="p-line${model ? '' : ' auto'}"><b>Contribution</b>${esc(l.contribution)}</p>` : ''}${l.ident ? `<p class="p-line${model ? '' : ' auto'}"><b>Identification</b>${esc(l.ident)}</p>` : ''}</div>`; })()}
    ${p.summary ? `<p class="p-summary">${esc(p.summary)}</p>` : ''}
    ${p.abstract ? `<h3 style="margin-top:14px">Abstract${p.abstract.endsWith('…') ? ' (excerpt)' : ''}</h3><p class="p-summary">${esc(p.abstract)}</p>` : ''}
    <dl class="detail-grid">
      ${row('Strands', p.strands.map(s => dot(s) + ' ' + esc(strandLabel(s))).join(', '))}${row('Outcomes', esc(p.outcomes.map(outcomeLabel).join(', ')))}
      ${row('Discipline', esc([p.disc, p.sub].filter(Boolean).join(' · ')))}${row('Methods', esc(p.methods.map(k => A.S.ctx.label('method', k)).join(', ')))}
      ${row('Data', esc(p.data.map(k => A.S.ctx.label('data', k)).join(', ')))}${row('Setting', esc([p.geo.join(', '), p.period].filter(Boolean).join(' · ')))}
      ${row('Citations', p.cited != null ? esc(`${fmt(p.cited)} overall${p.cy ? ` · ${fmt(FC.recentCitations(p))} in the past two years` : ''} · ${p.citedBy.length} within this literature`) : esc(`${p.citedBy.length} within this literature`))}
      ${row('Summary from', esc(model ? p.by : 'automatic extraction (no model yet)'))}
    </dl>
    <div class="p-actions" style="margin:14px 0" data-id="${esc(p.id)}"><button type="button" class="icon-toggle" data-act="save" aria-pressed="${saved}">${saved ? '★ Saved' : '☆ Save'}</button><button type="button" class="icon-toggle" data-act="read" aria-pressed="${read}">${read ? '✓ Read' : 'Mark read'}</button>
      ${p.url ? `<a class="btn small" href="${esc(p.url)}" target="_blank" rel="noopener">Article ↗</a>` : ''}${p.pdf ? `<a class="btn ghost small" href="${esc(p.pdf)}" target="_blank" rel="noopener">Open-access PDF ↗</a>` : ''}
      <button type="button" class="btn ghost small" data-fcite="${esc(p.id)}">Copy BibTeX</button><button type="button" class="btn ghost small" data-fmap="${esc(p.id)}">Show in citation map</button></div>
    <label class="small muted" for="note">Your note (stays on this device)</label><textarea id="note" data-note="${esc(p.id)}" placeholder="How it relates to your project, what to check…">${esc(A.S.user.notes[p.id] || '')}</textarea>
    ${list('Builds on, within this literature', cites)}${list('Cited here by', by, q => A.dayLabel(q.published, { month: 'short', year: 'numeric' }))}
    ${near.length ? `<h3 style="margin-top:18px">Shares references with</h3>${near.map(({ paper: q, shared }) => `<div class="mini-paper"><button type="button" data-fopen="${esc(q.id)}">${esc(q.title)}</button><small>${dot(q.strands[0])}${esc(FC.shortLabel(q))} · ${shared} shared references</small></div>`).join('')}` : ''}`;
  const d = A.$('#dialog');
  if (!d.open) d.showModal();
  d.scrollTop = 0;
}
function bindDialog() {
  st.bound = true;
  A.$('#dialog').addEventListener('click', e => {
    if (A.S.view !== 'focus') return;
    const t = e.target.closest('[data-fopen],[data-fcite],[data-fmap]'); if (!t) return;
    if (t.dataset.fopen) openPaper(t.dataset.fopen);
    else if (t.dataset.fcite) { const p = st.F.byId.get(t.dataset.fcite); navigator.clipboard?.writeText(A.C.toBibtex(asRadar(p), A.S.ctx)).then(() => A.toast('BibTeX copied.'), () => A.toast('Copy failed; use Export instead.')); }
    else if (t.dataset.fmap) { A.$('#dialog').close(); st.selected = t.dataset.fmap; st.upTo = 0; if (st.tab !== 'map') setTab('map'); else drawMap(FC.filterFocus(st.F, st.f, { user: A.S.user })); if (!st.net?.node(st.selected)) A.toast('Not in the map: it has no citation ties among the papers shown.'); else st.net.center(st.selected); }
  });
}

// ---- events ---------------------------------------------------------------------------
function current() { return FC.filterFocus(st.F, st.f, { user: A.S.user }); }
function onClick(e) {
  const t = e.target.closest('button,[data-fopen]'); if (!t) return;
  const d = t.dataset;
  if (d.ftab) setTab(d.ftab);
  else if (d.fopen) openPaper(d.fopen);
  else if (d.fstrand) setF(f => { const i = f.strands.indexOf(d.fstrand); if (i >= 0) f.strands.splice(i, 1); else f.strands.push(d.fstrand); });
  else if (d.foutcome) setF(f => { if (!f.outcomes.includes(d.foutcome)) f.outcomes.push(d.foutcome); });
  else if (d.fauthor) setF(f => { f.author = d.fauthor; }, { keepTab: false });
  else if (d.fsearch) setF(f => { f.q = d.fsearch; }, { keepTab: false });
  else if (d.fcell) { const [s, o] = d.fcell.split('|'); setF(f => { f.strands = [s]; f.outcomes = [o]; }, { keepTab: false }); }
  else if (d.fsel) { st.selected = d.fsel; st.net?.select(d.fsel, true); st.net?.center(d.fsel); side(); }
  else if (d.fremove) setF(f => { const k = d.fremove; if (k === 'q') f.q = ''; else if (k === 'years') { f.from = 0; f.to = 0; } else if (k === 'author') f.author = ''; else f[k] = f[k].filter(x => x !== d.value); });
  else if (d.f === 'clear') setF(f => Object.assign(f, FC.EMPTY, { strands: [], outcomes: [], disc: [], kinds: [], methods: [], sort: f.sort }));
  else if (d.f === 'saved') setF(f => { f.saved = !f.saved; });
  else if (d.f === 'all') setF(f => { f.all = !f.all; });
  else if (d.f === 'filters') { st.filtersOpen = !st.filtersOpen; const box = t.closest('.focus-filters'); box.classList.toggle('open', st.filtersOpen); t.setAttribute('aria-expanded', String(st.filtersOpen)); t.textContent = st.filtersOpen ? 'Hide filters' : 'Search & filters'; }
  else if (d.f === 'more') { st.limit += 40; const y = window.scrollY; render(); window.scrollTo(0, y); }
  else if (d.f === 'shared') { st.shared = !st.shared; t.setAttribute('aria-pressed', String(st.shared)); drawMap(current()); }
  else if (d.f === 'fit') st.net?.fit(true);
  else if (d.f === 'play') play(current());
  else if (d.f === 'hide') { A.local.set('radar.focus.v1', false); A.renderNav(); location.hash = 'latest'; }
}
function onChange(e) {
  const t = e.target;
  if (t.dataset.ff) setF(f => { const k = t.dataset.ff; f[k] = t.checked ? [...f[k], t.value] : f[k].filter(x => x !== t.value); });
  else if (t.id === 'ff-from' || t.id === 'ff-to') setF(f => { f[t.id === 'ff-from' ? 'from' : 'to'] = +t.value; });
  else if (t.id === 'ff-sort') setF(f => { f.sort = t.value; });
  else if (t.id === 'ff-export' && t.value) { exportList(t.value, current()); t.value = ''; }
  else if (t.id === 'fm-max') { st.maxNodes = +t.value; drawMap(current()); }
}
let qTimer;
function onInput(e) {
  const t = e.target;
  if (t.id === 'ff-q') { clearTimeout(qTimer); qTimer = setTimeout(() => { setF(f => { f.q = t.value; }); const box = A.$('#ff-q'); if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); } }, 300); }
  else if (t.id === 'fm-year') { stopPlay(); st.upTo = +t.value; drawMap(current()); }
  else if (t.id === 'fm-find' && t.value.trim().length > 2) {
    const q = A.C.fold(t.value);
    const hit = current().filter(p => st.net?.node(p.id) && p.text.includes(q)).sort((a, b) => b.citedBy.length - a.citedBy.length)[0];
    if (hit) { st.selected = hit.id; st.net.select(hit.id, true); st.net.center(hit.id); side(); }
  }
}
