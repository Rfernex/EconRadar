// Focus areas: a whole literature followed since a start date (radar/focus.json), with the
// citation links between its papers. Pure data logic, no DOM and no storage.
import { fold, queryTerms, authorKey } from './core.mjs?v=5';

const arr = v => (Array.isArray(v) ? v : []);
const num = v => (Number.isFinite(+v) ? +v : 0);
export const KINDS = { article: 'Journal article', working: 'Working paper', chapter: 'Book chapter', book: 'Book', review: 'Review' };
export const SORTS = { newest: 'Newest first', cited: 'Most cited overall', local: 'Most cited in this literature', rising: 'Most cited lately', oldest: 'Oldest first' };
export const EMPTY = { q: '', strands: [], outcomes: [], disc: [], kinds: [], methods: [], from: 0, to: 0, author: '', saved: false, all: false, sort: 'newest' };
// Working-paper series and research repositories worth showing even before anyone cites them.
export const SERIES = /National Bureau of Economic Research|\bNBER\b|\bIZA\b|Institute of Labor Economics|\bCEPR\b|Centre for Economic Policy|World Bank|International Monetary Fund|\bIMF\b|CESifo|Federal Reserve|\bOECD\b|Institute for Fiscal Studies|\bSSRN\b|RePEc|EconStor|Tinbergen|Paris School of Economics|Tax Observatory|Becker Friedman|J-PAL|Innovations for Poverty|Center for Global Development|IFPRI|Food Policy Research|WIDER|Brookings|Peterson Institute|Urban Institute|Opportunity Insights|arXiv/i;
/** Core journals (OpenAlex), known series, cited work and radar papers: hides predatory and junk venues. */
export const established = p => p.radar || p.core || (p.cited || 0) >= 5 || SERIES.test(p.venue);

// As in the collector: a space in a focus.json pattern also matches a hyphen.
const tolerant = pattern => new RegExp(pattern.replaceAll(' ', '[\\s-]'), 'i');
function matchers(spec) {
  return {
    strands: spec.strands.map(s => [s.key, tolerant(s.match), s.queries.every(q => q.in === 'title'), s.exclude ? tolerant(s.exclude) : null]),
    outcomes: (spec.outcomes || []).map(o => [o.key, new RegExp(o.match, 'i')]),
  };
}
const strandsOf = (m, title, abstract) => m.strands.filter(([, rx, titleOnly, ex]) => rx.test(titleOnly ? title : `${title}. ${abstract}`) && !(ex && ex.test(`${title}. ${abstract}`))).map(([k]) => k);
const outcomesOf = (m, title, abstract) => m.outcomes.filter(([, rx]) => rx.test(`${title}. ${abstract}`)).map(([k]) => k).slice(0, 5);

function normalize(raw, strandOrder) {
  const p = {
    id: String(raw.id || ''), doi: String(raw.doi || ''), title: String(raw.title || ''), venue: String(raw.venue || ''),
    kind: KINDS[raw.kind] ? raw.kind : 'article', published: String(raw.published || ''), authors: arr(raw.authors).filter(a => a && a.n),
    abstract: String(raw.abstract || ''), url: String(raw.url || (raw.doi ? 'https://doi.org/' + raw.doi : '')), pdf: String(raw.pdf || ''),
    strands: arr(raw.strands).filter(k => strandOrder.has(k)).sort((a, b) => strandOrder.get(a) - strandOrder.get(b)),
    disc: String(raw.disc || 'Other'), sub: String(raw.sub || ''), core: raw.core === true, cited: raw.cited == null ? null : num(raw.cited),
    cy: Array.isArray(raw.cy) ? raw.cy.map(num) : null, outcomes: arr(raw.outcomes),
    q: String(raw.q || ''), contribution: String(raw.contribution || ''), summary: String(raw.summary || ''), ident: String(raw.ident || ''),
    fields: arr(raw.fields), methods: arr(raw.methods), data: arr(raw.data), topics: arr(raw.topics), geo: arr(raw.geo),
    period: String(raw.period || ''), by: String(raw.by || 'rules'), added: String(raw.added || ''), cites: arr(raw.cites),
    radar: !!raw.radar, journal: String(raw.journal || ''),
  };
  p.year = +p.published.slice(0, 4) || 0;
  return p;
}

/**
 * The area's papers, plus radar papers that match a strand and are not in the area yet
 * (new NBER papers, for instance, before OpenAlex has them). Adds reverse citations.
 */
export function prepareFocus(data, spec, { radar = [], ctx = null } = {}) {
  const order = new Map(spec.strands.map((s, i) => [s.key, i]));
  const m = matchers(spec);
  const papers = arr(data?.papers).map(r => normalize(r, order)).filter(p => p.id && p.title && p.strands.length);
  const ids = new Set(papers.map(p => p.id)), dois = new Set(papers.map(p => p.doi).filter(Boolean));
  const since = spec.since || '';
  for (const r of radar) {
    if (ids.has(r.id) || (r.doi && dois.has(r.doi)) || (r.published || r.added) < since) continue;
    const strands = strandsOf(m, r.title, r.abstract || '');
    if (!strands.length) continue;
    const j = ctx?.journals.get(r.journal);
    papers.push(normalize({
      ...r, venue: j?.name || r.journal, kind: r.kind === 'working' ? 'working' : r.kind === 'review' ? 'review' : 'article',
      strands, outcomes: outcomesOf(m, r.title, r.abstract || ''), disc: j?.group === 'beyond' ? 'Social sciences' : 'Economics',
      cited: null, cy: null, cites: [], radar: true,
    }, order));
    ids.add(r.id);
  }
  const byId = new Map(papers.map(p => [p.id, p]));
  for (const p of papers) { p.citedBy = []; p.text = searchText(p); }
  for (const p of papers) for (const r of p.cites) { const q = byId.get(r); if (q && q !== p) q.citedBy.push(p.id); }
  return { spec, papers, byId, strands: new Map(spec.strands.map((s, i) => [s.key, { ...s, i }])), outcomes: new Map((spec.outcomes || []).map(o => [o.key, o])) };
}

const searchText = p => fold([p.title, p.summary, p.q, p.venue, p.topics.join(' '), p.authors.map(a => a.n).join(' '), p.geo.join(' ')].join(' '));


export function cleanFocusFilters(raw = {}, spec) {
  const keys = new Set(spec.strands.map(s => s.key)), outs = new Set((spec.outcomes || []).map(o => o.key));
  const list = (v, ok) => (Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string' && (!ok || ok(x))))] : []);
  const year = v => (Number.isInteger(+v) && +v >= 1900 && +v <= 2100 ? +v : 0);
  return {
    q: typeof raw.q === 'string' ? raw.q.slice(0, 200) : '', strands: list(raw.strands, k => keys.has(k)), outcomes: list(raw.outcomes, k => outs.has(k)),
    disc: list(raw.disc), kinds: list(raw.kinds, k => k in KINDS), methods: list(raw.methods), from: year(raw.from), to: year(raw.to),
    author: typeof raw.author === 'string' ? raw.author : '', saved: raw.saved === true, all: raw.all === true, sort: raw.sort in SORTS ? raw.sort : 'newest',
  };
}

export const recentCitations = p => (p.cy ? p.cy.at(-1) + p.cy.at(-2) : 0);

export function filterFocus(F, f, { user = null } = {}) {
  const terms = queryTerms(f.q);
  const list = F.papers.filter(p =>
    (!f.strands.length || p.strands.some(s => f.strands.includes(s)))
    && (!f.outcomes.length || p.outcomes.some(o => f.outcomes.includes(o)))
    && (!f.disc.length || f.disc.includes(p.disc))
    && (!f.kinds.length || f.kinds.includes(p.kind))
    && (!f.methods.length || p.methods.some(m => f.methods.includes(m)))
    && (!f.from || p.year >= f.from) && (!f.to || p.year <= f.to)
    && (!f.author || p.authors.some(a => authorKey(a) === f.author))
    && (!f.saved || !!user?.saved?.[p.id])
    && (f.all || established(p))
    && terms.every(t => p.text.includes(t)));
  return sortFocus(list, f.sort);
}

export function sortFocus(list, by = 'newest') {
  const tie = (a, b) => b.published.localeCompare(a.published) || a.id.localeCompare(b.id);
  const cmp = {
    newest: tie,
    oldest: (a, b) => a.published.localeCompare(b.published) || a.id.localeCompare(b.id),
    cited: (a, b) => (b.cited ?? -1) - (a.cited ?? -1) || tie(a, b),
    local: (a, b) => b.citedBy.length - a.citedBy.length || (b.cited ?? -1) - (a.cited ?? -1) || tie(a, b),
    rising: (a, b) => recentCitations(b) - recentCitations(a) || tie(a, b),
  }[by] || tie;
  return [...list].sort(cmp);
}

/** Papers per year, each counted once under its first strand (in the order of focus.json). */
export function yearlyByStrand(F, papers, { from, to } = {}) {
  const years = papers.map(p => p.year).filter(Boolean);
  const y0 = from || Math.min(...years), y1 = to || Math.max(...years);
  const span = years.length ? Array.from({ length: Math.max(0, y1 - y0 + 1) }, (_, i) => y0 + i) : [];
  const series = [...F.strands.keys()].map(key => ({ key, values: span.map(() => 0) }));
  const at = new Map(series.map(s => [s.key, s]));
  for (const p of papers) { const i = p.year - y0; if (i >= 0 && i < span.length && p.strands[0]) at.get(p.strands[0]).values[i]++; }
  return { years: span, series: series.filter(s => s.values.some(Boolean)) };
}

/** How often each outcome is studied in each strand (a paper counts in every strand it belongs to). */
export function outcomeMatrix(F, papers) {
  const rows = [...F.outcomes.keys()].map(o => ({ key: o, cells: [...F.strands.keys()].map(() => 0), total: 0 }));
  const si = new Map([...F.strands.keys()].map((k, i) => [k, i])), oi = new Map(rows.map((r, i) => [r.key, i]));
  for (const p of papers) for (const o of p.outcomes) {
    const row = rows[oi.get(o)]; if (!row) continue;
    row.total++;
    for (const s of p.strands) row.cells[si.get(s)]++;
  }
  return rows.filter(r => r.total).sort((a, b) => b.total - a.total);
}

export function focusAuthors(papers) {
  const map = new Map();
  for (const p of papers) for (const a of p.authors) {
    const k = authorKey(a);
    let row = map.get(k);
    if (!row) map.set(k, row = { key: k, name: a.n, inst: '', papers: [], cited: 0, local: 0, strands: {}, last: '' });
    row.papers.push(p); row.cited += p.cited || 0; row.local += p.citedBy.length;
    if (a.inst && !row.inst) row.inst = a.inst;
    for (const s of p.strands) row.strands[s] = (row.strands[s] || 0) + 1;
    if (p.published > row.last) row.last = p.published;
  }
  return [...map.values()];
}

/** Papers that cite the same papers of the area (bibliographic coupling), strongest first. */
export function coupled(F, p, n = 6) {
  if (!p.cites.length) return [];
  const mine = new Set(p.cites), score = new Map();
  for (const r of p.cites) for (const id of F.byId.get(r)?.citedBy || []) if (id !== p.id) score.set(id, (score.get(id) || 0) + 1);
  return [...score].filter(([id, s]) => s >= 2 && !mine.has(id) && !p.citedBy.includes(id))
    .sort((a, b) => b[1] - a[1]).slice(0, n).map(([id, s]) => ({ paper: F.byId.get(id), shared: s }));
}

export const shortLabel = p => `${(p.authors[0]?.n || p.venue || '?').split(/\s+/).at(-1)}${p.authors.length > 2 ? ' et al.' : p.authors.length === 2 ? ' & ' + p.authors[1].n.split(/\s+/).at(-1) : ''} ${p.year || ''}`.trim();

/**
 * Citation map of the selected papers: the `max` most cited within the area, each linked to
 * the papers it cites; papers that share several references are also tied (dashed, weaker).
 * Papers without any tie are left out so the map shows how the literature connects.
 */
export function citationGraph(F, papers, { max = 250, upTo = 0, coupling = true } = {}) {
  const pool = upTo ? papers.filter(p => p.year && p.year <= upTo) : papers;
  const set = sortFocus(pool, 'local').slice(0, max);
  const ids = new Set(set.map(p => p.id));
  const links = [], seen = new Set();
  for (const p of set) for (const r of p.cites) if (ids.has(r)) { links.push({ source: p.id, target: r, weight: 2, kind: 'cites', isNew: false }); seen.add(p.id + '|' + r).add(r + '|' + p.id); }
  if (coupling) {
    const citing = new Map();
    for (const p of set) for (const r of p.cites) { let l = citing.get(r); if (!l) citing.set(r, l = []); l.push(p.id); }
    const pair = new Map();
    for (const list of citing.values()) if (list.length <= 60) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const k = list[i] < list[j] ? list[i] + '|' + list[j] : list[j] + '|' + list[i];
      pair.set(k, (pair.get(k) || 0) + 1);
    }
    const per = new Map();
    for (const [k, s] of [...pair].filter(([k, s]) => s >= 3 && !seen.has(k)).sort((a, b) => b[1] - a[1])) {
      const [a, b] = k.split('|');
      if ((per.get(a) || 0) >= 3 || (per.get(b) || 0) >= 3) continue;
      per.set(a, (per.get(a) || 0) + 1); per.set(b, (per.get(b) || 0) + 1);
      links.push({ source: a, target: b, weight: Math.min(2, s / 3), kind: 'shared', isNew: true });
    }
  }
  const linked = new Set(links.flatMap(l => [l.source, l.target]));
  const nodes = set.filter(p => linked.has(p.id)).map(p => ({ id: p.id, kind: 'paper', label: shortLabel(p), count: 1 + p.citedBy.length, strand: p.strands[0], year: p.year, paper: p }));
  return { nodes, links, total: pool.length, shown: nodes.length };
}
