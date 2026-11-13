import * as C from './core.mjs?v=5';
import { createNetwork } from './graph.mjs?v=1';

// ---- small helpers -------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => new Intl.NumberFormat('en-GB').format(n);
const pct = x => `${Math.round(x * 100)}%`;
const dayLabel = (d, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => (d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', opts) : '');
const plural = (n, one, many = one + 's') => `${fmt(n)} ${n === 1 ? one : many}`;
const KEYS = { user: 'radar.user.v1', filters: 'radar.filters.v1', prefs: 'radar.prefs.v1' };
const local = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
const ICONS = {
  latest: '<path d="M5 6h14M5 12h14M5 18h9"/>',
  network: '<circle cx="6" cy="7" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="12" cy="17" r="2.6"/><path d="M8.2 8.2l2.6 6.6M15.9 7.6l-2.7 7.3M8.4 6.8l7.2-.6"/>',
  authors: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.8-3.4 3-5.2 5.5-5.2s4.7 1.8 5.5 5.2"/><circle cx="17" cy="9" r="2.4"/><path d="M15.6 13.9c2.4-.3 4.2 1.2 4.9 4.1"/>',
  trends: '<path d="M4 19V5M4 19h16"/><path d="M7 15l4-4 3 3 5-6"/>',
  sources: '<path d="M5 5.5C5 4.7 5.7 4 6.5 4H18v14H6.5C5.7 18 5 18.7 5 19.5zM5 19.5c0 .8.7 1.5 1.5 1.5H18"/><path d="M9 8h6M9 11h4"/>',
  newsletter: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>',
  focus: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
};
const BASE_VIEWS = [['latest', 'Latest'], ['network', 'Network'], ['authors', 'Authors'], ['trends', 'Trends'], ['newsletter', 'Newsletter'], ['sources', 'Sources']];
// The Focus tab (radar/focus.json) is personal: it shows only on devices where it was switched
// on, by opening the app once at #focus. Nothing else in the app links to it.
const FOCUS_KEY = 'radar.focus.v1';
const focusOn = () => local.get(FOCUS_KEY, false) === true;
const views = () => (focusOn() ? [...BASE_VIEWS.slice(0, 4), ['focus', 'Focus'], ...BASE_VIEWS.slice(4)] : BASE_VIEWS);
let focusModule = null;

const S = {
  ctx: null, config: null, index: { shards: [], runs: [] }, papers: [], visible: [], firsts: new Map(), allAuthors: new Map(),
  user: C.cleanUser(local.get(KEYS.user, {})), filters: C.cleanFilters(local.get(KEYS.filters, {})),
  prefs: Object.assign({ sort: 'published', match: 'all', lens: 'strands', highlight: 'auto', kinds: { field: true, method: true, data: true, topic: true }, minEdge: 2, maxTopics: 45, maxPapers: 400, minAuthorPapers: 0, trendFacet: 'methods', trendBy: 'quarter', trendScope: '', authorSort: 'papers' }, local.get(KEYS.prefs, {})),
  today: C.isoDay(Date.now()), lastRun: '', prevVisit: '', view: 'latest', arg: '', limit: 30, network: null, net: {}, playing: 0,
};
const saveUser = () => local.set(KEYS.user, S.user);
const savePrefs = () => local.set(KEYS.prefs, S.prefs);
const saveFilters = () => local.set(KEYS.filters, S.filters);

// ---- colours ------------------------------------------------------------------------
const rootStyle = () => getComputedStyle(document.documentElement);
const slotOf = fam => S.ctx.families.get(fam)?.slot;
const famVar = fam => (slotOf(fam) ? `var(--series-${slotOf(fam)})` : 'var(--series-other)');
const famColor = fam => rootStyle().getPropertyValue(slotOf(fam) ? `--series-${slotOf(fam)}` : '--series-other').trim();
const fieldDot = key => `<i class="dot" style="background:${famVar(S.ctx.familyOf(key))}" aria-hidden="true"></i>`;

// ---- toast, tooltip, downloads ------------------------------------------------------
let toastTimer;
function toast(text) { const t = $('#toast'); t.textContent = text; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800); }
function showTip(html, x, y) {
  const tip = $('#tooltip'); tip.innerHTML = html; tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(window.innerWidth - r.width - 8, x + 14) + 'px';
  tip.style.top = Math.max(8, (y + 16 + r.height > window.innerHeight ? y - r.height - 12 : y + 16)) + 'px';
}
const hideTip = () => { $('#tooltip').hidden = true; };
function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---- loading ------------------------------------------------------------------------
async function getJSON(url) { const r = await fetch(url, { cache: 'no-cache' }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); }

// Papers come one file per publication year (data/papers-YYYY.json): the newest year is
// loaded first so the app opens fast, the older years follow in the background, and each
// year's abstracts (data/abstracts-YYYY.json) only when a paper of that year is opened.
async function load() {
  S.config = await getJSON('config.json');
  S.ctx = C.createContext(S.config);
  try { S.index = await getJSON('data/index.json'); } catch { S.index = { shards: [], runs: [] }; }
  const shards = S.index.shards || [];
  S.shardData = [];
  if (shards.length) S.shardData.push(await getJSON('data/' + shards[0].file).catch(() => null));
  absorb();
  S.lastRun = (S.index.runs?.[0]?.at || '').slice(0, 10) || S.papers[0]?.added || '';
  S.prevVisit = S.user.lastVisit;
  S.user.lastVisit = S.today;
  saveUser();
  S.loadingRest = shards.length > 1 ? Promise.all(shards.slice(1).map(s => getJSON('data/' + s.file).catch(() => null))).then(rest => {
    S.shardData.push(...rest);
    absorb();
    S.loadingRest = null;
    refresh({ keepNetwork: S.view === 'network' });
    sideStatus();
  }) : null;
}
function absorb() {
  S.papers = C.mergeShards(S.shardData.filter(Boolean), S.ctx);
  S.byId = new Map(S.papers.map(p => [p.id, p]));
  S.firsts = C.firsts(S.papers);
  S.allAuthors = C.authorIndex(S.papers);
}
const abstractsLoaded = new Map();
function loadAbstracts(year) {
  const shard = (S.index.shards || []).find(s => s.year === year && s.abstracts);
  if (!shard) return Promise.resolve();
  if (!abstractsLoaded.has(year)) abstractsLoaded.set(year, getJSON('data/' + shard.abstracts).then(map => {
    for (const p of S.papers) if (map[p.id] && !p.abstract) C.setAbstract(p, map[p.id]);
  }).catch(() => abstractsLoaded.delete(year)));
  return abstractsLoaded.get(year);
}

function topCount() {
  const n = S.visible.length;
  $('#top-count').textContent = n === S.papers.length ? plural(n, 'paper') : `${fmt(n)} of ${plural(S.papers.length, 'paper')}`;
}
function refresh({ keepNetwork = false } = {}) {
  S.visible = C.filterPapers(S.papers, S.filters, S.ctx, { user: S.user, today: S.today });
  S.limit = 30;
  updateFilterUI();
  topCount();
  render(keepNetwork || S.view === 'network');
}

// ---- filters ------------------------------------------------------------------------
const countBy = (facet) => { const o = {}; for (const p of S.papers) for (const k of [].concat(p[facet])) o[k] = (o[k] || 0) + 1; return o; };

function pickerHtml(key, label, groups) {
  const opts = g => g.options.map(o => `<label class="pick-opt" data-text="${esc(C.fold(o.label))}"><input type="checkbox" data-filter="${key}" value="${esc(o.value)}">${o.dot || ''}<span>${esc(o.label)}</span><span class="n">${o.count ? fmt(o.count) : ''}</span></label>`).join('');
  return `<details class="pick" data-pick="${key}"><summary>${esc(label)} <b hidden></b></summary><div class="pick-panel"><input type="search" placeholder="Find ${esc(label.toLowerCase())}…" aria-label="Find ${esc(label.toLowerCase())}" data-pick-search>
    ${groups.map(g => `<div class="pick-group">${g.label ? (g.family ? `<button type="button" data-family="${g.family}" title="Select the whole family">${fieldDot(S.config.fields.find(f => f.family === g.family)?.key)}${esc(g.label)}</button>` : `<button type="button" disabled>${esc(g.label)}</button>`) : ''}${opts(g)}</div>`).join('')}</div></details>`;
}

function renderFilters() {
  const c = S.config, fieldN = countBy('fields'), methodN = countBy('methods'), dataN = countBy('data'), journalN = countBy('journal');
  const fieldGroups = c.families.map(f => ({ label: f.label, family: f.key, options: c.fields.filter(x => x.family === f.key).map(x => ({ value: x.key, label: x.label, count: fieldN[x.key], dot: fieldDot(x.key) })) }));
  const methodGroups = c.methodGroups.map(g => ({ label: g.label, options: c.methods.filter(m => m.group === g.key).map(m => ({ value: m.key, label: m.label, count: methodN[m.key] })) }));
  const dataGroups = [{ label: '', options: c.dataTypes.map(d => ({ value: d.key, label: d.label, count: dataN[d.key] })) }];
  const journalGroups = c.journalGroups.map(g => ({ label: g.label, options: c.journals.filter(j => j.group === g.key).map(j => ({ value: j.key, label: `${j.short} · ${j.name}`, count: journalN[j.key] })) }));
  $('#filter-bar').innerHTML = `<div class="filter-row">
    <input type="search" id="f-q" placeholder="Search titles, questions, topics, authors, data…" aria-label="Search papers" value="${esc(S.filters.q)}">
    <select id="f-period" aria-label="Publication date">${[['all', 'Published: any time'], ['7d', 'Published: past 7 days'], ['30d', 'Published: past 30 days'], ['90d', 'Published: past 3 months'], ['180d', 'Published: past 6 months'], ['365d', 'Published: past year'], ['custom', 'Published between…']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
    <span id="f-custom" class="toolbar" hidden><input type="date" id="f-from" aria-label="Published from"><input type="date" id="f-to" aria-label="Published until"></span>
    ${pickerHtml('fields', 'Field', fieldGroups)}${pickerHtml('methods', 'Method', methodGroups)}${pickerHtml('data', 'Data', dataGroups)}${pickerHtml('journals', 'Source', journalGroups)}
    <details class="pick" data-pick="authors"><summary>Author <b hidden></b></summary><div class="pick-panel"><input type="search" placeholder="Type a name…" aria-label="Find an author" id="f-author-q"><div id="f-author-list"></div></div></details>
    <button type="button" class="btn ghost small" data-toggle="saved" aria-pressed="false">★ Saved</button>
    <button type="button" class="btn ghost small" data-toggle="unread" aria-pressed="false">Unread</button>
    <button type="button" class="btn ghost small" data-toggle="followed" aria-pressed="false">Followed authors</button>
    <button type="button" class="btn ghost small" data-toggle="modelOnly" aria-pressed="false" title="Only papers summarised by the model">AI-summarised</button>
    <button type="button" class="text-btn" id="f-clear">Clear all</button>
  </div><div class="active-filters" id="active-filters"></div>`;
  renderAuthorOptions('');
}

function renderAuthorOptions(q) {
  const terms = C.queryTerms(q);
  const list = [...S.allAuthors.values()].filter(a => terms.every(t => C.fold(a.name).includes(t)))
    .sort((a, b) => b.papers.length - a.papers.length || a.name.localeCompare(b.name)).slice(0, 14);
  $('#f-author-list').innerHTML = list.length ? list.map(a => `<label class="pick-opt"><input type="checkbox" data-filter="authors" value="${esc(a.key)}" ${S.filters.authors.includes(a.key) ? 'checked' : ''}><span>${esc(a.name)}<small class="muted"> ${esc(a.inst)}</small></span><span class="n">${a.papers.length}</span></label>`).join('') : '<p class="muted small">No author by that name.</p>';
}

function updateFilterUI() {
  const f = S.filters, bar = $('#filter-bar');
  if (!bar.firstChild) return;
  $('#f-q').value !== f.q && ($('#f-q').value = f.q);
  $('#f-period').value = f.period;
  $('#f-custom').hidden = f.period !== 'custom';
  $('#f-from').value = f.from; $('#f-to').value = f.to;
  for (const box of $$('input[data-filter]', bar)) box.checked = f[box.dataset.filter].includes(box.value);
  for (const pick of $$('.pick', bar)) {
    const n = pick.dataset.pick === 'fields' ? f.fields.length + f.families.length : f[pick.dataset.pick].length;
    const b = $('summary b', pick); b.hidden = !n; b.textContent = n; pick.classList.toggle('on', !!n);
  }
  for (const t of $$('[data-toggle]', bar)) t.setAttribute('aria-pressed', String(!!f[t.dataset.toggle]));
  const chips = [];
  const chip = (kind, value, text, dot = '') => chips.push(`<span class="chip removable">${dot}${esc(text)}<button type="button" data-remove="${kind}" data-value="${esc(value)}" aria-label="Remove ${esc(text)}">×</button></span>`);
  if (f.q) chip('q', '', `“${f.q}”`);
  if (f.period !== 'all') chip('period', '', f.period === 'custom' ? `Published ${f.from ? dayLabel(f.from) : '…'} – ${f.to ? dayLabel(f.to) : '…'}` : $('#f-period').selectedOptions[0].textContent);
  if (f.run) chip('run', '', `Added in the ${dayLabel(f.run)} update`);
  f.families.forEach(k => chip('families', k, S.ctx.label('family', k), `<i class="dot" style="background:${famVar(k)}"></i>`));
  f.fields.forEach(k => chip('fields', k, S.ctx.label('field', k), fieldDot(k)));
  f.methods.forEach(k => chip('methods', k, S.ctx.label('method', k)));
  f.data.forEach(k => chip('data', k, S.ctx.label('data', k)));
  f.journals.forEach(k => chip('journals', k, S.ctx.label('journal', k)));
  f.authors.forEach(k => chip('authors', k, S.allAuthors.get(k)?.name || k));
  $('#active-filters').innerHTML = chips.join('');
  const count = C.activeFilterCount(f);
  $('#filter-count').hidden = !count; $('#filter-count').textContent = count;
}

function setFilter(mut) { mut(S.filters); S.filters = C.cleanFilters(S.filters); saveFilters(); refresh(); }
function toggleIn(list, value) { const i = list.indexOf(value); if (i >= 0) list.splice(i, 1); else list.push(value); }

function bindFilters() {
  const bar = $('#filter-bar');
  let qTimer;
  bar.addEventListener('input', e => {
    if (e.target.id === 'f-q') { clearTimeout(qTimer); qTimer = setTimeout(() => setFilter(f => { f.q = e.target.value; }), 220); }
    if (e.target.id === 'f-author-q') renderAuthorOptions(e.target.value);
    if (e.target.matches('[data-pick-search]')) {
      const q = C.fold(e.target.value);
      for (const o of $$('.pick-opt', e.target.closest('.pick-panel'))) o.hidden = q && !o.dataset.text.includes(q);
    }
  });
  bar.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.filter) setFilter(f => toggleIn(f[t.dataset.filter], t.value));
    else if (t.id === 'f-period') setFilter(f => { f.period = t.value; if (t.value === 'custom' && !f.from) f.from = C.addDays(S.today, -30); });
    else if (t.id === 'f-from' || t.id === 'f-to') setFilter(f => { f[t.id === 'f-from' ? 'from' : 'to'] = t.value; });
  });
  bar.addEventListener('click', e => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.toggle) setFilter(f => { f[t.dataset.toggle] = !f[t.dataset.toggle]; });
    else if (t.dataset.family) setFilter(f => toggleIn(f.families, t.dataset.family));
    else if (t.dataset.remove) setFilter(f => { const k = t.dataset.remove; if (k === 'q') f.q = ''; else if (k === 'period') f.period = 'all'; else if (k === 'run') f.run = ''; else toggleIn(f[k], t.dataset.value); });
    else if (t.id === 'f-clear') setFilter(f => Object.assign(f, C.EMPTY_FILTERS, { families: [], fields: [], methods: [], data: [], journals: [], authors: [] }));
  });
  // One open picker at a time; click outside closes it.
  bar.addEventListener('toggle', e => { if (e.target.open) for (const d of $$('.pick[open]', bar)) if (d !== e.target) d.open = false; }, true);
  document.addEventListener('click', e => { if (!e.target.closest('.pick')) for (const d of $$('.pick[open]')) d.open = false; });
  $('#filter-toggle').addEventListener('click', () => { const open = bar.classList.toggle('open'); $('#filter-toggle').setAttribute('aria-expanded', String(open)); });
}

// ---- routing ------------------------------------------------------------------------
function renderNav() {
  $('#nav').innerHTML = views().map(([k, l]) => `<a class="nav-link" href="#${k}" data-view="${k}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg><span>${l}</span></a>`).join('');
}
function route() {
  const [view, ...rest] = location.hash.slice(1).split('/');
  if (view === 'focus' && !focusOn()) { local.set(FOCUS_KEY, true); renderNav(); }
  S.view = views().some(([k]) => k === view) || view === 'author' ? view : 'latest';
  S.arg = decodeURIComponent(rest.join('/'));
  // #paper/<id> (links in the newsletter): the latest papers, with that paper open.
  if (view === 'paper' && S.arg) { const id = S.arg; S.arg = ''; setTimeout(() => openPaperWhenLoaded(id), 0); }
  if (S.view !== 'network' && S.network) { S.network.destroy(); S.network = null; stopPlay(); }
  if (S.view !== 'focus') { focusModule?.leave(); topCount(); }
  for (const a of $$('.nav-link')) a.classList.toggle('active', a.dataset.view === (S.view === 'author' ? 'authors' : S.view));
  $('#crumb').textContent = { latest: 'LATEST PAPERS', network: 'RESEARCH NETWORK', authors: 'AUTHORS', author: 'AUTHORS / PROFILE', trends: 'TRENDS', newsletter: 'WEEKLY NEWSLETTER', focus: 'FOCUS', sources: 'SOURCES & SETTINGS' }[S.view];
  $('#filter-bar').hidden = $('#filter-toggle').hidden = ['sources', 'focus', 'newsletter'].includes(S.view);
  render();
  $('#main').focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
function render(keepNetwork = false) {
  hideTip();
  const main = $('#main');
  if (S.view === 'focus') return renderFocus();
  if (S.view === 'newsletter') return renderNewsletter();
  if (!S.papers.length && S.view !== 'sources') { main.innerHTML = emptyRadar(); return; }
  if (S.view === 'latest') main.innerHTML = latestHtml();
  else if (S.view === 'network') renderNetwork(keepNetwork);
  else if (S.view === 'authors') { main.innerHTML = authorsHtml(); }
  else if (S.view === 'author') main.innerHTML = authorHtml(S.arg);
  else if (S.view === 'trends') main.innerHTML = trendsHtml();
  else if (S.view === 'sources') main.innerHTML = sourcesHtml();
}
async function openPaperWhenLoaded(id) {
  if (!S.byId?.has(id) && S.loadingRest) await S.loadingRest;
  if (S.byId?.has(id)) openPaper(id); else toast('That paper is not in the radar.');
}

// ---- Newsletter ------------------------------------------------------------------------
// Issues are built each week by tools/newsletter.py (data/newsletter/<date>.json). Page 2
// shows the field families a reader picks here (remembered on this device); subscribing
// sends the same choice to Buttondown as tags, so the email carries those sections.
const NL = { list: null, issues: new Map() };
async function renderNewsletter() {
  const main = $('#main');
  try {
    NL.list ||= (await getJSON('data/newsletter/index.json')).issues || [];
    const day = NL.list.includes(S.arg) ? S.arg : NL.list[0];
    if (day && !NL.issues.has(day)) NL.issues.set(day, await getJSON(`data/newsletter/${day}.json`));
    if (S.view !== 'newsletter') return;
    main.innerHTML = newsletterHtml(day ? NL.issues.get(day) : null);
  } catch { NL.list = []; main.innerHTML = newsletterHtml(null); }
}
function subscribeHtml() {
  const user = S.config.newsletter?.buttondown;
  const fams = S.config.families.map(f => `<label class="pick-opt"><input type="checkbox" name="tag" value="${esc(f.key)}" ${nlFamilies().includes(f.key) ? 'checked' : ''}><i class="dot" style="background:${famVar(f.key)}"></i><span>${esc(f.label)}</span></label>`).join('');
  return `<div class="panel subscribe"><span class="eyebrow">Subscribe</span><h3>Two pages every week, after the update</h3>
    <p class="small muted">Page 1: what the week added, highlights, the methods and identification strategies in use, three-month trends. Page 2: the fields you pick, with each paper's contribution and how it relates to earlier work in the radar.</p>
    ${user ? `<form action="https://buttondown.com/api/emails/embed-subscribe/${esc(user)}" method="post" target="_blank" class="sub-form">
      <input type="email" name="email" required placeholder="you@university.edu" aria-label="Email address" autocomplete="email">
      <fieldset><legend class="small muted">Your fields (page 2)</legend><div class="sub-fams">${fams}</div></fieldset>
      <button type="submit" class="btn">Subscribe</button><p class="small muted">You will get a confirmation email. Unsubscribe or change fields from any issue.</p></form>`
    : '<p class="small muted"><b>Subscriptions open soon.</b> Meanwhile, every issue is here.</p>'}</div>`;
}
const nlFamilies = () => (Array.isArray(S.prefs.nlFamilies) ? S.prefs.nlFamilies.filter(k => S.ctx.families.has(k)) : []);
function nlPaper(r, related = false) {
  const inRadar = S.byId?.has(r.id);
  return `<div class="nl-paper"><button type="button" class="link" ${inRadar ? `data-open="${esc(r.id)}"` : ''}>${esc(r.title)}</button>
    <small>${esc(r.journalName || r.journal)} · ${esc(r.authors.join(', '))}${r.moreAuthors ? ` +${r.moreAuthors}` : ''}${r.published ? ' · ' + dayLabel(r.published) : ''}</small>
    ${r.contribution ? `<p class="p-line${r.byModel ? '' : ' auto'}"><b>Contribution</b>${esc(r.contribution)}</p>` : r.q ? `<p class="p-line auto"><b>Question</b>${esc(r.q)}</p>` : ''}
    ${r.ident ? `<p class="p-line${r.byModel ? '' : ' auto'}"><b>Identification</b>${esc(r.ident)}</p>` : ''}
    ${related && r.related?.length ? `<p class="small muted nl-rel"><b>Relates to</b> ${r.related.map(x => `<button type="button" class="link" ${S.byId?.has(x.id) ? `data-open="${esc(x.id)}"` : ''}>${esc(x.title)}</button> (${esc(x.journal)} ${esc(x.year)}${x.why.length ? ', shares ' + esc(x.why.join(', ')) : ''})`).join('; ')}</p>` : ''}</div>`;
}
function newsletterHtml(issue) {
  const pick = nlFamilies();
  const head = `<div class="heading"><div><span class="eyebrow">Weekly newsletter</span><h1>${issue ? 'Week of ' + dayLabel(issue.date, { day: 'numeric', month: 'long', year: 'numeric' }) : 'The weekly issue'}</h1>
    <p>Each week, after the update, a two-page recap of what EconRadar added. Read it here or get it by email.</p></div>
    ${NL.list?.length > 1 ? `<select id="nl-issue" aria-label="Issue">${NL.list.map(d => `<option value="${d}" ${issue?.date === d ? 'selected' : ''}>${dayLabel(d)}</option>`).join('')}</select>` : ''}</div>`;
  if (!issue) return `${head}<div class="grid-2"><div class="empty"><h2>No issue yet</h2><p>The first issue comes out after the next weekly update.</p></div>${subscribeHtml()}</div>`;
  const c = issue.counts, tr = issue.trends;
  const trendRows = (name, rows) => rows?.length ? `<li><b>${name}</b> ${rows.slice(0, 4).map(r => `${esc(r.label)} <span class="muted">${pct(r.before)} → ${pct(r.recent)}</span>`).join(' · ')}</li>` : '';
  const fams = Object.entries(issue.families).filter(([, f]) => f.count);
  const shown = fams.filter(([k]) => !pick.length || pick.includes(k));
  return `${head}
    <div class="nl-layout"><div>
    <section class="panel nl-page"><span class="eyebrow">Page 1 · The week in economics research</span>
      <p><b>${fmt(c.total)} new papers</b>: ${fmt(c.journals)} in the journals and ${fmt(c.nber)} NBER working papers. The radar now holds ${fmt(c.corpus)} papers published since 2020.</p>
      ${issue.brief ? `<p class="nl-brief">${esc(issue.brief)}</p>` : ''}
      <h3>Highlights</h3>${issue.highlights.map(r => nlPaper(r)).join('')}
      ${issue.ident.length || issue.methods.length ? `<h3>How this week's papers are identified and estimated</h3><ul class="nl-list">
        ${issue.ident.length ? `<li><b>Identification</b> ${issue.ident.map(m => `${esc(m.label)} (${m.count})`).join(' · ')}</li>` : ''}
        ${issue.methods.length ? `<li><b>Approaches</b> ${issue.methods.map(m => `${esc(m.label)} (${m.count})`).join(' · ')}</li>` : ''}</ul>` : ''}
      ${tr.methods.length || tr.topics.length || tr.data.length ? `<h3>Rising over the past three months</h3><p class="small muted">Share of papers published in the last 90 days, against the twelve months before.</p><ul class="nl-list">${trendRows('Methods', tr.methods)}${trendRows('Topics', tr.topics)}${trendRows('Data', tr.data)}</ul>` : ''}
    </section>
    <section class="panel nl-page"><span class="eyebrow">Page 2 · Your fields</span>
      <div class="chips" role="group" aria-label="Fields shown on page 2">${fams.map(([k, f]) => `<button type="button" class="chip btnish" data-nl-fam="${k}" aria-pressed="${pick.includes(k)}"><i class="dot" style="background:${famVar(k)}"></i>${esc(f.label)} <span class="muted">${f.count}</span></button>`).join('')}</div>
      <p class="small muted">${pick.length ? 'Showing the fields you picked (remembered on this device).' : 'Showing every field. Pick yours to keep page 2 to them.'}</p>
      ${shown.map(([k, f]) => `<div class="nl-fam"><h3><i class="dot" style="background:${famVar(k)}"></i>${esc(f.label)} <span class="muted">· ${f.count} new</span></h3>
        ${f.note ? `<p class="nl-brief">${esc(f.note)}</p>` : ''}${f.papers.map(r => nlPaper(r, true)).join('')}
        ${f.authors.length ? `<p class="small"><b>Active this week</b> ${f.authors.map(a => `${esc(a.name)} <span class="muted">(${a.before ? `${a.before} earlier in the radar` : 'new to the radar'})</span>`).join(' · ')}</p>` : ''}
        ${f.methods.length ? `<p class="small"><b>Methods</b> ${esc(f.methods.join(', '))}</p>` : ''}</div>`).join('')}
    </section></div>
    <aside>${subscribeHtml()}<p class="small muted" style="margin-top:12px">Summaries are written by a language model from abstracts and open-access conclusions; check the paper before citing it.</p></aside></div>`;
}

async function renderFocus() {
  try { focusModule ||= await import('./focus.mjs?v=4'); }
  catch (e) { $('#main').innerHTML = `<div class="empty"><h2>The Focus tab could not load</h2><p>${esc(e.message)}</p></div>`; return; }
  if (S.view !== 'focus') return;
  focusModule.show($('#main'), { S, C, $, $$, esc, fmt, pct, plural, dayLabel, toast, download, showTip, hideTip, getJSON, local, renderNav, createNetwork });
}
const emptyRadar = () => `<div class="empty"><h2>The radar is empty</h2><p>No papers have been collected yet. The collector runs every Tuesday and Friday; you can also start it by hand (see Sources).</p><a class="btn" href="#sources">Sources & setup</a></div>`;

// ---- paper cards --------------------------------------------------------------------
const journalShort = k => S.ctx.journals.get(k)?.short || k;
const isNewToYou = p => S.prevVisit && p.added > S.prevVisit;

function authorLinks(p, max = 8) {
  const list = p.authors.slice(0, max).map(a => { const k = C.authorKey(a); return `<button type="button" data-act="author" data-key="${esc(k)}" class="${S.user.follow[k] ? 'followed' : ''}">${esc(a.n)}</button>`; });
  if (p.authors.length > max) list.push(`<span>+${p.authors.length - max}</span>`);
  return list.join('<span aria-hidden="true">·</span>');
}
function tagChips(p, { firstsToo = true } = {}) {
  const chips = [
    ...p.fields.map(k => `<button type="button" class="chip btnish" data-act="tag" data-kind="fields" data-key="${k}">${fieldDot(k)}${esc(S.ctx.label('field', k))}</button>`),
    ...p.methods.map(k => `<button type="button" class="chip btnish method" data-act="tag" data-kind="methods" data-key="${k}">${esc(S.ctx.label('method', k))}</button>`),
    ...p.data.map(k => `<button type="button" class="chip btnish data" data-act="tag" data-kind="data" data-key="${k}">${esc(S.ctx.label('data', k))}</button>`),
    ...p.topics.slice(0, 4).map(t => `<button type="button" class="chip btnish topic" data-act="search" data-q="${esc(t)}">${esc(t)}</button>`),
  ];
  if (firstsToo) for (const item of (S.firsts.get(p.id) || []).filter(i => i.kind !== 'topic').slice(0, 2)) chips.push(`<span class="chip first" title="New to the radar since it started">✦ ${esc(C.describeFirst(item, S.ctx))}</span>`);
  return chips.join('');
}
// Contribution and identification, labelled; rule-extracted text is shown muted.
function keyLines(p) {
  const auto = C.byModel(p) ? '' : ' auto';
  const design = p.methods.filter(m => S.ctx.methods.get(m)?.group !== 'other').map(m => S.ctx.label('method', m));
  const ident = p.ident || (design.length ? design.join(' · ') : '');
  return (p.contribution ? `<p class="p-line${auto}"><b>Contribution</b>${esc(p.contribution)}</p>` : '')
    + (ident ? `<p class="p-line${auto}"><b>Identification</b>${esc(ident)}</p>` : '');
}
function paperCard(p) {
  const saved = !!S.user.saved[p.id], read = !!S.user.read[p.id], model = C.byModel(p);
  const question = p.q ? `<p class="p-question ${model ? '' : 'auto'}">${model ? esc(p.q) : `<span class="badge auto">AUTO-EXTRACTED</span> ${esc(p.q)}`}</p>` : '';
  const conclusion = p.conclusion ? `<details class="more"><summary>${p.text.includes('conclusion') ? 'Conclusion' : 'Implications'}</summary><p class="p-summary">${esc(p.conclusion)}</p></details>` : '';
  return `<article class="paper ${read ? 'is-read' : ''}" data-id="${esc(p.id)}">
    <div class="p-meta"><span class="journal">${esc(journalShort(p.journal))}</span><span>${p.published ? 'Published ' + dayLabel(p.published) : ''}</span>${isNewToYou(p) ? '<span class="badge new">NEW</span>' : ''}${p.kind === 'review' ? '<span class="badge auto">SURVEY</span>' : ''}${p.kind === 'working' ? '<span class="badge auto">WORKING PAPER</span>' : ''}${S.user.notes[p.id] ? '<span class="badge auto">NOTE</span>' : ''}</div>
    <h3 class="p-title"><button type="button" data-act="open">${esc(p.title)}</button></h3>
    <div class="p-authors">${authorLinks(p)}</div>
    ${question}
    ${keyLines(p)}
    ${p.summary ? `<p class="p-summary">${esc(p.summary)}</p>` : '<p class="p-summary muted">No abstract was available from the indexes for this paper yet.</p>'}
    ${conclusion}
    <div class="p-tags">${tagChips(p)}</div>
    <div class="p-actions"><button type="button" class="icon-toggle" data-act="save" aria-pressed="${saved}">${saved ? '★ Saved' : '☆ Save'}</button><button type="button" class="icon-toggle" data-act="read" aria-pressed="${read}">${read ? '✓ Read' : 'Mark read'}</button>
      <a href="${esc(p.url)}" target="_blank" rel="noopener">Article ↗</a>${p.pdf ? `<a href="${esc(p.pdf)}" target="_blank" rel="noopener">Open-access PDF ↗</a>` : ''}<button type="button" class="text-btn" data-act="open">Details</button></div>
  </article>`;
}

function sortPapers(list) {
  const s = S.prefs.sort;
  if (s === 'published') return [...list].sort((a, b) => (b.published || '').localeCompare(a.published || '') || C.newestFirst(a, b));
  if (s === 'journal') return [...list].sort((a, b) => (S.ctx.journals.get(a.journal)?.rank ?? 99) - (S.ctx.journals.get(b.journal)?.rank ?? 99) || C.newestFirst(a, b));
  return [...list].sort(C.newestFirst);
}

// ---- Latest -------------------------------------------------------------------------
function latestHtml() {
  const list = sortPapers(S.visible), shown = list.slice(0, S.limit);
  const sinceVisit = S.prevVisit ? S.papers.filter(isNewToYou).length : 0;
  const modelShare = S.visible.length ? S.visible.filter(C.byModel).length / S.visible.length : 0;
  // One chip per day: several runs on the same day (a backfill, a manual re-run) are one update.
  const byDay = new Map();
  for (const r of S.index.runs || []) { const day = r.at.slice(0, 10); byDay.set(day, (byDay.get(day) || 0) + (r.added || 0)); }
  const runs = [...byDay].slice(0, 8).map(([day, added]) => ({ at: day, added }));
  let body = '', lastDay = '';
  for (const p of shown) {
    if (S.prefs.sort === 'added' && p.added !== lastDay) {
      lastDay = p.added;
      const n = list.filter(x => x.added === p.added).length;
      const first = (S.index.runs || []).at(-1);
      const seedNote = first && first.at.slice(0, 10) === p.added && first.since ? ` · first collection, papers published since ${dayLabel(first.since)}` : '';
      body += `${body ? '</div>' : ''}<div class="day-head"><h2>${dayLabel(p.added, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h2><span>${plural(n, 'paper')} added${seedNote}</span></div><div class="papers">`;
    }
    body += paperCard(p);
  }
  if (S.prefs.sort === 'added' && body) body += '</div>'; else body = `<div class="papers">${body}</div>`;
  return `<div class="heading"><div><span class="eyebrow">${S.lastRun ? 'Updated ' + dayLabel(S.lastRun) : 'EconRadar'}</span><h1>Latest papers</h1>
      <p>New articles from ${S.config.journals.filter(j => j.enabled !== false && j.kind !== 'working').length} journals${S.config.journals.some(j => j.enabled !== false && j.kind === 'working') ? ' and ' + S.config.journals.filter(j => j.enabled !== false && j.kind === 'working').map(j => j.short.replace(/ WP$/, '')).join(', ') + ' working papers' : ''}, each with its research question, a summary, and tags for field, method and data. Click any tag to filter by it.</p></div>
      <div class="toolbar"><select id="sort" aria-label="Sort papers">${[['added', 'Date added'], ['published', 'Publication date'], ['journal', 'Journal']].map(([v, l]) => `<option value="${v}" ${S.prefs.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="export" aria-label="Export these papers"><option value="">Export…</option><option value="bib">BibTeX</option><option value="ris">RIS (Zotero)</option><option value="csv">CSV</option></select></div></div>
    <div class="stats"><div class="stat"><strong>${fmt(S.visible.length)}</strong><span>papers in view</span></div>
      <div class="stat"><strong>${fmt(sinceVisit)}</strong><span>new since your last visit${S.prevVisit ? ' (' + dayLabel(S.prevVisit, { day: 'numeric', month: 'short' }) + ')' : ''}</span></div>
      <div class="stat"><strong>${pct(modelShare)}</strong><span>summarised by the model; the rest are auto-extracted</span></div>
      <div class="stat"><strong>${fmt(new Set(S.visible.map(p => p.journal)).size)}</strong><span>journals represented</span></div></div>
    ${runs.length > 1 ? `<div class="chips" aria-label="Recent updates">${runs.map(r => `<button type="button" class="chip btnish" data-act="run" data-day="${r.at.slice(0, 10)}" aria-pressed="${S.filters.run === r.at.slice(0, 10)}" title="Papers added in this update">${dayLabel(r.at.slice(0, 10), { day: 'numeric', month: 'short' })} · ${plural(r.added, 'paper')}</button>`).join('')}</div>` : ''}
    ${shown.length ? body : '<div class="empty"><h2>Nothing matches these filters</h2><p>Loosen a filter above, or clear them all.</p></div>'}
    ${list.length > shown.length ? `<div class="load-more"><button type="button" class="btn ghost" data-act="more">Show ${Math.min(30, list.length - shown.length)} more of ${fmt(list.length - shown.length)}</button></div>` : ''}`;
}

function exportPapers(kind, list = sortPapers(S.visible)) {
  if (!list.length) return toast('Nothing to export.');
  const stamp = S.today;
  if (kind === 'bib') download(`econradar-${stamp}.bib`, list.map(p => C.toBibtex(p, S.ctx)).join('\n\n'), 'application/x-bibtex');
  if (kind === 'ris') download(`econradar-${stamp}.ris`, list.map(p => C.toRis(p, S.ctx)).join('\r\n'), 'application/x-research-info-systems');
  if (kind === 'csv') download(`econradar-${stamp}.csv`, '﻿' + C.toCsv(list, S.ctx), 'text/csv');
  toast(`Exported ${plural(list.length, 'paper')}.`);
}

// ---- paper dialog -------------------------------------------------------------------
function related(p, n = 5) {
  const score = q => {
    let s = 0;
    s += 3 * q.authors.filter(a => p.authors.some(b => C.authorKey(a) === C.authorKey(b))).length;
    s += 2 * q.topics.filter(t => p.topics.includes(t)).length;
    s += q.methods.filter(m => p.methods.includes(m)).length + 0.5 * q.data.filter(d => p.data.includes(d)).length + 0.5 * q.fields.filter(f => p.fields.includes(f)).length;
    return s;
  };
  return S.papers.filter(q => q.id !== p.id).map(q => [q, score(q)]).filter(([, s]) => s >= 2.5).sort((a, b) => b[1] - a[1]).slice(0, n).map(([q]) => q);
}
function openPaper(id) {
  const p = S.byId?.get(id) || S.papers.find(x => x.id === id);
  if (!p) return;
  const year = (p.published || p.added).slice(0, 4);
  if (!p.abstract && !abstractsLoaded.has(year)) { loadAbstracts(year).then(() => { if ($('#dialog').open) openPaper(id); }); }
  const saved = !!S.user.saved[p.id], read = !!S.user.read[p.id];
  const row = (label, value) => (value ? `<dt>${label}</dt><dd>${value}</dd>` : '');
  const firsts = (S.firsts.get(p.id) || []).map(i => `<span class="chip first">✦ ${esc(C.describeFirst(i, S.ctx))}</span>`).join('');
  $('#dialog-content').innerHTML = `<span class="eyebrow">${esc(S.ctx.journals.get(p.journal)?.name || p.journal)}${p.published ? ' · ' + dayLabel(p.published) : ''}</span>
    <h2>${esc(p.title)}</h2>
    <div class="p-authors">${authorLinks(p, 40)}</div>
    ${p.q ? `<p class="p-question ${C.byModel(p) ? '' : 'auto'}" style="margin-top:14px">${esc(p.q)}</p>` : ''}
    <div style="display:grid;gap:6px;margin:10px 0">${keyLines(p)}</div>
    <p class="p-summary">${esc(p.summary)}</p>
    ${p.conclusion ? `<h3 style="margin-top:14px">${p.text.includes('conclusion') ? 'What the conclusion says' : 'Implications'}</h3><p class="p-summary">${esc(p.conclusion)}</p>` : ''}
    <dl class="detail-grid">
      ${row('Data', esc([p.dataDetail, p.data.map(k => S.ctx.label('data', k)).join(', ')].filter(Boolean).join(' — ')))}
      ${row('Setting', esc([p.geo.join(', '), p.period].filter(Boolean).join(' · ')))}${row('Fields', p.fields.map(k => fieldDot(k) + ' ' + esc(S.ctx.label('field', k))).join(', '))}
      ${row('Methods', esc(p.methods.map(k => S.ctx.label('method', k)).join(', ')))}${row('Topics', esc(p.topics.join(', ')))}${row('JEL', esc(p.jel.join(', ')))}
      ${row('Added to radar', dayLabel(p.added))}${row('Summary from', esc((C.byModel(p) ? p.by : 'automatic extraction (no model yet)') + (p.text.length ? ` · based on the ${p.text.join(' and ')}` : ' · title only') + (p.corrected ? ` · corrected ${dayLabel(p.corrected)} after a reader's flag` : '')))}
      ${row('Institutions', esc([...new Set(p.authors.map(a => a.inst).filter(Boolean))].join('; ')))}
    </dl>
    ${firsts ? `<div class="chips" style="margin-bottom:12px">${firsts}</div>` : ''}
    ${p.abstract ? `<details class="more"><summary>Abstract excerpt (as indexed)</summary><p class="p-summary">${esc(p.abstract)}</p></details>` : ''}
    <div class="p-actions" style="margin:14px 0" data-id="${esc(p.id)}"><button type="button" class="icon-toggle" data-act="save" aria-pressed="${saved}">${saved ? '★ Saved' : '☆ Save'}</button><button type="button" class="icon-toggle" data-act="read" aria-pressed="${read}">${read ? '✓ Read' : 'Mark read'}</button>
      <a class="btn small" href="${esc(p.url)}" target="_blank" rel="noopener">Article ↗</a>${p.pdf ? `<a class="btn ghost small" href="${esc(p.pdf)}" target="_blank" rel="noopener">Open-access PDF ↗</a>` : ''}
      <button type="button" class="btn ghost small" data-act="cite">Copy BibTeX</button><button type="button" class="btn ghost small" data-act="in-network">Show in network</button></div>
    ${(flag => flag ? `<p class="small muted flag-line">Something inaccurate in this summary? <a href="${esc(flag)}" target="_blank" rel="noopener">Flag it, with a note ↗</a></p>` : '')(C.flagUrl(S.config.feedback?.form, p))}
    <label class="small muted" for="note">Your note (stays on this device)</label><textarea id="note" data-note="${esc(p.id)}" placeholder="Why it matters, what to check, how it relates to your work…">${esc(S.user.notes[p.id] || '')}</textarea>
    ${(() => { const rel = related(p); return rel.length ? `<h3 style="margin-top:18px">Related papers in the radar</h3>${rel.map(q => `<div class="mini-paper"><button type="button" data-open="${esc(q.id)}">${esc(q.title)}</button><small>${esc(journalShort(q.journal))} · ${dayLabel(q.published || q.added)}</small></div>`).join('')}` : ''; })()}`;
  const d = $('#dialog');
  if (!d.open) d.showModal();
  d.scrollTop = 0;
}

// ---- shared click handling -------------------------------------------------------------
function onMainClick(e) {
  const t = e.target.closest('[data-act],[data-open],[data-select],[data-goto],[data-nl-fam]');
  if (!t) return;
  if (t.dataset.open) return openPaper(t.dataset.open);
  if (t.dataset.select) return selectNode(t.dataset.select, true);
  if (t.dataset.goto) { location.hash = t.dataset.goto; return; }
  if (t.dataset.nlFam) { const list = nlFamilies(), k = t.dataset.nlFam; S.prefs.nlFamilies = list.includes(k) ? list.filter(x => x !== k) : [...list, k]; savePrefs(); renderNewsletter(); return; }
  const card = t.closest('[data-id]'), id = card?.dataset.id, act = t.dataset.act;
  if (act === 'open') openPaper(id);
  else if (act === 'save' || act === 'read') {
    const key = act === 'save' ? 'saved' : 'read', on = !S.user[key][id];
    if (on) S.user[key][id] = S.today; else delete S.user[key][id];
    saveUser();
    for (const btn of $$(`[data-id="${CSS.escape(id)}"] [data-act="${act}"]`)) { btn.setAttribute('aria-pressed', String(on)); btn.textContent = act === 'save' ? (on ? '★ Saved' : '☆ Save') : (on ? '✓ Read' : 'Mark read'); }
    $$(`article.paper[data-id="${CSS.escape(id)}"]`).forEach(a => a.classList.toggle('is-read', act === 'read' ? on : a.classList.contains('is-read')));
  }
  else if (act === 'author') { $('#dialog').open && $('#dialog').close(); location.hash = 'author/' + encodeURIComponent(t.dataset.key); }
  else if (act === 'tag') { $('#dialog').open && $('#dialog').close(); setFilter(f => { if (!f[t.dataset.kind].includes(t.dataset.key)) f[t.dataset.kind].push(t.dataset.key); }); toast(`Filtered by ${t.textContent.trim()}`); }
  else if (act === 'search') { setFilter(f => { f.q = t.dataset.q; }); toast(`Searching “${t.dataset.q}”`); }
  else if (act === 'more') { S.limit += 30; const y = window.scrollY; $('#main').innerHTML = latestHtml(); window.scrollTo(0, y); }
  else if (act === 'run') setFilter(f => { f.run = f.run === t.dataset.day ? '' : t.dataset.day; });
  else if (act === 'cite') { const p = S.papers.find(x => x.id === id); navigator.clipboard?.writeText(C.toBibtex(p, S.ctx)).then(() => toast('BibTeX copied.'), () => toast('Copy failed; use Export instead.')); }
  else if (act === 'in-network') { $('#dialog').close(); S.prefs.lens = 'papers'; savePrefs(); S.net.pending = id; location.hash = 'network'; if (S.view === 'network') renderNetwork(); }
  else if (act === 'follow') { const k = t.dataset.key, on = !S.user.follow[k]; if (on) S.user.follow[k] = S.today; else delete S.user.follow[k]; saveUser(); t.setAttribute('aria-pressed', String(on)); t.textContent = on ? '★ Following' : '☆ Follow'; toast(on ? 'Following — their new papers are marked in Latest.' : 'Unfollowed.'); }
  else if (act === 'author-sort') { S.prefs.authorSort = t.dataset.value; savePrefs(); $('#main').innerHTML = authorsHtml(); }
  else if (act === 'export-user') download(`econradar-personal-${S.today}.json`, JSON.stringify(S.user, null, 1), 'application/json');
  else if (act === 'import-user') $('#import-file')?.click();
  else if (act === 'export-all') exportPapers(t.dataset.kind, sortPapers(S.papers));
}

// ---- Network ------------------------------------------------------------------------
const LENSES = { strands: 'Strands', papers: 'Papers', authors: 'Authors' };
const LENS_TEXT = {
  strands: 'Fields, methods, data sources and topics, linked whenever they meet in the same paper. Bigger means more papers; thicker means more often together. Dashed ink links and ringed nodes appeared recently.',
  papers: 'Each paper linked to its closest neighbours. Choose what they must share: topic and literature, methodological approach, identification strategy, data or authors (or everything at once). Click a paper to see what it shares with each neighbour.',
  authors: 'Authors (circles) linked to the fields they publish in (squares) and to their co-authors. Colour is the author’s main field family.',
};
function newSinceDate() {
  const h = S.prefs.highlight;
  const runs = S.index.runs || [];
  if (h === 'auto') return runs.length > 1 ? S.lastRun : '';
  if (h === 'last-run') return S.lastRun;
  if (h === 'none') return '';
  return C.addDays(S.today, -Number(h));
}
const pubDate = p => p.published || p.added;

function netPapers() {
  const steps = S.net.steps || [];
  const cut = S.net.step != null && S.net.step < steps.length - 1 ? steps[S.net.step] : '';
  return cut ? S.visible.filter(p => pubDate(p) <= cut) : S.visible;
}
function buildGraph() {
  const lens = S.prefs.lens, papers = netPapers();
  const playing = S.net.step != null && S.net.step < (S.net.steps || []).length - 1;
  const newSince = playing ? (S.net.steps[S.net.step - 1] ? C.addDays(S.net.steps[S.net.step - 1], 1) : '') : newSinceDate();
  const dateOf = playing ? pubDate : p => p.added;
  if (lens === 'papers') return C.paperGraph(papers, S.ctx, { max: S.prefs.maxPapers, newSince, dateOf, match: C.MATCHES[S.prefs.match] ? S.prefs.match : 'all' });
  if (lens === 'authors') return C.authorGraph(papers, S.ctx, { minPapers: S.prefs.minAuthorPapers, newSince, dateOf });
  return C.strandsGraph(papers, S.ctx, { kinds: S.prefs.kinds, minEdge: S.prefs.minEdge, maxTopics: S.prefs.maxTopics, newSince, dateOf });
}
function lookFor(lens) {
  const method = rootStyle().getPropertyValue('--kind-method').trim(), data = rootStyle().getPropertyValue('--kind-data').trim();
  const showNew = true;
  if (lens === 'papers') return { showNew, labelAt: 30, fill: n => famColor(n.family), size: n => 3.5 + 2.2 * Math.sqrt(n.count) };
  if (lens === 'authors') return { showNew, labelAt: 9, fill: n => famColor(n.family), shape: n => (n.kind === 'field' ? 'square' : 'circle'), labelAlways: n => n.kind === 'field', size: (n, max) => (n.kind === 'field' ? 7 + 12 * Math.sqrt(n.count / max) : 3 + 2.6 * Math.sqrt(n.count)) };
  return {
    showNew, labelAt: 10,
    fill: n => (n.kind === 'method' ? method : n.kind === 'data' ? data : famColor(n.family)),
    shape: n => (n.kind === 'method' ? 'square' : n.kind === 'data' ? 'diamond' : 'circle'),
    hollow: n => n.kind === 'topic', labelAlways: n => n.kind === 'field',
    size: (n, max) => (n.kind === 'topic' ? 3.5 : 5) + (n.kind === 'topic' ? 9 : 15) * Math.sqrt(n.count / max),
  };
}
function legendHtml(lens) {
  const fams = S.config.families.map(f => `<span><i class="dot" style="background:${famVar(f.key)}"></i>${esc(f.label)}</span>`).join('');
  const shapes = lens === 'strands' ? '<span><i class="legend-shape circle" style="background:var(--muted)"></i>Field</span><span><i class="legend-shape"></i>Method</span><span><i class="legend-shape diamond"></i>Data</span><span><i class="legend-shape ring"></i>Topic</span>'
    : lens === 'authors' ? '<span><i class="legend-shape circle" style="background:var(--muted)"></i>Author</span><span><i class="legend-shape" style="background:var(--muted)"></i>Field</span>' : '<span><i class="legend-shape circle" style="background:var(--muted)"></i>Paper</span>';
  return `${shapes}<span><i class="legend-line"></i>New</span>${fams}`;
}

function renderNetwork(keep = false) {
  const lens = S.prefs.lens;
  const pubs = [...new Set(S.visible.map(pubDate))].sort();
  // Weekly steps for the history replay.
  const steps = [];
  for (const d of pubs) { const wk = C.addDays(d, -((new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7) + 6); if (steps.at(-1) !== wk) steps.push(wk); }
  if (steps.length) steps[steps.length - 1] = pubs.at(-1) > steps.at(-1) ? pubs.at(-1) : steps.at(-1);
  S.net.steps = steps;
  if (S.net.step == null || S.net.step >= steps.length || !keep) S.net.step = steps.length - 1;
  const slider = $('#net-step');
  if (keep && slider) { slider.max = Math.max(0, steps.length - 1); slider.value = S.net.step; }
  if (!keep || !S.network) {
    if (S.network) { S.network.destroy(); S.network = null; }
    const opts = lens === 'strands'
      ? `<span class="toolbar" role="group" aria-label="Node kinds">${[['field', 'Fields'], ['method', 'Methods'], ['data', 'Data'], ['topic', 'Topics']].map(([k, l]) => `<button type="button" class="btn ghost small" data-kind-toggle="${k}" aria-pressed="${!!S.prefs.kinds[k]}">${l}</button>`).join('')}</span>
         <label class="inline">Min. link <select id="net-min">${[1, 2, 3, 4, 6].map(v => `<option ${S.prefs.minEdge === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
         <label class="inline">Topics <select id="net-topics">${[15, 30, 45, 80, 150].map(v => `<option ${S.prefs.maxTopics === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>`
      : lens === 'papers' ? `<label class="inline">Match papers by <select id="net-match">${Object.entries(C.MATCHES).map(([k, m]) => `<option value="${k}" ${S.prefs.match === k ? 'selected' : ''}>${m.label}</option>`).join('')}</select></label>
         <label class="inline">Papers <select id="net-max">${[150, 400, 800].map(v => `<option ${S.prefs.maxPapers === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>`
        : `<label class="inline">Authors with at least <select id="net-minauth">${[[0, 'auto'], [1, '1 paper'], [2, '2 papers'], [3, '3 papers']].map(([v, l]) => `<option value="${v}" ${S.prefs.minAuthorPapers === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
    $('#main').innerHTML = `<div class="heading"><div><h1>Research network</h1><p>${LENS_TEXT[lens]}</p></div>
        <div class="seg" role="group" aria-label="Lens">${Object.entries(LENSES).map(([k, l]) => `<button type="button" data-lens="${k}" aria-pressed="${lens === k}">${l}</button>`).join('')}</div></div>
      <div class="toolbar" style="margin-bottom:12px">${opts}
        <label class="inline">Highlight new <select id="net-new">${[['auto', 'since last update'], ['30', 'past 30 days'], ['90', 'past 90 days'], ['none', 'off']].map(([v, l]) => `<option value="${v}" ${String(S.prefs.highlight) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <input type="search" id="net-find" placeholder="Find a node…" aria-label="Find a node in the network" style="min-width:170px">
        <button type="button" class="btn ghost small" id="net-fit">Fit to view</button></div>
      <div class="net-layout"><div><div class="net-stage" id="net-stage"><div class="net-legend" aria-hidden="true">${legendHtml(lens)}</div></div>
        <div class="timeline"><button type="button" class="btn small" id="net-play" aria-pressed="false">▶ Replay history</button><input type="range" id="net-step" min="0" max="${Math.max(0, steps.length - 1)}" value="${S.net.step}" aria-label="Show papers published up to"><output id="net-when"></output></div></div>
        <aside class="net-side" id="net-side" aria-live="polite"></aside></div>`;
    S.network = createNetwork($('#net-stage'), {
      label: `${LENSES[lens]} network of the papers in view`,
      onSelect: n => { S.net.prev = S.net.selected && n && S.net.selected !== n.id ? S.net.selected : null; S.net.selected = n ? n.id : null; sidePanel(); },
      onHover: (n, e) => { if (!n || !e) return hideTip(); showTip(tipFor(n), e.clientX, e.clientY); },
    });
  }
  drawNetwork();
}
function drawNetwork() {
  if (!S.network) return;
  const graph = buildGraph();
  S.net.graph = graph;
  S.network.render(graph, lookFor(S.prefs.lens));
  const papers = netPapers(), steps = S.net.steps;
  $('#net-when').textContent = steps.length ? `Published up to ${dayLabel(steps[S.net.step])} · ${plural(papers.length, 'paper')} · ${plural(graph.nodes.length, 'node')}` : '';
  if (S.net.pending) { const id = S.net.pending; S.net.pending = null; S.network.select(id, true); }
  else if (S.net.selected && S.network.node(S.net.selected)) S.network.select(S.net.selected);
  else { S.net.selected = null; }
  sidePanel();
}
function tipFor(n) {
  if (n.kind === 'paper') return `<b>${esc(n.label)}</b><span>${esc(journalShort(n.paper.journal))} · ${dayLabel(pubDate(n.paper))}</span>`;
  const kind = { field: 'Field', method: 'Method', data: 'Data', topic: 'Topic', author: 'Author' }[n.kind];
  return `<b>${esc(n.label)}</b><span>${kind} · ${plural(Math.round(n.count), 'paper')}${n.isNew ? ' · new' : ''}</span>`;
}
function selectNode(id, focus) {
  if (!S.network) return;
  S.net.prev = S.net.selected && S.net.selected !== id ? S.net.selected : null;
  S.net.selected = id;
  S.network.select(id);
  if (focus) S.network.center(id);
  sidePanel();
}
function sparkline(papers) {
  if (!papers.length) return '';
  const mix = C.facetMix(papers.map(p => ({ ...p, one: ['x'] })), 'one', { by: 'month' });
  const vals = mix.totals, max = Math.max(1, ...vals);
  return `<div class="spark" role="img" aria-label="Papers per month: ${vals.join(', ')}">${vals.map((v, i) => `<i style="height:${Math.max(3, (v / max) * 100)}%" title="${mix.periods[i]}: ${v}"></i>`).join('')}</div><small class="muted">${esc(mix.periods[0])} → ${esc(mix.periods.at(-1))}, by publication month</small>`;
}
function miniPapers(list, n = 5) {
  return list.slice(0, n).map(p => `<div class="mini-paper"><button type="button" data-open="${esc(p.id)}">${esc(p.title)}</button><small>${esc(journalShort(p.journal))} · ${dayLabel(pubDate(p))}${p.q && C.byModel(p) ? ' — ' + esc(p.q) : ''}</small></div>`).join('');
}
function sidePanel() {
  const side = $('#net-side'); if (!side || !S.net.graph) return;
  const g = S.net.graph, papers = netPapers();
  const n = S.net.selected && S.network.node(S.net.selected);
  if (!n) {
    const top = [...g.nodes].sort((a, b) => b.count - a.count).slice(0, 10);
    const label = id => S.network.node(id)?._label || id;
    const ties = [...g.links].sort((a, b) => b.weight - a.weight).slice(0, 10);
    const fresh = g.links.filter(l => l.isNew).sort((a, b) => b.weight - a.weight).slice(0, 10);
    const tieLi = l => `<li><button type="button" data-select="${esc(l.source)}">${esc(label(l.source))} ↔ ${esc(label(l.target))}</button><span class="w">${S.prefs.lens === 'papers' ? '' : fmt(l.weight)}</span></li>`;
    side.innerHTML = `<div class="panel"><span class="kind">Overview</span><h3>${plural(papers.length, 'paper')} · ${plural(g.nodes.length, 'node')}</h3><p class="small muted">Click a node to see its ties, its papers and who works on it. Drag to rearrange, scroll or pinch to zoom.${g.truncated ? ` Showing the ${S.prefs.maxPapers} most recent papers.` : ''}</p></div>
      ${S.prefs.lens !== 'papers' ? `<div class="panel"><span class="kind">Most popular</span><ul class="tie-list">${top.map(x => `<li><button type="button" data-select="${esc(x.id)}">${esc(x._label || x.label)}</button><span class="w">${fmt(Math.round(x.count))}</span></li>`).join('')}</ul></div>` : ''}
      <div class="panel"><span class="kind">Newest ties</span>${fresh.length ? `<ul class="tie-list">${fresh.map(tieLi).join('')}</ul>` : '<p class="small muted">No ties first seen in the highlight window. Turn on a wider “Highlight new” window, or wait for the next update.</p>'}</div>
      <div class="panel"><span class="kind">Strongest ties</span><ul class="tie-list">${ties.map(tieLi).join('')}</ul></div>`;
    return;
  }
  const list = n.kind === 'paper' ? [n.paper] : C.papersForNode(n, papers);
  const ties = S.network.linksOf(n.id).map(l => ({ other: l.source.id === n.id ? l.target : l.source, w: l.weight, isNew: l.isNew, why: l.why || [] })).sort((a, b) => b.w - a.w);
  const prev = S.net.prev && S.network.node(S.net.prev);
  const pair = prev && prev.kind !== 'paper' && n.kind !== 'paper' ? C.papersForLink(prev, n, papers) : [];
  const authors = n.kind === 'author' || n.kind === 'paper' ? [] : C.ranked(list.reduce((o, p) => { p.authors.forEach(a => { o[a.n] = (o[a.n] || 0) + 1; }); return o; }, {}), 6);
  const kind = { field: 'Field', method: 'Method', data: 'Data source', topic: 'Topic', author: 'Author', paper: 'Paper' }[n.kind];
  const filterKey = { field: 'fields', method: 'methods', data: 'data', author: 'authors' }[n.kind];
  side.innerHTML = `<div class="panel"><span class="kind">${kind}</span><h3>${esc(n._label)}</h3>
      ${n.kind === 'paper' ? `<p class="p-summary">${esc(n.paper.q || n.paper.summary)}</p><div class="toolbar"><button type="button" class="btn small" data-open="${esc(n.paper.id)}">Open paper</button></div>`
      : `<p class="small muted">${plural(list.length, 'paper')} in view${n.isNew ? ' · <b>new</b>' : ''}</p>${sparkline(list)}
        <div class="toolbar" style="margin-top:10px">${filterKey ? `<button type="button" class="btn small" data-net-filter="${filterKey}" data-key="${esc(n.key)}">Filter everything by this</button>` : `<button type="button" class="btn small" data-net-search="${esc(n.key)}">Search this topic</button>`}${n.kind === 'author' ? `<a class="btn ghost small" href="#author/${encodeURIComponent(n.key)}">Profile</a>` : ''}</div>`}</div>
    ${pair.length ? `<div class="panel"><span class="kind">Papers combining</span><h3>${esc(prev._label)} + ${esc(n._label)}</h3>${miniPapers(pair, 6)}</div>` : ''}
    ${ties.length ? `<div class="panel"><span class="kind">Ties · click one, then another to see papers combining them</span><ul class="tie-list">${ties.slice(0, 14).map(t => `<li><button type="button" data-select="${esc(t.other.id)}">${esc(t.other._label)}${t.why.length ? `<small class="muted shared">shares: ${esc(C.describeShared(t.why, S.ctx, [n.paper, t.other.paper].filter(Boolean)).join(', '))}</small>` : ''}</button>${t.isNew ? '<span class="new-tag">NEW</span>' : ''}<span class="w">${S.prefs.lens === 'papers' ? '' : fmt(Math.round(t.w * 10) / 10)}</span></li>`).join('')}</ul></div>` : ''}
    ${authors.length ? `<div class="panel"><span class="kind">Most active authors here</span><ul class="tie-list">${authors.map(([name, c]) => `<li><span style="flex:1">${esc(name)}</span><span class="w">${c}</span></li>`).join('')}</ul></div>` : ''}
    ${n.kind !== 'paper' ? `<div class="panel"><span class="kind">Latest papers</span>${miniPapers(list, 6)}</div>` : ''}`;
}
function stopPlay() { clearInterval(S.playing); S.playing = 0; const b = $('#net-play'); if (b) { b.textContent = '▶ Replay history'; b.setAttribute('aria-pressed', 'false'); } }
function onNetworkEvent(e) {
  const t = e.target;
  if (e.type === 'click') {
    const b = t.closest('button'); if (!b) return;
    if (b.dataset.lens) { S.prefs.lens = b.dataset.lens; savePrefs(); S.net.selected = null; stopPlay(); renderNetwork(); }
    else if (b.dataset.kindToggle) { const k = b.dataset.kindToggle; S.prefs.kinds[k] = !S.prefs.kinds[k]; if (!Object.values(S.prefs.kinds).some(Boolean)) S.prefs.kinds.field = true; savePrefs(); b.setAttribute('aria-pressed', String(!!S.prefs.kinds[k])); drawNetwork(); }
    else if (b.id === 'net-fit') S.network?.fit();
    else if (b.dataset.netFilter) { setFilter(f => { if (!f[b.dataset.netFilter].includes(b.dataset.key)) f[b.dataset.netFilter].push(b.dataset.key); }); location.hash = 'latest'; }
    else if (b.dataset.netSearch) { setFilter(f => { f.q = b.dataset.netSearch; }); location.hash = 'latest'; }
    else if (b.id === 'net-play') {
      if (S.playing) return stopPlay();
      if (S.net.step >= S.net.steps.length - 1) S.net.step = 0;
      b.textContent = '❚❚ Pause'; b.setAttribute('aria-pressed', 'true');
      const advance = () => { if (S.net.step >= S.net.steps.length - 1) return stopPlay(); S.net.step++; $('#net-step').value = S.net.step; drawNetwork(); };
      drawNetwork();
      S.playing = setInterval(advance, matchMedia('(prefers-reduced-motion: reduce)').matches ? 1600 : 700);
    }
  } else if (e.type === 'change' || e.type === 'input') {
    if (t.id === 'net-step') { stopPlay(); S.net.step = +t.value; drawNetwork(); }
    if (e.type !== 'change') return;
    if (t.id === 'net-min') { S.prefs.minEdge = +t.value; savePrefs(); drawNetwork(); }
    if (t.id === 'net-topics') { S.prefs.maxTopics = +t.value; savePrefs(); drawNetwork(); }
    if (t.id === 'net-max') { S.prefs.maxPapers = +t.value; savePrefs(); drawNetwork(); }
    if (t.id === 'net-match') { S.prefs.match = t.value; savePrefs(); drawNetwork(); }
    if (t.id === 'net-minauth') { S.prefs.minAuthorPapers = +t.value; savePrefs(); drawNetwork(); }
    if (t.id === 'net-new') { S.prefs.highlight = t.value; savePrefs(); drawNetwork(); }
    if (t.id === 'net-find') { if (!S.network.find(t.value)) toast('No node by that name in this view.'); }
  }
}

// ---- Authors ------------------------------------------------------------------------
function familyCounts(a) {
  const o = {};
  for (const p of a.papers) for (const fam of new Set(p.fields.map(S.ctx.familyOf))) if (fam) o[fam] = (o[fam] || 0) + 1;
  return o;
}
function sortedAuthors(index) {
  const recentCut = C.addDays(S.today, -90);
  const recent = a => a.papers.filter(p => pubDate(p) >= recentCut).length;
  const list = [...index.values()];
  const s = S.prefs.authorSort;
  return list.sort(s === 'recent' ? (a, b) => b.last.localeCompare(a.last) || b.papers.length - a.papers.length
    : s === 'rising' ? (a, b) => recent(b) - recent(a) || b.papers.length - a.papers.length
      : s === 'name' ? (a, b) => a.name.split(' ').pop().localeCompare(b.name.split(' ').pop())
        : (a, b) => b.papers.length - a.papers.length || b.last.localeCompare(a.last));
}
function authorsHtml() {
  const index = C.authorIndex(S.visible);
  const list = sortedAuthors(index);
  const followedN = Object.keys(S.user.follow).length;
  const heatRows = list.slice(0, 22);
  const fams = S.config.families.filter(f => heatRows.some(a => familyCounts(a)[f.key]));
  const level = v => (v <= 0 ? '' : v === 1 ? 'l1' : v === 2 ? 'l2' : v === 3 ? 'l3' : v <= 5 ? 'l4' : v <= 8 ? 'l5' : 'l6');
  const sortBtn = (v, l) => `<button type="button" data-act="author-sort" data-value="${v}" aria-pressed="${S.prefs.authorSort === v}">${l}</button>`;
  const rows = list.slice(0, 80).map(a => {
    const fields = C.ranked(a.fields, 2).map(([k]) => `<span class="chip">${fieldDot(k)}${esc(S.ctx.label('field', k))}</span>`).join(' ');
    const methods = C.ranked(a.methods, 2).map(([k]) => esc(S.ctx.label('method', k))).join(', ');
    return `<tr><td><button type="button" class="link" data-goto="author/${encodeURIComponent(a.key)}">${esc(a.name)}</button>${S.user.follow[a.key] ? ' <span class="badge auto">FOLLOWING</span>' : ''}<br><small class="muted">${esc(a.inst)}</small></td>
      <td class="num">${a.papers.length}</td><td>${fields}</td><td class="small">${methods}</td><td class="small">${C.ranked(a.journals, 3).map(([k]) => esc(journalShort(k))).join(', ')}</td><td class="small nowrap">${dayLabel(a.last, { month: 'short', year: 'numeric' })}</td></tr>`;
  }).join('');
  return `<div class="heading"><div><h1>Who publishes on what</h1><p>${plural(index.size, 'author')} in the papers in view. Authors are matched by their OpenAlex id, so namesakes stay apart. Follow someone to have their new papers marked in Latest${followedN ? ` (you follow ${followedN})` : ''}.</p></div>
      <div class="seg" role="group" aria-label="Sort authors">${sortBtn('papers', 'Most papers')}${sortBtn('rising', 'Active last 90 days')}${sortBtn('recent', 'Most recent')}${sortBtn('name', 'A–Z')}</div></div>
    <div class="panel" style="margin-bottom:16px"><span class="eyebrow">Activity by field family · top ${heatRows.length} authors</span>
      <div class="table-scroll"><table class="heat"><thead><tr><th></th>${fams.map(f => `<th title="${esc(f.label)}"><i class="dot" style="background:${famVar(f.key)}"></i><br>${esc(f.label.split(/[ ,&]/)[0])}</th>`).join('')}</tr></thead>
      <tbody>${heatRows.map(a => { const c = familyCounts(a); return `<tr><th class="row" scope="row"><button type="button" data-goto="author/${encodeURIComponent(a.key)}">${esc(a.name)}</button></th>${fams.map(f => `<td class="${level(c[f.key] || 0)}" title="${esc(a.name)} · ${esc(f.label)}: ${c[f.key] || 0} paper(s)">${c[f.key] || ''}</td>`).join('')}</tr>`; }).join('')}</tbody></table></div>
      <p class="small muted" style="margin-top:8px">Darker cells mean more papers in that family (a paper counts once per family it touches).</p></div>
    <div class="panel table-scroll"><table class="data"><thead><tr><th>Author</th><th class="num">Papers</th><th>Main fields</th><th>Main methods</th><th>Journals</th><th>Latest</th></tr></thead><tbody>${rows}</tbody></table>
      ${list.length > 80 ? `<p class="small muted" style="margin-top:10px">Showing 80 of ${fmt(list.length)}. Narrow with the filters or the author search above.</p>` : ''}</div>`;
}
function bars(entries, color, labelOf, max = Math.max(1, ...entries.map(e => e[1]))) {
  return `<div class="bars">${entries.map(([k, v]) => `<div class="bar-row"><span title="${esc(labelOf(k))}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(labelOf(k))}</span><span class="track"><span class="fill" style="width:${(v / max) * 100}%;background:${color(k)}"></span></span><span class="n">${Math.round(v * 10) / 10}</span></div>`).join('')}</div>`;
}
function authorHtml(key) {
  const a = S.allAuthors.get(key);
  if (!a) return `<div class="empty"><h2>Author not found</h2><p>They may have left the radar's journals.</p><a class="btn" href="#authors">All authors</a></div>`;
  const following = !!S.user.follow[key];
  const co = C.ranked(a.coauthors, 12).map(([k, n]) => `<a class="chip btnish" href="#author/${encodeURIComponent(k)}">${esc(S.allAuthors.get(k)?.name || k)} · ${n}</a>`).join('');
  const papers = [...a.papers].sort(C.newestFirst);
  return `<div class="heading"><div><span class="eyebrow"><a href="#authors">Authors</a> / profile</span><h1>${esc(a.name)}</h1><p>${esc(a.inst)}${a.orcid ? ` · <a href="https://orcid.org/${esc(a.orcid)}" target="_blank" rel="noopener">ORCID</a>` : ''}${a.key.startsWith('A') ? ` · <a href="https://openalex.org/${esc(a.key)}" target="_blank" rel="noopener">OpenAlex profile</a>` : ''}</p></div>
      <div class="toolbar"><button type="button" class="btn" data-act="follow" data-key="${esc(key)}" aria-pressed="${following}">${following ? '★ Following' : '☆ Follow'}</button><button type="button" class="btn ghost" id="author-filter" data-key="${esc(key)}">Filter by this author</button></div></div>
    <div class="stats"><div class="stat"><strong>${a.papers.length}</strong><span>papers in the radar</span></div><div class="stat"><strong>${Object.keys(a.coauthors).length}</strong><span>co-authors</span></div>
      <div class="stat"><strong>${Object.keys(a.journals).length}</strong><span>journals</span></div><div class="stat"><strong>${dayLabel(a.last, { month: 'short', year: 'numeric' })}</strong><span>latest publication</span></div></div>
    <div class="grid-3"><div class="panel"><span class="eyebrow">Fields</span>${bars(C.ranked(a.fields, 6), k => famVar(S.ctx.familyOf(k)), k => S.ctx.label('field', k))}</div>
      <div class="panel"><span class="eyebrow">Methods</span>${bars(C.ranked(a.methods, 6), () => 'var(--seq-4)', k => S.ctx.label('method', k)) || '<p class="muted small">None tagged.</p>'}</div>
      <div class="panel"><span class="eyebrow">Topics & co-authors</span><div class="chips" style="margin-bottom:10px">${C.ranked(a.topics, 10).map(([t]) => `<span class="chip topic">${esc(t)}</span>`).join('')}</div><div class="chips">${co || '<span class="muted small">No co-authors in the radar.</span>'}</div></div></div>
    <div class="section-head"><h2>Papers</h2><p>Newest first</p></div><div class="papers">${papers.map(paperCard).join('')}</div>`;
}

// ---- Trends -------------------------------------------------------------------------
function scopeMatch(p) {
  const s = S.prefs.trendScope;
  if (!s) return true;
  const [kind, key] = s.split(':');
  return kind === 'family' ? p.fields.some(f => S.ctx.familyOf(f) === key) : p.fields.includes(key);
}
function stackedFamilies(papers, by) {
  const dated = papers.filter(pubDate);
  if (!dated.length) return '<p class="muted">No dated papers.</p>';
  const days = dated.map(pubDate).sort(), periods = C.periodsBetween(days[0], days.at(-1), by);
  const fams = S.config.families, idx = new Map(periods.map((k, i) => [k, i]));
  const counts = fams.map(() => periods.map(() => 0));
  for (const p of dated) { const fam = S.ctx.familyOf(p.fields[0]); const fi = fams.findIndex(f => f.key === fam); const pi = idx.get(C.periodOf(pubDate(p), by)); if (fi >= 0 && pi != null) counts[fi][pi]++; }
  const totals = periods.map((_, i) => counts.reduce((s, c) => s + c[i], 0));
  const W = 920, H = 280, m = { l: 40, r: 8, t: 12, b: 30 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = Math.max(1, ...totals), band = iw / periods.length, bw = Math.max(4, Math.min(56, band * 0.66));
  const raw = max / 4, mag = 10 ** Math.floor(Math.log10(raw || 1)), step = Math.max(1, [1, 2, 5, 10].map(x => x * mag).find(x => x >= raw));
  const ticks = []; for (let v = 0; v <= max; v += step) ticks.push(v);
  const y = v => m.t + ih - (v / max) * ih;
  let marks = '';
  periods.forEach((per, i) => {
    let acc = 0;
    const x = m.l + band * i + (band - bw) / 2;
    const top = fams.map((f, fi) => counts[fi][i] ? fi : -1).filter(v => v >= 0).at(-1);
    fams.forEach((f, fi) => {
      const v = counts[fi][i]; if (!v) return;
      const y0 = y(acc), y1 = y(acc + v); acc += v;
      const h = Math.max(0, y0 - y1 - (fi === top ? 0 : 2)); // 2px surface gap between segments
      const r = fi === top ? Math.min(4, h / 2, bw / 2) : 0;
      const d = `M${x},${y1 + h}V${y1 + r}${r ? `Q${x},${y1} ${x + r},${y1}` : ''}H${x + bw - r}${r ? `Q${x + bw},${y1} ${x + bw},${y1 + r}` : ''}V${y1 + h}Z`;
      marks += `<path d="${d}" fill="${famVar(f.key)}" data-tip="${esc(`<b>${f.label}</b><span>${per}: ${v} of ${totals[i]} papers (${pct(v / totals[i])})</span>`)}"></path>`;
    });
  });
  const every = Math.ceil(periods.length / 12);
  const xl = periods.map((p, i) => (i % every ? '' : `<text x="${m.l + band * i + band / 2}" y="${H - 8}" text-anchor="middle">${p}</text>`)).join('');
  const yl = ticks.map(v => `<g class="grid"><line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"></line></g><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('');
  const table = `<details class="more"><summary>Show as table</summary><div class="table-scroll"><table class="data"><thead><tr><th>Family</th>${periods.map(p => `<th class="num">${p}</th>`).join('')}</tr></thead><tbody>${fams.map((f, fi) => `<tr><td>${esc(f.label)}</td>${counts[fi].map(v => `<td class="num">${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
  return `<div class="legend">${fams.map(f => `<span><i style="background:${famVar(f.key)}"></i>${esc(f.label)}</span>`).join('')}</div>
    <div class="chart" data-chart><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Papers per ${by} by primary field family">${yl}${marks}${xl}</svg></div>${table}`;
}
function smallMultiples(papers, facet, by) {
  const mix = C.facetMix(papers, facet, { by, top: 9, dateOf: pubDate });
  if (!mix.periods.length) return '<p class="muted">No dated papers.</p>';
  const label = k => (facet === 'topics' ? k : S.ctx.label(facet === 'methods' ? 'method' : facet === 'data' ? 'data' : 'field', k));
  const series = mix.series.filter(s => s.key !== 'other');
  const shares = series.map(s => s.values.map((v, i) => (mix.totals[i] ? v / mix.totals[i] : 0)));
  const max = Math.max(0.05, ...shares.flat());
  const W = 260, H = 96, m = { l: 4, r: 4, t: 6, b: 16 }, iw = W - m.l - m.r, ih = H - m.t - m.b, band = iw / mix.periods.length, bw = Math.max(2, band * 0.7);
  return `<div class="grid-3">${series.map((s, si) => {
    const total = s.values.reduce((a, b) => a + b, 0);
    const marks = s.values.map((v, i) => { const h = (shares[si][i] / max) * ih; return v ? `<rect x="${m.l + band * i + (band - bw) / 2}" y="${m.t + ih - h}" width="${bw}" height="${Math.max(1, h)}" rx="${Math.min(2, bw / 2)}" fill="var(--seq-4)" data-tip="${esc(`<b>${label(s.key)}</b><span>${mix.periods[i]}: ${v} of ${mix.totals[i]} papers (${pct(shares[si][i])})</span>`)}"></rect>` : ''; }).join('');
    return `<div class="panel" style="padding:12px 14px"><div style="display:flex;justify-content:space-between;gap:8px;font-size:12.5px"><b style="font-weight:650">${esc(label(s.key))}</b><span class="muted">${total}</span></div>
      <div class="chart" data-chart><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label(s.key))}: share of papers per ${by}"><line x1="${m.l}" x2="${W - m.r}" y1="${m.t + ih}" y2="${m.t + ih}" stroke="var(--line)"></line>${marks}<text x="${m.l}" y="${H - 3}">${mix.periods[0]}</text><text x="${W - m.r}" y="${H - 3}" text-anchor="end">${mix.periods.at(-1)}</text></svg></div></div>`;
  }).join('')}</div><p class="small muted" style="margin-top:8px">Bar height is the share of papers in that ${by} using it, on a common scale (tallest = ${pct(max)}), so a busy month doesn't look like a trend.</p>`;
}
function trendsHtml() {
  const papers = S.visible.filter(scopeMatch), by = S.prefs.trendBy, facet = S.prefs.trendFacet;
  const scopeOpts = `<option value="">All fields</option>${S.config.families.map(f => `<optgroup label="${esc(f.label)}"><option value="family:${f.key}">All of ${esc(f.label)}</option>${S.config.fields.filter(x => x.family === f.key).map(x => `<option value="field:${x.key}">${esc(x.label)}</option>`).join('')}</optgroup>`).join('')}`;
  const facetLabel = { methods: 'Methods', data: 'Data sources', topics: 'Topics', fields: 'Fields' };
  const rise = (fc) => C.risers(papers, fc, { today: S.today, recentDays: 90, min: fc === 'topics' ? 3 : 4 });
  const lbl = (fc, k) => (fc === 'topics' ? k : S.ctx.label(fc === 'methods' ? 'method' : fc === 'data' ? 'data' : 'field', k));
  const riserList = (fc, list) => list.length ? list.map(x => `<div class="riser">${fc === 'fields' ? fieldDot(x.key) : ''}<span>${esc(lbl(fc, x.key))}</span><span class="delta">${x.change > 0 ? '▲' : '▼'} ${pct(x.shareBefore)} → ${pct(x.shareRecent)}</span></div>`).join('') : '<p class="small muted">Not enough history yet on both sides of the 90-day line.</p>';
  const ids = new Set(papers.map(p => p.id));
  const frontier = [...S.firsts].filter(([id]) => ids.has(id)).map(([id, items]) => [S.papers.find(p => p.id === id), items.filter(i => i.kind !== 'topic' && (!S.prefs.trendScope || !i.field || scopeMatch({ fields: [i.field] })))]).filter(([, items]) => items.length).sort((a, b) => C.newestFirst(a[0], b[0])).slice(0, 30);
  const questions = papers.filter(p => p.q && C.byModel(p)).sort((a, b) => pubDate(b).localeCompare(pubDate(a))).slice(0, 14);
  const questionsFallback = questions.length ? questions : papers.filter(p => p.q).sort((a, b) => pubDate(b).localeCompare(pubDate(a))).slice(0, 14);
  return `<div class="heading"><div><h1>How the literature moves</h1><p>Within the papers in view (${fmt(papers.length)}), by publication date: which fields are publishing, which methods and data are spreading, and what is new to each field.</p></div>
      <div class="toolbar"><select id="trend-scope" aria-label="Scope">${scopeOpts}</select><div class="seg" role="group" aria-label="Granularity"><button type="button" data-trend-by="quarter" aria-pressed="${by === 'quarter'}">Quarter</button><button type="button" data-trend-by="month" aria-pressed="${by === 'month'}">Month</button></div></div></div>
    <div class="panel" style="margin-bottom:16px"><span class="eyebrow">Papers per ${by}, by primary field family</span>${stackedFamilies(papers, by)}</div>
    <div class="section-head"><h2>${facetLabel[facet]} over time</h2><div class="seg" role="group" aria-label="Facet">${Object.entries(facetLabel).map(([k, l]) => `<button type="button" data-trend-facet="${k}" aria-pressed="${facet === k}">${l}</button>`).join('')}</div></div>
    ${smallMultiples(papers, facet, by)}
    <div class="section-head"><h2>Rising and fading</h2><p>Share of papers in the last 90 days against everything before</p></div>
    <div class="grid-2"><div class="panel"><span class="eyebrow">Methods</span>${(() => { const r = rise('methods'); return riserList('methods', [...r.slice(0, 5), ...r.slice(-3).filter(x => x.change < 0)]); })()}</div>
      <div class="panel"><span class="eyebrow">Topics</span>${(() => { const r = rise('topics'); return riserList('topics', [...r.slice(0, 5), ...r.slice(-3).filter(x => x.change < 0)]); })()}</div></div>
    <div class="grid-2" style="margin-top:16px"><div class="panel"><span class="eyebrow">Frontier log · first appearances since the radar started</span>
        ${frontier.length ? `<ul class="frontier">${frontier.map(([p, items]) => `<li><time>${dayLabel(p.added)}</time><div class="chips">${items.slice(0, 3).map(i => `<span class="chip first">✦ ${esc(C.describeFirst(i, S.ctx))}</span>`).join('')}</div><button type="button" class="link" data-open="${esc(p.id)}">${esc(p.title)}</button><small class="muted">${esc(journalShort(p.journal))}${p.dataDetail ? ' · ' + esc(p.dataDetail) : ''}</small></li>`).join('')}</ul>`
        : '<p class="small muted">The first collection is the baseline. From the next update on, papers that bring a method, data source or combination into a field for the first time are logged here.</p>'}</div>
      <div class="panel"><span class="eyebrow">Questions being asked</span><ul class="frontier">${questionsFallback.map(p => `<li><time>${esc(journalShort(p.journal))} · ${dayLabel(pubDate(p))}</time><button type="button" class="link" data-open="${esc(p.id)}">${esc(p.q)}</button></li>`).join('') || '<li class="muted small">No research questions yet.</li>'}</ul></div></div>`;
}

// ---- Sources ------------------------------------------------------------------------
function nextRun() {
  const now = new Date();
  for (let i = 0; i < 8; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i, 7, 30));
    if (d.getUTCDay() === 2 && d > now) return d;
  }
  return null;
}
function sourcesHtml() {
  const runs = S.index.runs || [], last = runs[0];
  const per = {}; const lastAdded = {};
  for (const p of S.papers) { per[p.journal] = (per[p.journal] || 0) + 1; if (!lastAdded[p.journal] || p.added > lastAdded[p.journal]) lastAdded[p.journal] = p.added; }
  const model = S.papers.filter(C.byModel).length, withConc = S.papers.filter(p => p.text.includes('conclusion')).length;
  const nr = nextRun();
  const journals = S.config.journalGroups.map(g => `<tr><th colspan="4" style="padding-top:16px">${esc(g.label)}</th></tr>${S.config.journals.filter(j => j.group === g.key).map(j => `<tr><td>${esc(j.name)} <span class="muted small">${esc(j.short)}</span></td><td class="num">${per[j.key] || 0}</td><td class="small">${lastAdded[j.key] ? dayLabel(lastAdded[j.key]) : '—'}</td><td class="small">${j.enabled === false ? 'Paused' : 'Collecting'}</td></tr>`).join('')}`).join('');
  return `<div class="heading"><div><h1>Sources & settings</h1><p>Where the papers come from, how they are summarised, and what stays on this device.</p></div></div>
    <div class="stats"><div class="stat"><strong>${fmt(S.papers.length)}</strong><span>papers kept in the radar</span></div><div class="stat"><strong>${last ? dayLabel(last.at.slice(0, 10), { day: 'numeric', month: 'short' }) : '—'}</strong><span>last update${last ? ` · ${last.added} added` : ''}</span></div>
      <div class="stat"><strong>${nr ? nr.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '—'}</strong><span>next weekly update (Tuesdays, morning, Paris time)</span></div><div class="stat"><strong>${pct(S.papers.length ? model / S.papers.length : 0)}</strong><span>summarised by a model · ${pct(S.papers.length ? withConc / S.papers.length : 0)} also read the conclusion</span></div></div>
    ${model < S.papers.length ? `<div class="notice" style="margin-bottom:16px"><b>${fmt(S.papers.length - model)} papers still have keyword-based summaries</b> (marked “auto-extracted”). They are being summarised in weekly batches, newest first.</div>` : ''}
    <div class="grid-2"><div class="panel setup"><span class="eyebrow">How it works</span>
        <ol><li>Every Tuesday morning, after NBER's Monday release, the collector asks <b>OpenAlex</b> for new articles in the ${S.config.journals.filter(j => j.kind !== 'working').length} journals below and reads <b>NBER</b>'s own list of working papers, each dated to its release day. The radar covers everything they published since ${dayLabel(S.config.since || '2020-01-01', { month: 'long', year: 'numeric' })}.</li>
        <li>Missing abstracts are filled from <b>Crossref</b> and <b>Semantic Scholar</b>. When a legal open-access copy exists, its <b>conclusion section</b> is read. Publishers that block scripts are skipped.</li>
        <li><b>Claude</b> then writes each paper's research question, contribution, summary and identification strategy, and tags its fields, methods, data, topics, setting and JEL codes against fixed lists. The tags are checked against those lists before anything is published.</li>
        <li>The <a href="#newsletter">weekly newsletter</a> recaps what the update added. Papers are never dropped, so the network and the trends build up over time.</li></ol></div>
      <div class="panel setup"><span class="eyebrow">Reading the summaries</span>
        <ol><li>Summaries come from the abstract and, when available, the conclusion: they are a guide to what to read, not a substitute. Check the paper before citing it.</li>
        <li>Lines marked <span class="badge auto">AUTO-EXTRACTED</span> are sentences taken from the abstract by keyword rules, waiting for their model summary.</li>
        <li>Saved papers, read marks, notes and followed authors stay in this browser only (back them up below). Nothing you do here is sent anywhere, except the email you give to subscribe.</li></ol></div></div>
    <div class="section-head"><h2>Journals & working papers</h2><p>Edit <code>radar/config.json</code> to add or pause one</p></div>
    <div class="panel table-scroll"><table class="data"><thead><tr><th>Source</th><th class="num">Papers</th><th>Last added</th><th>Status</th></tr></thead><tbody>${journals}</tbody></table></div>
    <div class="section-head"><h2>Update log</h2></div>
    <div class="panel table-scroll">${runs.length ? `<table class="data"><thead><tr><th>When</th><th class="num">Added</th><th class="num">Upgraded</th><th>Summaries by</th><th class="num">PDFs read</th><th class="num">Seconds</th></tr></thead><tbody>${runs.slice(0, 25).map(r => `<tr><td>${new Date(r.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</td><td class="num">${r.added}</td><td class="num">${r.upgraded || 0}</td><td class="small">${esc(r.provider)}${r.failed ? ` · ${r.failed} failed` : ''}</td><td class="num">${r.pdfs || 0}</td><td class="num">${r.seconds || ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No runs yet.</p>'}</div>
    <div class="section-head"><h2>Your data</h2><p>Saved papers, read marks, notes and followed authors live in this browser only</p></div>
    <div class="panel"><div class="toolbar"><button type="button" class="btn" data-act="export-user">Save a backup</button><button type="button" class="btn ghost" data-act="import-user">Restore a backup…</button><input type="file" id="import-file" accept="application/json,.json" hidden>
      <span class="muted small">${Object.keys(S.user.saved).length} saved · ${Object.keys(S.user.read).length} read · ${Object.keys(S.user.notes).length} notes · ${Object.keys(S.user.follow).length} followed</span></div>
      <div class="toolbar" style="margin-top:12px"><span class="small muted">Export every paper in the radar:</span><button type="button" class="btn ghost small" data-act="export-all" data-kind="bib">BibTeX</button><button type="button" class="btn ghost small" data-act="export-all" data-kind="ris">RIS</button><button type="button" class="btn ghost small" data-act="export-all" data-kind="csv">CSV</button></div></div>`;
}

// ---- wiring -------------------------------------------------------------------------
function bindMain() {
  const main = $('#main');
  main.addEventListener('click', e => { onMainClick(e); if (S.view === 'network') onNetworkEvent(e); if (S.view === 'trends') onTrendsClick(e); if (e.target.id === 'author-filter') { setFilter(f => { if (!f.authors.includes(e.target.dataset.key)) f.authors.push(e.target.dataset.key); }); location.hash = 'latest'; } });
  main.addEventListener('change', e => {
    if (S.view === 'network') onNetworkEvent(e);
    if (e.target.id === 'sort') { S.prefs.sort = e.target.value; savePrefs(); render(); }
    if (e.target.id === 'nl-issue') location.hash = 'newsletter/' + e.target.value;
    if (e.target.id === 'export') { exportPapers(e.target.value); e.target.value = ''; }
    if (e.target.id === 'trend-scope') { S.prefs.trendScope = e.target.value; savePrefs(); render(); }
    if (e.target.id === 'import-file') importUser(e.target.files[0]);
  });
  main.addEventListener('input', e => { if (S.view === 'network' && e.target.id === 'net-step') onNetworkEvent(e); });
  // Chart tooltips.
  main.addEventListener('pointermove', e => { const t = e.target.closest('[data-tip]'); if (t) showTip(t.dataset.tip, e.clientX, e.clientY); else if (!e.target.closest('.net-stage')) hideTip(); });
  main.addEventListener('pointerleave', hideTip);
  const dialog = $('#dialog');
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); else onMainClick(e); });
  dialog.addEventListener('input', e => {
    const id = e.target.dataset.note; if (!id) return;
    const v = e.target.value.trim();
    if (v) S.user.notes[id] = e.target.value.slice(0, 4000); else delete S.user.notes[id];
    saveUser();
  });
  dialog.addEventListener('close', () => { if (S.view === 'latest' || S.view === 'author') { const y = window.scrollY; render(); window.scrollTo(0, y); } });
}
function onTrendsClick(e) {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.trendBy) { S.prefs.trendBy = b.dataset.trendBy; savePrefs(); render(); }
  if (b.dataset.trendFacet) { S.prefs.trendFacet = b.dataset.trendFacet; savePrefs(); render(); }
}
async function importUser(file) {
  if (!file) return;
  try {
    const data = C.cleanUser(JSON.parse(await file.text()));
    if (!confirm(`Replace this device's saved papers, notes and followed authors with the backup (${Object.keys(data.saved).length} saved, ${Object.keys(data.notes).length} notes)?`)) return;
    data.lastVisit = S.user.lastVisit; S.user = data; saveUser(); toast('Backup restored.'); render();
  } catch { toast('That file is not an EconRadar backup.'); }
}

function sideStatus() {
  const last = S.index.runs?.[0];
  const text = last ? `Updated ${dayLabel(last.at.slice(0, 10), { day: 'numeric', month: 'short' })} · ${plural(S.papers.length, 'paper')}` : `${plural(S.papers.length, 'paper')}`;
  $('#side-status').textContent = text;
  $('#footer-status').textContent = S.config ? `${S.config.journals.filter(j => j.enabled !== false).length} journals · OpenAlex, Crossref, Semantic Scholar` : '';
}

async function start() {
  renderNav();
  try { await load(); }
  catch (e) { $('#main').innerHTML = `<div class="empty"><h2>The radar could not load</h2><p>${esc(e.message)}</p></div>`; return; }
  renderFilters(); bindFilters(); bindMain(); sideStatus();
  window.addEventListener('hashchange', route);
  if (!S.config.journals) return;
  S.visible = C.filterPapers(S.papers, S.filters, S.ctx, { user: S.user, today: S.today });
  updateFilterUI();
  route();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render(S.view === 'network'));
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
start();
