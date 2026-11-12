// Literature Radar: pure data logic, no DOM and no storage. Loading and checking the
// collected papers, filters, the author index, "firsts" (the first time a method,
// data source or topic appears in a field), the three network lenses, trends and
// citation exports. app.mjs draws; this file decides.

export const DAY = 864e5;
const str = (v, n = 4000) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, n);
const unlabel = s => s.replace(/^\s*(?:abstract|summary)\b[\s.:\u2014-]*/i, '');
const arr = v => (Array.isArray(v) ? v : []);
export const fold = s => str(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
export const normName = s => fold(s).replace(/[^a-z0-9]+/g, ' ').trim();
export const isoDay = d => new Date(d).toISOString().slice(0, 10);
export const addDays = (day, n) => isoDay(Date.parse(day + 'T12:00:00Z') + n * DAY);

// ---- loading -------------------------------------------------------------------
export function createContext(config) {
  const families = new Map(config.families.map(f => [f.key, f]));
  const fields = new Map(config.fields.map(f => [f.key, f]));
  const methods = new Map(config.methods.map(m => [m.key, m]));
  const data = new Map(config.dataTypes.map(d => [d.key, d]));
  const journals = new Map(config.journals.map((j, i) => [j.key, { ...j, rank: i }]));
  const groups = new Map(config.methodGroups.map(g => [g.key, g]));
  const familyOf = fieldKey => fields.get(fieldKey)?.family || '';
  const label = (kind, key) => (kind === 'field' ? fields.get(key)?.label : kind === 'method' ? methods.get(key)?.label
    : kind === 'data' ? data.get(key)?.label : kind === 'journal' ? journals.get(key)?.short : kind === 'family' ? families.get(key)?.label : key) || key;
  return { config, families, fields, methods, data, journals, groups, familyOf, label };
}

/** A stored record with every list present and only known taxonomy keys. */
export function normalizePaper(raw, ctx) {
  if (!raw || typeof raw !== 'object' || !str(raw.id) || !str(raw.title)) return null;
  const keys = (v, map, n) => [...new Set(arr(v).filter(k => map.has(k)))].slice(0, n);
  const authors = arr(raw.authors).filter(a => a && str(a.n)).map(a => ({ n: str(a.n, 160), id: str(a.id, 40), orcid: str(a.orcid, 40), inst: str(a.inst, 200), cc: str(a.cc, 4) }));
  return {
    id: str(raw.id, 40), doi: str(raw.doi, 200), title: str(raw.title, 500), journal: str(raw.journal, 40),
    published: /^\d{4}-\d\d-\d\d$/.test(raw.published) ? raw.published : '', added: /^\d{4}-\d\d-\d\d$/.test(raw.added) ? raw.added : '1970-01-01',
    authors, abstract: unlabel(str(raw.abstract, 3000)), url: str(raw.url, 500), pdf: str(raw.pdf, 500), kind: str(raw.kind, 20) || 'article',
    q: str(raw.q, 400), contribution: str(raw.contribution, 600), summary: unlabel(str(raw.summary, 1200)), conclusion: str(raw.conclusion, 800),
    fields: keys(raw.fields, ctx.fields, 3), methods: keys(raw.methods, ctx.methods, 4), data: keys(raw.data, ctx.data, 4),
    ident: str(raw.ident, 300), dataDetail: str(raw.dataDetail, 300),
    topics: [...new Set(arr(raw.topics).map(t => fold(t).trim()).filter(t => t.length > 1))].slice(0, 6),
    geo: arr(raw.geo).map(g => str(g, 60)).filter(Boolean).slice(0, 5), period: str(raw.period, 40),
    jel: arr(raw.jel).map(j => str(j, 4)).filter(Boolean).slice(0, 5), by: str(raw.by, 80) || 'rules', at: str(raw.at, 10),
    text: arr(raw.text).filter(t => t === 'abstract' || t === 'conclusion'),
  };
}

export function mergeShards(shards, ctx) {
  const byId = new Map();
  for (const shard of shards) for (const raw of arr(shard?.papers)) {
    const p = normalizePaper(raw, ctx);
    if (p && !byId.has(p.id)) byId.set(p.id, p);
  }
  return [...byId.values()].sort(newestFirst);
}
export const newestFirst = (a, b) => b.added.localeCompare(a.added) || (b.published || '').localeCompare(a.published || '') || a.id.localeCompare(b.id);
export const byModel = p => p.by !== 'rules';
export const primaryFamily = (p, ctx) => ctx.familyOf(p.fields[0]) || '';

// ---- authors -------------------------------------------------------------------
export const authorKey = a => (a.id ? a.id : 'n:' + normName(a.n));
const bump = (o, k, n = 1) => { if (k) o[k] = (o[k] || 0) + n; };
export const ranked = (o, n = Infinity) => Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

export function authorIndex(papers) {
  const index = new Map();
  for (const p of papers) {
    const keys = p.authors.map(authorKey);
    p.authors.forEach((a, i) => {
      const key = keys[i];
      let r = index.get(key);
      if (!r) index.set(key, r = { key, name: a.n, orcid: a.orcid, inst: '', cc: '', papers: [], fields: {}, methods: {}, journals: {}, topics: {}, data: {}, coauthors: {}, first: '', last: '', instDate: '' });
      r.papers.push(p);
      const day = p.published || p.added;
      if (a.inst && day >= r.instDate) { r.inst = a.inst; r.cc = a.cc; r.instDate = day; }
      if (!r.first || day < r.first) r.first = day;
      if (day > r.last) r.last = day;
      p.fields.forEach((f, j) => bump(r.fields, f, j ? 0.5 : 1));
      p.methods.forEach(m => bump(r.methods, m));
      p.data.forEach(d => bump(r.data, d));
      p.topics.forEach(t => bump(r.topics, t));
      bump(r.journals, p.journal);
      keys.forEach(k => { if (k !== key) bump(r.coauthors, k); });
    });
  }
  return index;
}
export const mainField = author => ranked(author.fields, 1)[0]?.[0] || '';

// ---- filters -------------------------------------------------------------------
export const EMPTY_FILTERS = Object.freeze({ q: '', families: [], fields: [], methods: [], data: [], journals: [], authors: [], period: 'all', from: '', to: '', run: '', saved: false, unread: false, followed: false, modelOnly: false });

export function cleanFilters(raw) {
  const f = { ...EMPTY_FILTERS };
  if (!raw || typeof raw !== 'object') return f;
  for (const k of ['families', 'fields', 'methods', 'data', 'journals', 'authors']) f[k] = arr(raw[k]).map(x => str(x, 80)).filter(Boolean).slice(0, 40);
  f.q = str(raw.q, 200);
  f.period = ['all', '7d', '30d', '90d', '180d', '365d', 'custom'].includes(raw.period) ? raw.period : 'all';
  f.run = /^\d{4}-\d\d-\d\d$/.test(raw.run) ? raw.run : '';
  f.from = /^\d{4}-\d\d-\d\d$/.test(raw.from) ? raw.from : '';
  f.to = /^\d{4}-\d\d-\d\d$/.test(raw.to) ? raw.to : '';
  for (const k of ['saved', 'unread', 'followed', 'modelOnly']) f[k] = raw[k] === true;
  return f;
}
export const activeFilterCount = f => ['families', 'fields', 'methods', 'data', 'journals', 'authors'].reduce((n, k) => n + f[k].length, 0)
  + (f.q ? 1 : 0) + (f.period !== 'all' ? 1 : 0) + (f.run ? 1 : 0) + ['saved', 'unread', 'followed', 'modelOnly'].filter(k => f[k]).length;

/** The paper's own date: publication date, or the day it was added when the index has none. */
export const paperDate = p => p.published || p.added;

/** [from, to] on the paper's publication date; `to` is inclusive. Presets reach back from
 * today and leave the end open, so articles already dated to a coming issue stay in. */
export function dateWindow(f, { today }) {
  const back = { '7d': 7, '30d': 30, '90d': 90, '180d': 180, '365d': 365 }[f.period];
  if (back) return [addDays(today, -back + 1), ''];
  if (f.period === 'custom') return [f.from, f.to];
  return ['', ''];
}

const haystacks = new WeakMap();
function haystack(p) {
  let h = haystacks.get(p);
  if (!h) haystacks.set(p, h = fold([p.title, p.q, p.contribution, p.summary, p.conclusion, p.abstract, p.ident, p.dataDetail, p.topics.join(' '), p.geo.join(' '), p.period, p.authors.map(a => a.n + ' ' + a.inst).join(' '), p.jel.join(' ')].join(' • ')));
  return h;
}
export const queryTerms = q => fold(q).split(/\s+/).map(t => t.replace(/^["'(]+|["')]+$/g, '')).filter(t => t.length > 1);

export function filterPapers(papers, f, ctx, { user = {}, today = isoDay(Date.now()) } = {}) {
  const [from, to] = dateWindow(f, { today });
  const terms = queryTerms(f.q);
  const any = (list, chosen) => !chosen.length || list.some(x => chosen.includes(x));
  const followed = user.follow || {};
  return papers.filter(p => {
    if (from && paperDate(p) < from) return false;
    if (to && paperDate(p) > to) return false;
    if (f.run && p.added !== f.run) return false; // "added in this update", from the update chips
    // A field and a whole family are both "field" choices: either one matching is enough.
    if ((f.fields.length || f.families.length) && !p.fields.some(k => f.fields.includes(k) || f.families.includes(ctx.familyOf(k)))) return false;
    if (!any(p.methods, f.methods) || !any(p.data, f.data)) return false;
    if (f.journals.length && !f.journals.includes(p.journal)) return false;
    if (f.authors.length && !p.authors.some(a => f.authors.includes(authorKey(a)))) return false;
    if (f.saved && !user.saved?.[p.id]) return false;
    if (f.unread && user.read?.[p.id]) return false;
    if (f.followed && !p.authors.some(a => followed[authorKey(a)])) return false;
    if (f.modelOnly && !byModel(p)) return false;
    if (terms.length) { const h = haystack(p); if (!terms.every(t => h.includes(t))) return false; }
    return true;
  });
}

// ---- firsts ----------------------------------------------------------------------
/**
 * For each paper, what it brings into the radar for the first time: a method used in
 * a field, a data source used in a field, a new topic, a new method. Papers are taken in
 * the order the radar received them. Everything collected on the first day forms the
 * baseline and is never flagged, so firsts mean "new since the radar started".
 */
export function firsts(papers) {
  const order = [...papers].sort((a, b) => a.added.localeCompare(b.added) || (a.published || '').localeCompare(b.published || '') || a.id.localeCompare(b.id));
  const seedDay = order[0]?.added || '';
  const seen = new Set(), out = new Map();
  for (const p of order) {
    const items = [];
    const mark = (key, item) => { if (!seen.has(key)) { seen.add(key); items.push(item); } };
    for (const m of p.methods) mark('m|' + m, { kind: 'method', method: m });
    for (const m of p.methods) for (const f of p.fields) mark(`mf|${m}|${f}`, { kind: 'method-field', method: m, field: f });
    for (const d of p.data) for (const f of p.fields) mark(`df|${d}|${f}`, { kind: 'data-field', data: d, field: f });
    for (const t of p.topics) mark('t|' + t, { kind: 'topic', topic: t });
    if (p.added !== seedDay && items.length) out.set(p.id, items.filter(i => !(i.kind === 'method-field' && items.some(j => j.kind === 'method' && j.method === i.method))));
  }
  return out;
}
export function describeFirst(item, ctx) {
  const L = ctx.label;
  if (item.kind === 'method') return `First ${L('method', item.method)} paper in the radar`;
  if (item.kind === 'method-field') return `First ${L('method', item.method)} in ${L('field', item.field)}`;
  if (item.kind === 'data-field') return `First ${L('data', item.data).toLowerCase()} data in ${L('field', item.field)}`;
  return `New topic: ${item.topic}`;
}

// ---- network lenses ----------------------------------------------------------------
const nodeId = (kind, key) => `${kind}:${key}`;

/**
 * Strands: fields, methods, data sources and topics as nodes; an edge each time two of
 * them meet in the same paper. Size is popularity in the current selection; an edge or
 * node whose first paper arrived on or after `newSince` is new.
 */
export function strandsGraph(papers, ctx, { kinds = { field: true, method: true, data: true, topic: true }, minEdge = 2, maxTopics = 50, minTopic = 2, newSince = '', dateOf = p => p.added, perNode = 6 } = {}) {
  const topicCount = {};
  for (const p of papers) for (const t of p.topics) bump(topicCount, t);
  const topics = new Set(ranked(topicCount, maxTopics).filter(([, n]) => n >= minTopic).map(([t]) => t));
  const nodes = new Map(), edges = new Map();
  for (const p of papers) {
    const items = [];
    if (kinds.field) p.fields.forEach(k => items.push(['field', k]));
    if (kinds.method) p.methods.forEach(k => items.push(['method', k]));
    if (kinds.data) p.data.forEach(k => items.push(['data', k]));
    if (kinds.topic) p.topics.forEach(k => topics.has(k) && items.push(['topic', k]));
    const when = dateOf(p);
    const ids = items.map(([kind, key]) => {
      const id = nodeId(kind, key);
      let n = nodes.get(id);
      if (!n) nodes.set(id, n = { id, kind, key, label: ctx.label(kind, key), count: 0, first: when, families: {} });
      n.count++;
      if (when < n.first) n.first = when;
      bump(n.families, ctx.familyOf(p.fields[0]));
      return id;
    });
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
      const key = a + '\u0000' + b;
      let e = edges.get(key);
      if (!e) edges.set(key, e = { source: a, target: b, weight: 0, first: when });
      e.weight++;
      if (when < e.first) e.first = when;
    }
  }
  let links = [...edges.values()].filter(e => e.weight >= minEdge).map(e => ({ ...e, isNew: !!newSince && e.first >= newSince }));
  // Backbone: keep a tie when it is among the `perNode` strongest of either end (new ties
  // always stay), so a large selection still reads as strands rather than a hairball.
  if (perNode) {
    const byNode = new Map();
    for (const e of links) for (const id of [e.source, e.target]) { let l = byNode.get(id); if (!l) byNode.set(id, l = []); l.push(e); }
    const keep = new Set(links.filter(e => e.isNew));
    for (const list of byNode.values()) list.sort((a, b) => b.weight - a.weight).slice(0, perNode).forEach(e => keep.add(e));
    links = links.filter(e => keep.has(e));
  }
  const linked = new Set(links.flatMap(e => [e.source, e.target]));
  const list = [...nodes.values()].filter(n => n.kind === 'field' || linked.has(n.id) || n.count >= minEdge).map(n => ({
    ...n, family: n.kind === 'field' ? ctx.familyOf(n.key) : n.kind === 'topic' ? ranked(n.families, 1)[0]?.[0] || '' : '',
    isNew: !!newSince && n.first >= newSince,
  }));
  const keep = new Set(list.map(n => n.id));
  return { nodes: list, links: links.filter(e => keep.has(e.source) && keep.has(e.target)) };
}

/**
 * Papers: each paper linked to its closest neighbours. Shared authors and topics weigh
 * most, then data and methods, then fields; rarer features weigh more (idf).
 */
export function paperGraph(papers, ctx, { max = 400, k = 4, minScore = 2.2, newSince = '', dateOf = p => p.added } = {}) {
  const set = [...papers].sort(newestFirst).slice(0, max);
  const N = set.length || 1;
  const feats = p => [
    ...p.authors.map(a => ['a:' + authorKey(a), 3]), ...p.topics.map(t => ['t:' + t, 2]),
    ...p.data.map(d => ['d:' + d, 0.8]), ...p.methods.map(m => ['m:' + m, 1]), ...p.fields.map(f => ['f:' + f, 0.7]),
  ];
  const postings = new Map();
  set.forEach((p, i) => feats(p).forEach(([f]) => { let l = postings.get(f); if (!l) postings.set(f, l = []); l.push(i); }));
  const idf = f => Math.log(1 + N / postings.get(f).length);
  const neighbours = set.map(() => []);
  set.forEach((p, i) => {
    const score = new Map();
    for (const [f, w] of feats(p)) {
      const list = postings.get(f);
      if (list.length > 250) continue; // too common to separate strands
      const add = w * idf(f);
      for (const j of list) if (j !== i) score.set(j, (score.get(j) || 0) + add);
    }
    neighbours[i] = [...score].filter(([, s]) => s >= minScore).sort((a, b) => b[1] - a[1]).slice(0, k);
  });
  const edges = new Map();
  neighbours.forEach((list, i) => list.forEach(([j, s]) => {
    const [a, b] = i < j ? [i, j] : [j, i];
    const key = a + '-' + b;
    if (!edges.has(key)) edges.set(key, { source: set[a].id, target: set[b].id, weight: +s.toFixed(2), first: dateOf(set[a]) > dateOf(set[b]) ? dateOf(set[a]) : dateOf(set[b]) });
  }));
  const degree = {};
  for (const e of edges.values()) { bump(degree, e.source); bump(degree, e.target); }
  return {
    nodes: set.map(p => ({ id: p.id, kind: 'paper', key: p.id, label: p.title, count: 1 + (degree[p.id] || 0), first: dateOf(p), family: primaryFamily(p, ctx), isNew: !!newSince && dateOf(p) >= newSince, paper: p })),
    links: [...edges.values()].map(e => ({ ...e, isNew: !!newSince && e.first >= newSince })),
    truncated: papers.length > set.length,
  };
}

/** Authors: who publishes in which field, and who writes with whom. */
export function authorGraph(papers, ctx, { minPapers = 0, maxAuthors = 150, newSince = '', dateOf = p => p.added } = {}) {
  const index = authorIndex(papers);
  let pool = [...index.values()];
  const min = minPapers || (pool.filter(a => a.papers.length >= 2).length >= 25 ? 2 : 1);
  pool = pool.filter(a => a.papers.length >= min).sort((a, b) => b.papers.length - a.papers.length || b.last.localeCompare(a.last) || a.name.localeCompare(b.name)).slice(0, maxAuthors);
  const chosen = new Set(pool.map(a => a.key));
  const nodes = new Map(), links = [];
  for (const a of pool) {
    const firstAdded = a.papers.reduce((m, p) => (dateOf(p) < m ? dateOf(p) : m), '9999');
    nodes.set('author:' + a.key, { id: 'author:' + a.key, kind: 'author', key: a.key, label: a.name, count: a.papers.length, first: firstAdded, family: ctx.familyOf(mainField(a)), isNew: !!newSince && firstAdded >= newSince, author: a });
    for (const [f, w] of Object.entries(a.fields)) {
      const id = 'field:' + f;
      let n = nodes.get(id);
      if (!n) nodes.set(id, n = { id, kind: 'field', key: f, label: ctx.label('field', f), count: 0, first: firstAdded, family: ctx.familyOf(f), isNew: false });
      n.count += w;
      links.push({ source: 'author:' + a.key, target: id, weight: w, first: firstAdded, kind: 'works-in' });
    }
  }
  const pairs = new Map();
  for (const a of pool) for (const [k, n] of Object.entries(a.coauthors)) if (chosen.has(k) && a.key < k) pairs.set(a.key + '|' + k, { source: 'author:' + a.key, target: 'author:' + k, weight: n, kind: 'coauthor' });
  for (const e of pairs.values()) {
    const shared = index.get(e.source.slice(7)).papers.filter(p => p.authors.some(x => authorKey(x) === e.target.slice(7)));
    e.first = shared.reduce((m, p) => (dateOf(p) < m ? dateOf(p) : m), '9999');
    links.push(e);
  }
  return { nodes: [...nodes.values()], links: links.map(e => ({ ...e, isNew: !!newSince && e.first >= newSince })), minPapers: min, index };
}

/** Papers behind a node of any lens, newest first. */
export function papersForNode(node, papers) {
  const has = { field: p => p.fields.includes(node.key), method: p => p.methods.includes(node.key), data: p => p.data.includes(node.key), topic: p => p.topics.includes(node.key), author: p => p.authors.some(a => authorKey(a) === node.key), paper: p => p.id === node.key }[node.kind];
  return has ? papers.filter(has).sort(newestFirst) : [];
}
export function papersForLink(a, b, papers) {
  const sets = [a, b].map(n => new Set(papersForNode(n, papers).map(p => p.id)));
  return papers.filter(p => sets[0].has(p.id) && sets[1].has(p.id)).sort(newestFirst);
}

// ---- trends --------------------------------------------------------------------
export const periodOf = (day, by = 'quarter') => (by === 'month' ? day.slice(0, 7) : `${day.slice(0, 4)}-Q${Math.floor((+day.slice(5, 7) - 1) / 3) + 1}`);
export function periodsBetween(first, last, by = 'quarter') {
  if (!first || !last) return [];
  const out = [];
  let y = +first.slice(0, 4), m = +first.slice(5, 7);
  const endKey = periodOf(last, by);
  for (let guard = 0; guard < 400; guard++) {
    const key = periodOf(`${y}-${String(m).padStart(2, '0')}-01`, by);
    if (!out.includes(key)) out.push(key);
    if (key === endKey) break;
    m += by === 'month' ? 1 : 3;
    if (m > 12) { m -= 12; y++; }
  }
  return out;
}

/** Counts per period for the top `top` keys of a facet; the rest fold into "other". */
export function facetMix(papers, facet, { by = 'quarter', top = 7, dateOf = p => p.published || p.added } = {}) {
  const dated = papers.filter(p => dateOf(p));
  if (!dated.length) return { periods: [], series: [], totals: [] };
  const days = dated.map(dateOf).sort();
  const periods = periodsBetween(days[0], days.at(-1), by);
  const pos = new Map(periods.map((k, i) => [k, i]));
  const totals = {};
  for (const p of dated) for (const k of p[facet]) bump(totals, k);
  const keys = ranked(totals, top).map(([k]) => k);
  const series = keys.map(key => ({ key, values: periods.map(() => 0) }));
  const other = { key: 'other', values: periods.map(() => 0) };
  const papersPer = periods.map(() => 0);
  for (const p of dated) {
    const i = pos.get(periodOf(dateOf(p), by));
    if (i == null) continue;
    papersPer[i]++;
    for (const k of p[facet]) {
      const s = series.find(x => x.key === k);
      (s || other).values[i]++;
    }
  }
  if (other.values.some(Boolean)) series.push(other);
  return { periods, series, totals: papersPer };
}

/** What gained or lost share between the last `recentDays` and everything before. */
export function risers(papers, facet, { today, recentDays = 90, min = 3 } = {}) {
  const cut = addDays(today, -recentDays);
  const recent = papers.filter(p => (p.published || p.added) >= cut), before = papers.filter(p => (p.published || p.added) < cut);
  if (!recent.length || !before.length) return [];
  const count = list => { const o = {}; for (const p of list) for (const k of p[facet]) bump(o, k); return o; };
  const r = count(recent), b = count(before);
  return [...new Set([...Object.keys(r), ...Object.keys(b)])]
    .map(key => ({ key, recent: r[key] || 0, before: b[key] || 0, shareRecent: (r[key] || 0) / recent.length, shareBefore: (b[key] || 0) / before.length }))
    .filter(x => x.recent + x.before >= min)
    .map(x => ({ ...x, change: x.shareRecent - x.shareBefore }))
    .sort((a, b) => b.change - a.change);
}

// ---- exports -------------------------------------------------------------------
const bibEscape = s => str(s).replace(/[{}\\]/g, '').replace(/([&%$#_])/g, '\\$1');
export function bibKey(p) {
  const last = normName(p.authors[0]?.n || 'anon').split(' ').pop() || 'anon';
  const word = normName(p.title).split(' ').find(w => w.length > 3) || 'paper';
  return `${last}${(p.published || p.added).slice(0, 4)}${word}`;
}
export function toBibtex(p, ctx) {
  const j = ctx.journals.get(p.journal);
  const rows = [['title', `{${bibEscape(p.title)}}`], ['author', `{${p.authors.map(a => bibEscape(a.n)).join(' and ')}}`], ['journal', `{${bibEscape(j?.name || p.journal)}}`],
    ['year', `{${(p.published || p.added).slice(0, 4)}}`], ...(p.doi ? [['doi', `{${p.doi}}`]] : []), ['url', `{${p.url}}`]];
  return `@article{${bibKey(p)},\n${rows.map(([k, v]) => `  ${k} = ${v}`).join(',\n')}\n}`;
}
export function toRis(p, ctx) {
  const j = ctx.journals.get(p.journal);
  return ['TY  - JOUR', `TI  - ${p.title}`, ...p.authors.map(a => `AU  - ${a.n}`), `JO  - ${j?.name || p.journal}`, `PY  - ${(p.published || p.added).slice(0, 4)}`,
    ...(p.published ? [`DA  - ${p.published.replaceAll('-', '/')}`] : []), ...(p.doi ? [`DO  - ${p.doi}`] : []), `UR  - ${p.url}`,
    ...p.topics.map(t => `KW  - ${t}`), ...(p.summary ? [`AB  - ${p.summary}`] : []), 'ER  - '].join('\r\n');
}
const csvCell = v => { const s = str(v); return /[",\n;]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
export function toCsv(papers, ctx) {
  const head = ['added', 'published', 'journal', 'title', 'authors', 'question', 'contribution', 'summary', 'fields', 'methods', 'identification', 'data', 'data_detail', 'topics', 'geography', 'period', 'doi', 'url', 'tagged_by'];
  const rows = papers.map(p => [p.added, p.published, ctx.journals.get(p.journal)?.short || p.journal, p.title, p.authors.map(a => a.n).join('; '), p.q, p.contribution, p.summary,
    p.fields.map(k => ctx.label('field', k)).join('; '), p.methods.map(k => ctx.label('method', k)).join('; '), p.ident, p.data.map(k => ctx.label('data', k)).join('; '),
    p.dataDetail, p.topics.join('; '), p.geo.join('; '), p.period, p.doi, p.url, p.by]);
  return [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
}

// ---- personal state (stars, reads, notes, followed authors) ------------------------
export function cleanUser(raw) {
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const dates = o => Object.fromEntries(Object.entries(obj(o)).filter(([k, v]) => k.length <= 80 && (v === true || /^\d{4}-\d\d-\d\d/.test(v))).slice(0, 20000));
  const notes = Object.fromEntries(Object.entries(obj(raw?.notes)).filter(([k, v]) => k.length <= 80 && typeof v === 'string' && v.trim()).map(([k, v]) => [k, v.slice(0, 4000)]));
  return { version: 1, saved: dates(raw?.saved), read: dates(raw?.read), follow: dates(raw?.follow), notes, lastVisit: /^\d{4}-\d\d-\d\d/.test(raw?.lastVisit) ? raw.lastVisit : '' };
}
