// EconRadar: pure data logic, no DOM and no storage. Loading and checking the
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
    authors, abstract: unlabel(str(raw.abstract, 3000)), url: str(raw.url, 500) || (str(raw.doi) ? 'https://doi.org/' + str(raw.doi, 200) : ''), pdf: str(raw.pdf, 500), kind: str(raw.kind, 20) || 'article',
    q: str(raw.q, 400), contribution: str(raw.contribution, 600), summary: unlabel(str(raw.summary, 1200)), conclusion: str(raw.conclusion, 800),
    fields: keys(raw.fields, ctx.fields, 3), methods: keys(raw.methods, ctx.methods, 4), data: keys(raw.data, ctx.data, 4),
    ident: str(raw.ident, 300), dataDetail: str(raw.dataDetail, 300),
    topics: [...new Set(arr(raw.topics).map(t => fold(t).trim()).filter(t => t.length > 1))].slice(0, 6),
    geo: arr(raw.geo).map(g => str(g, 60)).filter(Boolean).slice(0, 5), period: str(raw.period, 40),
    jel: arr(raw.jel).map(j => str(j, 4)).filter(Boolean).slice(0, 5), by: str(raw.by, 80) || 'rules', at: str(raw.at, 10), corrected: /^\d{4}-\d\d-\d\d$/.test(raw.corrected) ? raw.corrected : '',
    text: arr(raw.text).filter(t => t === 'abstract' || t === 'conclusion'),
  };
}

/** The reader's flag link: the Google Form's pre-filled link with PAPERID and PAPERTITLE as placeholders. */
export function flagUrl(template, p) {
  if (!/^https:\/\/docs\.google\.com\/forms\//.test(str(template)) || !template.includes('PAPERID')) return '';
  return template.replace('PAPERID', encodeURIComponent(p.id)).replace('PAPERTITLE', encodeURIComponent(p.title.slice(0, 300)));
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
export const EMPTY_FILTERS = Object.freeze({ q: '', families: [], fields: [], methods: [], data: [], topics: [], journals: [], authors: [], period: 'all', from: '', to: '', run: '', saved: false, unread: false, followed: false, modelOnly: false, all: [], not: [] });
// Pickers where a paper can carry several values, so "all of" makes sense.
export const ALL_OF_FACETS = ['fields', 'methods', 'data', 'topics', 'authors'];
// Pickers whose values can be excluded ("not"). Stored as "facet:key" in f.not.
export const NOT_FACETS = ['fields', 'methods', 'data', 'topics', 'journals', 'authors'];
/** Split an exclusion "facet:key" (author keys may themselves contain a colon). */
export const splitNot = s => { const i = s.indexOf(':'); return [s.slice(0, i), s.slice(i + 1)]; };

export function cleanFilters(raw) {
  const f = { ...EMPTY_FILTERS };
  if (!raw || typeof raw !== 'object') return f;
  for (const k of ['families', 'fields', 'methods', 'data', 'topics', 'journals', 'authors']) f[k] = arr(raw[k]).map(x => str(x, 80)).filter(Boolean).slice(0, 40);
  f.all = [...new Set(arr(raw.all).filter(k => ALL_OF_FACETS.includes(k)))];
  f.not = [...new Set(arr(raw.not).map(x => str(x, 90)).filter(x => NOT_FACETS.includes(splitNot(x)[0]) && splitNot(x)[1]))].slice(0, 40);
  f.q = str(raw.q, 200);
  f.period = ['all', '7d', '30d', '90d', '180d', '365d', 'custom'].includes(raw.period) ? raw.period : 'all';
  f.run = /^\d{4}-\d\d-\d\d$/.test(raw.run) ? raw.run : '';
  f.from = /^\d{4}-\d\d-\d\d$/.test(raw.from) ? raw.from : '';
  f.to = /^\d{4}-\d\d-\d\d$/.test(raw.to) ? raw.to : '';
  for (const k of ['saved', 'unread', 'followed', 'modelOnly']) f[k] = raw[k] === true;
  return f;
}
export const activeFilterCount = f => ['families', 'fields', 'methods', 'data', 'topics', 'journals', 'authors'].reduce((n, k) => n + f[k].length, 0) + f.not.length
  + (f.q ? 1 : 0) + (f.period !== 'all' ? 1 : 0) + (f.run ? 1 : 0) + ['saved', 'unread', 'followed', 'modelOnly'].filter(k => f[k]).length;

/** The paper's own date: publication date, or the day it was added when the index has none. */
export const paperDate = p => p.published || p.added;

/** Seven calendar days including today, using known publication dates only. */
export function publishedThisWeek(papers, today = isoDay(Date.now())) {
  const from = addDays(today, -6);
  return papers.filter(p => p.published && p.published >= from && p.published <= today);
}

/** [from, to] on the paper's publication date; `to` is inclusive. Presets reach back from
 * today and leave the end open, so articles already dated to a coming issue stay in. */
export function dateWindow(f, { today }) {
  const back = { '7d': 7, '30d': 30, '90d': 90, '180d': 180, '365d': 365 }[f.period];
  if (back) return [addDays(today, -back + 1), ''];
  if (f.period === 'custom') return [f.from, f.to];
  return ['', ''];
}

const haystacks = new WeakMap();
/** Abstracts arrive later, from their own file (abstracts-YYYY.json); they join the search text. */
export function setAbstract(p, text) { p.abstract = unlabel(str(text, 3000)); haystacks.delete(p); }
function haystack(p) {
  let h = haystacks.get(p);
  if (!h) haystacks.set(p, h = fold([p.title, p.q, p.contribution, p.summary, p.conclusion, p.abstract, p.ident, p.dataDetail, p.topics.join(' '), p.geo.join(' '), p.period, p.authors.map(a => a.n + ' ' + a.inst).join(' '), p.jel.join(' ')].join(' • ')));
  return h;
}
export const queryTerms = q => fold(q).split(/\s+/).map(t => t.replace(/^["'(]+|["')]+$/g, '')).filter(t => t.length > 1);

export function filterPapers(papers, f, ctx, { user = {}, today = isoDay(Date.now()) } = {}) {
  const [from, to] = dateWindow(f, { today });
  const terms = queryTerms(f.q);
  // Within a picker: any of the chosen values, or all of them when that picker is in "all of" mode.
  const all = new Set(f.all || []);
  const match = (facet, list, chosen) => !chosen.length || (all.has(facet) ? chosen.every(x => list.includes(x)) : list.some(x => chosen.includes(x)));
  const values = (p, facet) => (facet === 'journals' ? [p.journal] : facet === 'authors' ? p.authors.map(authorKey) : p[facet]);
  const nots = (f.not || []).map(splitNot);
  const followed = user.follow || {};
  return papers.filter(p => {
    if (from && paperDate(p) < from) return false;
    if (to && paperDate(p) > to) return false;
    if (f.run && p.added !== f.run) return false; // "added in this update", from the update chips
    // A field and a whole family are both "field" choices: either one matching is enough.
    // In "all of" mode every chosen field must be there (a family still means any of its fields).
    if (all.has('fields')) {
      if (!f.fields.every(k => p.fields.includes(k))) return false;
      if (f.families.length && !p.fields.some(k => f.families.includes(ctx.familyOf(k)))) return false;
    } else if ((f.fields.length || f.families.length) && !p.fields.some(k => f.fields.includes(k) || f.families.includes(ctx.familyOf(k)))) return false;
    if (!match('methods', p.methods, f.methods) || !match('data', p.data, f.data) || !match('topics', p.topics, f.topics || [])) return false;
    if (f.journals.length && !f.journals.includes(p.journal)) return false;
    if (!match('authors', p.authors.map(authorKey), f.authors)) return false;
    for (const [facet, key] of nots) if (values(p, facet).includes(key)) return false;
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
/**
 * Firsts, by publication date: the first paper in which a method appears, a method meets a
 * field, or a data source meets a field. The corpus's first year is the baseline (what was
 * already there), so firsts are reported only for papers published after it.
 */
export function firsts(papers, { baselineYears = 1 } = {}) {
  const dated = papers.filter(p => p.published);
  const order = [...dated].sort((a, b) => a.published.localeCompare(b.published) || a.id.localeCompare(b.id));
  const start = order[0]?.published || '';
  const baseline = start ? `${+start.slice(0, 4) + baselineYears}${start.slice(4)}` : '';
  const seen = new Set(), out = new Map();
  for (const p of order) {
    const items = [];
    const mark = (key, item) => { if (!seen.has(key)) { seen.add(key); items.push(item); } };
    for (const m of p.methods) mark('m|' + m, { kind: 'method', method: m });
    for (const m of p.methods) for (const f of p.fields) mark(`mf|${m}|${f}`, { kind: 'method-field', method: m, field: f });
    for (const d of p.data) for (const f of p.fields) mark(`df|${d}|${f}`, { kind: 'data-field', data: d, field: f });
    for (const t of p.topics) mark('t|' + t, { kind: 'topic', topic: t });
    if (p.published >= baseline && items.length) out.set(p.id, items.filter(i => !(i.kind === 'method-field' && items.some(j => j.kind === 'method' && j.method === i.method))));
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
// What two papers must share to be tied in the Papers lens.
export const MATCHES = {
  all: { label: 'Everything', minScore: 2.2 },
  topic: { label: 'Topic & literature', minScore: 2 },
  method: { label: 'Methodological approach', minScore: 1.6 },
  ident: { label: 'Identification strategy', minScore: 1.6 },
  data: { label: 'Data', minScore: 1.6 },
  author: { label: 'Authors', minScore: 2 },
};
function paperFeatures(p, ctx, match) {
  const group = m => ctx.methods.get(m)?.group;
  const authors = () => p.authors.map(a => ['a:' + authorKey(a), 3]);
  const topics = () => [...p.topics.map(t => ['t:' + t, 2]), ...p.fields.map(f => ['f:' + f, 0.7])];
  const design = () => p.methods.filter(m => group(m) === 'design').map(m => ['m:' + m, 2]);
  const approach = () => p.methods.filter(m => group(m) !== 'design').map(m => ['m:' + m, 2]);
  const data = () => p.data.map(d => ['d:' + d, 2]);
  if (match === 'topic') return topics();
  if (match === 'method') return [...approach(), ...design().map(([k]) => [k, 0.6])];
  if (match === 'ident') return design();
  if (match === 'data') return data();
  if (match === 'author') return authors();
  return [...authors(), ...p.topics.map(t => ['t:' + t, 2]), ...p.data.map(d => ['d:' + d, 0.8]), ...p.methods.map(m => ['m:' + m, 1]), ...p.fields.map(f => ['f:' + f, 0.7])];
}
/** Matching criteria as a clean list: one or several of topic/method/ident/data/author,
 *  or ['all'] (everything at once). Accepts a string or an array. */
export function matchCriteria(match) {
  const list = [...new Set([].concat(match || 'all').filter(c => MATCHES[c]))];
  return !list.length || list.includes('all') ? ['all'] : list;
}
/** A readable label for one or several criteria ("Methodological approach + Data"). */
export function matchLabel(match) { return matchCriteria(match).map(c => MATCHES[c].label).join(' + '); }
// Features of a paper under one or several criteria (union, strongest weight kept)
function featuresFor(p, ctx, match) {
  const crit = matchCriteria(match);
  if (crit.length === 1) return paperFeatures(p, ctx, crit[0]);
  const best = new Map();
  for (const c of crit) for (const [f, w] of paperFeatures(p, ctx, c)) best.set(f, Math.max(best.get(f) || 0, w));
  return [...best];
}
// All papers sharing each feature, independent of graph limits and edge scores.
export function paperFeatureMatches(paper, papers, ctx, match = 'all') {
  const keys = [...new Set(featuresFor(paper, ctx, match).map(([key]) => key))];
  const result = new Map(keys.map(key => [key, []]));
  for (const other of papers) {
    if (other.id === paper.id) continue;
    for (const key of new Set(featuresFor(other, ctx, match).map(([feature]) => feature))) {
      if (result.has(key)) result.get(key).push(other);
    }
  }
  for (const list of result.values()) list.sort(newestFirst);
  return result;
}
/** Readable labels for what two tied papers share (feature keys from paperGraph). */
export function describeShared(keys, ctx, papers = []) {
  return keys.map(k => {
    const [kind, ...rest] = k.split(':'); const v = rest.join(':');
    if (kind === 'a') return papers.flatMap(p => p.authors || []).find(a => authorKey(a) === v)?.n || 'an author';
    if (kind === 't') return v;
    if (kind === 'f') return ctx.label('field', v);
    if (kind === 'm') return ctx.label('method', v);
    return ctx.label('data', v);
  }).filter((x, i, a) => a.indexOf(x) === i);
}

// Dimensions a paper link can rest on, in display order. Methods in the "design" group
// (difference-in-differences, RDD, IV...) are reported as identification.
const DIMENSIONS = [['a', 'Author'], ['t', 'Topic'], ['m', 'Method'], ['i', 'Identification'], ['d', 'Data'], ['f', 'Field']];
/** What two linked papers share, grouped by dimension: [['Topic', ['minimum wage']], ...]. */
export function sharedByDimension(keys, ctx, papers = []) {
  const groups = new Map();
  for (const k of keys) {
    const kind = k.split(':')[0];
    const dim = kind === 'm' && ctx.methods.get(k.slice(2))?.group === 'design' ? 'i' : kind;
    const label = describeShared([k], ctx, papers)[0];
    if (!label) continue;
    let g = groups.get(dim);
    if (!g) groups.set(dim, g = []);
    if (!g.includes(label)) g.push(label);
  }
  return DIMENSIONS.filter(([d]) => groups.has(d)).map(([d, name]) => [name, groups.get(d)]);
}

// ---- paper selector: papers having every picked characteristic ----------------------
export const PICK_KINDS = { topic: 'Topic', field: 'Field', method: 'Method', data: 'Data', author: 'Author' };
const pickValues = (p, kind) => (kind === 'topic' ? p.topics : kind === 'field' ? p.fields : kind === 'method' ? p.methods : kind === 'data' ? p.data : p.authors.map(authorKey));
/** Papers that have all the picked characteristics ({kind, key} each). */
export function papersWithAll(papers, picks) {
  return picks.length ? papers.filter(p => picks.every(k => pickValues(p, k.kind).includes(k.key))) : [];
}
/** Characteristics whose name contains the query, counted among the papers that already
 *  match the current picks (so every suggestion still leaves at least one paper). */
export function pickOptions(papers, ctx, query, { picks = [], limit = 12 } = {}) {
  const q = fold(query).trim();
  if (!q) return [];
  const pool = picks.length ? papersWithAll(papers, picks) : papers;
  const taken = new Set(picks.map(k => k.kind + ':' + k.key)), found = new Map();
  for (const p of pool) for (const kind of Object.keys(PICK_KINDS)) {
    pickValues(p, kind).forEach((key, i) => {
      const id = kind + ':' + key;
      if (taken.has(id)) return;
      let o = found.get(id);
      if (o === undefined) {
        const label = kind === 'author' ? p.authors[i].n : ctx.label(kind, key);
        o = fold(label).includes(q) ? { kind, key, label, count: 0, starts: fold(label).startsWith(q) } : null;
        found.set(id, o);
      }
      if (o) o.count++;
    });
  }
  return [...found.values()].filter(Boolean).sort((a, b) => b.starts - a.starts || b.count - a.count || a.label.localeCompare(b.label)).slice(0, limit).map(({ starts, ...o }) => o);
}

export function paperGraph(papers, ctx, { max = 400, k = 4, minScore = null, newSince = '', dateOf = p => p.added, match = 'all' } = {}) {
  const crit = matchCriteria(match);
  if (crit.length > 1) return paperGraphAll(papers, ctx, { max, k, minScore, newSince, dateOf, crit });
  match = crit[0];
  const set = [...papers].sort(newestFirst).slice(0, max);
  const N = set.length || 1;
  const feats = set.map(p => paperFeatures(p, ctx, match));
  const threshold = minScore ?? (MATCHES[match] || MATCHES.all).minScore;
  const postings = new Map();
  feats.forEach((list, i) => list.forEach(([f]) => { let l = postings.get(f); if (!l) postings.set(f, l = []); l.push(i); }));
  const idf = f => Math.log(1 + N / postings.get(f).length);
  const neighbours = scoreNeighbours([feats], [postings], N, [threshold], k);
  const edges = new Map();
  neighbours.forEach((list, i) => list.forEach(([j, s, why]) => {
    const [a, b] = i < j ? [i, j] : [j, i];
    const key = a + '-' + b;
    if (!edges.has(key)) edges.set(key, { source: set[a].id, target: set[b].id, weight: +s.toFixed(2), why, first: dateOf(set[a]) > dateOf(set[b]) ? dateOf(set[a]) : dateOf(set[b]) });
  }));
  const degree = {};
  for (const e of edges.values()) { bump(degree, e.source); bump(degree, e.target); }
  return {
    nodes: set.map(p => ({ id: p.id, kind: 'paper', key: p.id, label: p.title, count: 1 + (degree[p.id] || 0), first: dateOf(p), family: primaryFamily(p, ctx), isNew: !!newSince && dateOf(p) >= newSince, paper: p })),
    links: [...edges.values()].map(e => ({ ...e, isNew: !!newSince && e.first >= newSince })),
    truncated: papers.length > set.length,
  };
}

// Each paper's k best neighbours. featsBy: one list of per-paper features per criterion;
// a pair must reach that criterion's threshold on every criterion. Scores accumulate in
// typed arrays (fast enough for the whole database); the shared features ("why") are
// worked out only for the neighbours kept.
function scoreNeighbours(featsBy, postingsBy, N, thresholds, k) {
  const C = featsBy.length, n = featsBy[0].length;
  const accs = featsBy.map(() => new Float64Array(n)), seen = new Uint8Array(n), touched = [];
  const usable = (c, f) => postingsBy[c].get(f).length <= 250; // too common to separate strands
  const idf = (c, f) => Math.log(1 + N / postingsBy[c].get(f).length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    touched.length = 0;
    for (let c = 0; c < C; c++) {
      const acc = accs[c];
      for (const [f, w] of featsBy[c][i]) {
        if (!usable(c, f)) continue;
        const add = w * idf(c, f);
        for (const j of postingsBy[c].get(f)) if (j !== i) { if (!seen[j]) { seen[j] = 1; touched.push(j); } acc[j] += add; }
      }
    }
    const cand = [];
    for (const j of touched) {
      let total = 0, ok = true;
      for (let c = 0; c < C; c++) { const v = accs[c][j]; if (v < thresholds[c]) ok = false; total += v; accs[c][j] = 0; }
      seen[j] = 0;
      if (ok) cand.push([j, total]);
    }
    cand.sort((a, b) => b[1] - a[1]);
    out[i] = cand.slice(0, k).map(([j, total]) => {
      const why = new Map();
      for (let c = 0; c < C; c++) {
        const theirs = new Set(featsBy[c][j].map(([f]) => f));
        for (const [f, w] of featsBy[c][i]) if (theirs.has(f) && usable(c, f)) why.set(f, Math.max(why.get(f) || 0, w * idf(c, f)));
      }
      return [j, total, [...why].sort((a, b) => b[1] - a[1]).map(([f]) => f)];
    });
  }
  return out;
}

/** Paper graph under several criteria at once: two papers are linked only if they share
 *  something on every criterion (each above that criterion's usual threshold); the
 *  strongest such pairs, by total score, are kept as each paper's neighbours. */
function paperGraphAll(papers, ctx, { max, k, minScore, newSince, dateOf, crit }) {
  const set = [...papers].sort(newestFirst).slice(0, max);
  const N = set.length || 1;
  const per = crit.map(c => {
    const feats = set.map(p => paperFeatures(p, ctx, c));
    const postings = new Map();
    feats.forEach((list, i) => list.forEach(([f]) => { let l = postings.get(f); if (!l) postings.set(f, l = []); l.push(i); }));
    return { feats, postings, threshold: minScore ?? MATCHES[c].minScore };
  });
  const neighbours = scoreNeighbours(per.map(x => x.feats), per.map(x => x.postings), N, per.map(x => x.threshold), k);
  const edges = new Map();
  neighbours.forEach((list, i) => list.forEach(([j, s, why]) => {
    const [a, b] = i < j ? [i, j] : [j, i];
    const key = a + '-' + b;
    if (!edges.has(key)) edges.set(key, { source: set[a].id, target: set[b].id, weight: +s.toFixed(2), why, first: dateOf(set[a]) > dateOf(set[b]) ? dateOf(set[a]) : dateOf(set[b]) });
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
