import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as C from '../core.mjs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const ctx = C.createContext(config);
const paper = (id, over = {}) => C.normalizePaper({
  id, title: `Paper ${id}`, journal: 'aer', published: '2026-06-01', added: '2026-11-01', url: 'https://doi.org/x',
  authors: [{ n: 'Ada Lovelace', id: 'A1', inst: 'MIT' }], fields: ['labour'], methods: ['did'], data: ['admin'], topics: ['minimum wage'], by: 'claude-opus-5-5', ...over,
}, ctx);

test('normalisation keeps only known taxonomy keys and drops broken records', () => {
  const p = paper('W1', { fields: ['labour', 'astrology'], methods: ['magic', 'rdd'], topics: ['Minimum Wage', 'minimum wage'] });
  assert.deepEqual(p.fields, ['labour']);
  assert.deepEqual(p.methods, ['rdd']);
  assert.deepEqual(p.topics, ['minimum wage']);
  assert.equal(paper('W9', { contribution: 'Provides the first estimate.' }).contribution, 'Provides the first estimate.');
  assert.equal(C.normalizePaper({ id: 'x' }, ctx), null);
  assert.equal(C.mergeShards([{ papers: [paper('W1'), paper('W1')] }, { papers: [paper('W2')] }], ctx).length, 2);
});

test('filters: within a facet any value matches, across facets all must', () => {
  const list = [paper('W1'), paper('W2', { fields: ['econ-history'], methods: ['iv'], journal: 'jeh' }), paper('W3', { fields: ['labour'], methods: ['iv'], added: '2026-09-01' })];
  const f = { ...C.cleanFilters({}), methods: ['did', 'iv'], fields: ['labour'] };
  assert.deepEqual(C.filterPapers(list, f, ctx).map(p => p.id), ['W1', 'W3']);
  assert.deepEqual(C.filterPapers(list, { ...C.cleanFilters({}), families: ['history'] }, ctx).map(p => p.id), ['W2']);
  assert.deepEqual(C.filterPapers(list, { ...C.cleanFilters({}), families: ['history'], fields: ['labour'] }, ctx).map(p => p.id), ['W1', 'W2', 'W3'], 'field and family choices combine with OR');
  assert.deepEqual(C.filterPapers(list, { ...C.cleanFilters({}), journals: ['jeh'] }, ctx).map(p => p.id), ['W2']);
  const dated = [paper('D1', { published: '2026-11-01', added: '2026-11-12' }), paper('D2', { published: '2026-06-01', added: '2026-11-12' }), paper('D3', { published: '', added: '2026-11-05' })];
  assert.deepEqual(C.filterPapers(dated, { ...C.cleanFilters({}), period: '30d' }, ctx, { today: '2026-11-12' }).map(p => p.id), ['D1', 'D3'], 'publication date, falling back to the day added');
  assert.deepEqual(C.filterPapers(dated, { ...C.cleanFilters({}), period: 'custom', from: '2026-05-01', to: '2026-06-30' }, ctx).map(p => p.id), ['D2']);
  assert.deepEqual(C.filterPapers(dated, { ...C.cleanFilters({}), run: '2026-11-05' }, ctx).map(p => p.id), ['D3'], 'update chips filter on the day added');
  assert.deepEqual(C.filterPapers(list, { ...C.cleanFilters({}), q: 'lovelace paper w3' }, ctx).map(p => p.id), ['W3']);
  assert.deepEqual(C.filterPapers(list, { ...C.cleanFilters({}), authors: ['A1'], saved: true }, ctx, { user: { saved: { W2: '2026-11-01' } } }).map(p => p.id), ['W2']);
});

test('cleanFilters rejects junk from storage', () => {
  assert.equal(C.cleanFilters({ period: 'last-run' }).period, 'all', 'the old date-added preset is dropped');
  const f = C.cleanFilters({ q: 5, fields: 'labour', period: 'forever', saved: 'yes', methods: ['did'] });
  assert.equal(f.q, '5'); assert.deepEqual(f.fields, []); assert.equal(f.period, 'all'); assert.equal(f.saved, false); assert.deepEqual(f.methods, ['did']);
  assert.equal(C.activeFilterCount(f), 2);
});

test('firsts follow publication dates, with the corpus\'s first year as the baseline', () => {
  const seed = paper('W1', { published: '2020-03-01' });
  const early = paper('W3', { published: '2020-11-01', methods: ['rdd'] });
  const later = paper('W2', { published: '2021-05-01', fields: ['econ-history'], methods: ['did', 'synth'], data: ['admin'], topics: ['railways'] });
  const map = C.firsts([later, early, seed]);
  assert.equal(map.has('W1'), false);
  assert.equal(map.has('W3'), false, 'still inside the baseline year');
  const kinds = map.get('W2').map(i => C.describeFirst(i, ctx));
  assert.ok(kinds.includes('First Difference-in-differences in Economic history'));
  assert.ok(kinds.includes('First Synthetic control paper in the radar'));
  assert.ok(!kinds.includes('First Synthetic control in Economic history'), 'a brand-new method is reported once');
  assert.ok(kinds.includes('New topic: railways'));
});

test('strands graph counts co-occurrences and marks new ties', () => {
  const list = [paper('W1'), paper('W2'), paper('W3', { added: '2026-11-10', methods: ['did', 'event-study'] })];
  const g = C.strandsGraph(list, ctx, { minEdge: 1, minTopic: 1, newSince: '2026-11-10' });
  const tie = g.links.find(l => [l.source, l.target].sort().join() === ['field:labour', 'method:did'].sort().join());
  assert.equal(tie.weight, 3);
  assert.equal(tie.isNew, false);
  const fresh = g.links.find(l => l.source.includes('event-study') || l.target.includes('event-study'));
  assert.equal(fresh.isNew, true);
  assert.equal(g.nodes.find(n => n.id === 'topic:minimum wage').family, 'labour');
  const strict = C.strandsGraph(list, ctx, { minEdge: 2, minTopic: 1 });
  assert.ok(strict.links.every(l => l.weight >= 2));
});

test('paper graph links papers that share authors and topics', () => {
  const list = [paper('W1'), paper('W2'), paper('W3', { authors: [{ n: 'Someone Else', id: 'A9' }], fields: ['macro'], methods: ['time-series'], data: [], topics: ['inflation'] })];
  const g = C.paperGraph(list, ctx, { minScore: 1 });
  const ends = g.links.map(l => [l.source, l.target].sort().join());
  assert.ok(ends.includes('W1,W2'));
  assert.ok(!ends.some(e => e.includes('W3')));
});

test('paper ties can be restricted to one kind of match, and say what is shared', () => {
  const list = [
    paper('P1', { topics: ['minimum wage'], methods: ['did'], authors: [{ n: 'A', id: 'A1' }] }),
    paper('P2', { topics: ['minimum wage'], methods: ['rdd'], authors: [{ n: 'B', id: 'B1' }] }),
    paper('P3', { topics: ['trade'], fields: ['international'], methods: ['did'], authors: [{ n: 'C', id: 'C1' }] }),
    paper('P4', { topics: ['inflation'], fields: ['macro'], methods: ['structural'], authors: [{ n: 'A', id: 'A1' }] }),
  ];
  const ends = match => C.paperGraph(list, ctx, { match }).links.map(l => [l.source, l.target].sort().join());
  assert.ok(ends('topic').includes('P1,P2') && !ends('topic').includes('P1,P3'));
  assert.ok(ends('ident').includes('P1,P3') && !ends('ident').includes('P1,P2'));
  assert.deepEqual(ends('author'), ['P1,P4']);
  const tie = C.paperGraph(list, ctx, { match: 'topic' }).links.find(l => [l.source, l.target].sort().join() === 'P1,P2');
  assert.ok(C.describeShared(tie.why, ctx).includes('minimum wage'));
  const byAuthor = C.paperGraph(list, ctx, { match: 'author' }).links[0];
  assert.deepEqual(C.describeShared(byAuthor.why, ctx, [list[0], list[3]]), ['A']);
  assert.equal(C.normalizePaper({ id: 'X', title: 'T', doi: '10.1/x' }, ctx).url, 'https://doi.org/10.1/x');
});

test('author graph and index tie authors to fields and co-authors', () => {
  const two = [{ n: 'Ada Lovelace', id: 'A1' }, { n: 'Grace Hopper', id: 'A2' }];
  const list = [paper('W1', { authors: two }), paper('W2', { authors: two, fields: ['econ-history', 'labour'] })];
  const g = C.authorGraph(list, ctx, { minPapers: 1 });
  assert.ok(g.links.some(l => l.kind === 'coauthor' && l.weight === 2));
  assert.ok(g.nodes.some(n => n.id === 'field:econ-history'));
  const a = C.authorIndex(list).get('A1');
  assert.equal(a.papers.length, 2);
  assert.equal(C.mainField(a), 'labour');
  assert.equal(C.authorKey({ n: 'José  Núñez' }), 'n:jose nunez');
});

test('trends: periods, facet mix and risers', () => {
  assert.deepEqual(C.periodsBetween('2026-05-10', '2026-11-02'), ['2026-Q2', '2026-Q3', '2026-Q4']);
  assert.deepEqual(C.periodsBetween('2026-11-02', '2027-01-05', 'month'), ['2026-11', '2026-12', '2027-01']);
  const list = [paper('W1', { published: '2026-05-02' }), paper('W2', { published: '2026-10-02', methods: ['rdd'] }), paper('W3', { published: '2026-10-20', methods: ['rdd'] })];
  const mix = C.facetMix(list, 'methods', { top: 1 });
  assert.deepEqual(mix.periods, ['2026-Q2', '2026-Q3', '2026-Q4']);
  assert.deepEqual(mix.series[0], { key: 'rdd', values: [0, 0, 2] });
  assert.deepEqual(mix.series[1], { key: 'other', values: [1, 0, 0] });
  const r = C.risers(list, 'methods', { today: '2026-11-12', recentDays: 90, min: 1 });
  assert.equal(r[0].key, 'rdd');
  assert.ok(r[0].change > 0);
});

test('exports escape what they must', () => {
  const p = paper('W1', { title: 'Wages & {Profits}: 50% of $ gains', doi: '10.1/x' });
  const bib = C.toBibtex(p, ctx);
  assert.match(bib, /@article\{lovelace2026wages,/);
  assert.match(bib, /title = \{Wages \\& Profits: 50\\% of \\\$ gains\}/);
  assert.match(C.toRis(p, ctx), /^TY {2}- JOUR\r\n/);
  const csv = C.toCsv([p], ctx).split('\r\n');
  assert.equal(csv.length, 2);
  assert.match(csv[0], /,question,contribution,summary,/);
  assert.match(csv[1], /,Wages & \{Profits\}: 50% of \$ gains,/);
});

test('personal state is cleaned on import', () => {
  const u = C.cleanUser({ saved: { W1: '2026-11-01', W2: 'nope' }, notes: { W1: '  ', W2: 'read this' }, follow: { A1: true }, lastVisit: 'bad' });
  assert.deepEqual(Object.keys(u.saved), ['W1']);
  assert.deepEqual(u.notes, { W2: 'read this' });
  assert.deepEqual(u.follow, { A1: true });
  assert.equal(u.lastVisit, '');
});

test('service worker serves paper data network-first and retires only its own caches', async () => {
  const handlers = {}, deleted = [];
  const store = { addAll: async () => {}, put: async () => {} };
  const scope = { self: { addEventListener: (n, h) => { handlers[n] = h; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { open: async () => store, keys: async () => ['econradar-v11', 'reading-room-v26', 'econradar-v14'], delete: async k => { deleted.push(k); return true; }, match: async () => 'cached' },
    location: { origin: 'https://example.org' }, URL, fetch: async () => { throw new Error('offline'); } };
  runInNewContext(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), scope);
  let p; handlers.activate({ waitUntil: x => { p = x; } }); await p;
  assert.deepEqual(deleted, ['econradar-v11']);
  let response; handlers.fetch({ request: { url: 'https://example.org/Apps/radar/data/index.json', method: 'GET', mode: 'cors' }, respondWith: r => { response = r; } });
  assert.equal(await response, 'cached');
});

test('the flag link pre-fills the Google Form with the paper, and only a Google Form', () => {
  const p = { id: 'W1', title: 'Wages & Jobs' };
  const form = 'https://docs.google.com/forms/d/e/abc/viewform?usp=pp_url&entry.1=PAPERID&entry.2=PAPERTITLE';
  assert.equal(C.flagUrl(form, p), 'https://docs.google.com/forms/d/e/abc/viewform?usp=pp_url&entry.1=W1&entry.2=Wages%20%26%20Jobs');
  assert.equal(C.flagUrl('', p), '');
  assert.equal(C.flagUrl('https://evil.example/?x=PAPERID', p), '');
});
