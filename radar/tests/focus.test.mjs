import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../core.mjs?v=5';
import * as FC from '../focus-core.mjs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const spec = JSON.parse(readFileSync(new URL('../focus.json', import.meta.url), 'utf8')).areas[0];
const ctx = C.createContext(config);
const paper = (id, over = {}) => ({ id, doi: `10.1/${id}`, title: `Paper ${id}`, venue: 'Journal X', kind: 'article', published: '2020-05-01', authors: [{ n: 'Ada Lovelace', id: 'A1' }],
  strands: ['uct'], outcomes: ['labour'], cited: 10, cy: [1, 2, 3, 4], methods: ['rct'], cites: [], disc: 'Economics', ...over });

test('prepare keeps known strands, adds reverse citations and matching radar papers', () => {
  const data = { papers: [paper('W1', { cites: ['W2', 'W404'] }), paper('W2', { strands: ['ubi', 'astrology'], published: '2016-01-01' }), paper('W3', { strands: ['astrology'] })] };
  const radar = [
    C.normalizePaper({ id: 'nber-w36010', doi: '10.3386/w36010', title: 'A Universal Basic Income Pilot', journal: 'nber', kind: 'working', published: '2026-11-09', added: '2026-11-12', url: 'u', authors: [{ n: 'Grace Hopper' }], abstract: 'Employment effects of cash.' }, ctx),
    C.normalizePaper({ id: 'W9', title: 'Monetary policy', journal: 'aer', published: '2026-11-01', added: '2026-11-12', url: 'u', authors: [{ n: 'X' }] }, ctx),
    C.normalizePaper({ id: 'W1', doi: '10.1/W1', title: 'Unconditional cash transfers', journal: 'aer', published: '2020-05-01', added: '2026-11-12', url: 'u', authors: [{ n: 'X' }] }, ctx),
  ];
  radar.push(C.normalizePaper({ id: 'W8', title: 'Guaranteed income annuities and bancassurance', journal: 'jf', published: '2026-11-01', added: '2026-11-12', url: 'u', authors: [{ n: 'X' }] }, ctx));
  radar.push(C.normalizePaper({ id: 'W7', title: 'Cash-transfer programmes in Peru', journal: 'jde', published: '2026-11-01', added: '2026-11-12', url: 'u', authors: [{ n: 'X' }] }, ctx));
  const F = FC.prepareFocus(data, spec, { radar, ctx });
  assert.deepEqual(F.papers.map(p => p.id), ['W1', 'W2', 'nber-w36010', 'W7'], 'unknown strands dropped; radar duplicates and other senses skipped; hyphens match');
  assert.deepEqual(F.byId.get('W2').citedBy, ['W1']);
  assert.deepEqual(F.byId.get('W2').strands, ['ubi']);
  const r = F.byId.get('nber-w36010');
  assert.deepEqual([r.radar, r.kind, r.venue, r.strands[0], r.cited], [true, 'working', 'NBER Working Papers', 'ubi', null]);
  assert.ok(r.outcomes.includes('labour'));
  assert.equal(F.byId.get('W1').url, 'https://doi.org/10.1/W1', 'DOI links are rebuilt');
  const S = FC.prepareFocus({ papers: [paper('W5', { summary: 'Basic income and fertility in Finland.' })] }, spec);
  assert.ok(S.byId.get('W5').text.includes('finland'), 'summaries are searched');
});

test('filters combine facets with AND and values with OR; sorting', () => {
  const F = FC.prepareFocus({ papers: [
    paper('W1', { published: '2018-02-01', cited: 50, cy: [0, 0, 1, 0] }),
    paper('W2', { strands: ['wealth-tax'], outcomes: ['responses'], published: '2024-02-01', kind: 'working', cites: ['W1'], cited: 5, cy: [0, 0, 3, 9], methods: ['did'] }),
    paper('W3', { strands: ['ubi'], published: '2022-02-01', authors: [{ n: 'Grace Hopper', id: 'A2' }], cites: ['W1'], cited: 0, cy: null, methods: [] }),
  ] }, spec);
  const f = over => ({ ...FC.cleanFocusFilters({}, spec), all: true, ...over });
  const ids = over => FC.filterFocus(F, f(over), { user: { saved: { W3: '2026-11-12' } } }).map(p => p.id);
  assert.deepEqual(ids({ strands: ['uct', 'ubi'] }), ['W3', 'W1']);
  assert.deepEqual(ids({ strands: ['uct', 'wealth-tax'], kinds: ['working'] }), ['W2']);
  assert.deepEqual(ids({ from: 2020 }), ['W2', 'W3']);
  assert.deepEqual(ids({ methods: ['did', 'iv'] }), ['W2']);
  assert.deepEqual(ids({ author: 'A2' }), ['W3']);
  assert.deepEqual(ids({ saved: true }), ['W3']);
  assert.deepEqual(ids({ q: 'lovelace paper w2' }), ['W2']);
  assert.deepEqual(ids({ sort: 'local' })[0], 'W1');
  assert.deepEqual(ids({ sort: 'rising' })[0], 'W2');
  assert.deepEqual(ids({ sort: 'cited' }), ['W1', 'W2', 'W3']);
  const G = FC.prepareFocus({ papers: [paper('J1', { cited: 0, venue: 'Intl. J. of Everything' }), paper('J2', { cited: 0, venue: 'NBER Working Papers', kind: 'working' }), paper('J3', { cited: 0, core: true }), paper('J4', { cited: 7 })] }, spec);
  assert.deepEqual(FC.filterFocus(G, FC.cleanFocusFilters({}, spec)).map(p => p.id).sort(), ['J2', 'J3', 'J4'], 'established venues by default');
  assert.equal(FC.filterFocus(G, f({ all: true })).length, 4);
  const clean = FC.cleanFocusFilters({ strands: ['uct', 'nope'], kinds: ['zine'], from: 'x', sort: 'random', saved: 'yes' }, spec);
  assert.deepEqual([clean.strands, clean.kinds, clean.from, clean.sort, clean.saved], [['uct'], [], 0, 'newest', false]);
});

test('yearly counts, outcome matrix and authors', () => {
  const F = FC.prepareFocus({ papers: [paper('W1', { published: '2016-03-01' }), paper('W2', { strands: ['wealth-tax', 'ubi'], published: '2018-03-01', outcomes: ['labour', 'health'] })] }, spec);
  const y = FC.yearlyByStrand(F, F.papers, { from: 2015 });
  assert.deepEqual(y.years, [2015, 2016, 2017, 2018]);
  assert.deepEqual(y.series.map(s => [s.key, s.values]), [['uct', [0, 1, 0, 0]], ['ubi', [0, 0, 0, 1]]], 'each paper once, under its first strand in focus.json order');
  const m = FC.outcomeMatrix(F, F.papers);
  assert.equal(m[0].key, 'labour');
  const col = k => [...F.strands.keys()].indexOf(k);
  assert.deepEqual([m[0].total, m[0].cells[col('uct')], m[0].cells[col('ubi')], m[0].cells[col('wealth-tax')]], [2, 1, 1, 1], 'a paper counts in each of its strands');
  const a = FC.focusAuthors(F.papers).find(x => x.key === 'A1');
  assert.deepEqual([a.papers.length, a.cited, a.strands.uct, a.strands['wealth-tax']], [2, 20, 1, 1]);
});

test('citation map ties citing papers and papers sharing references, without isolates', () => {
  const refs = ['W1', 'W2', 'W3'];
  const F = FC.prepareFocus({ papers: [paper('W1'), paper('W2'), paper('W3'), paper('W4', { cites: refs, published: '2023-01-01' }), paper('W5', { cites: refs, published: '2024-01-01' }), paper('W6')] }, spec);
  const g = FC.citationGraph(F, F.papers, { max: 50 });
  const ends = g.links.map(l => `${l.source}>${l.target}:${l.kind}`);
  assert.ok(ends.includes('W4>W1:cites'));
  assert.ok(ends.some(e => e.endsWith(':shared') && e.includes('W4') && e.includes('W5')), 'three shared references tie W4 and W5');
  assert.ok(!g.nodes.some(n => n.id === 'W6'), 'papers without ties are left out');
  assert.equal(g.nodes.find(n => n.id === 'W1').count, 3);
  assert.deepEqual(FC.citationGraph(F, F.papers, { upTo: 2023 }).nodes.map(n => n.id).sort(), ['W1', 'W2', 'W3', 'W4']);
  assert.deepEqual(FC.coupled(F, F.byId.get('W4')).map(x => [x.paper.id, x.shared]), [['W5', 3]]);
  assert.equal(FC.shortLabel(F.byId.get('W4')), 'Lovelace 2023');
});
