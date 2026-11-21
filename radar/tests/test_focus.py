"""Focus-area collector checks, no network. Run: python3 -m unittest discover -s radar/tests"""
import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
import collect_focus as cf  # noqa: E402
import radar_enrich as enrich  # noqa: E402

CONFIG = json.loads((ROOT / 'radar/config.json').read_text())
FOCUS = json.loads((ROOT / 'radar/focus.json').read_text())
TAX = enrich.Taxonomy(CONFIG)
SPEC = FOCUS['areas'][0]
TODAY = date(2026, 11, 12)


def work(n, title='Unconditional Cash Transfers and Labor Supply', abstract='We study an unconditional cash transfer in Kenya using a randomized controlled trial. Employment does not fall.', refs=(), **over):
    words = abstract.split()
    w = {'id': f'https://openalex.org/W{n}', 'doi': f'https://doi.org/10.1/{n}', 'title': title, 'publication_date': '2024-03-01',
         'type': 'article', 'primary_location': {'source': {'id': 'https://openalex.org/S1', 'display_name': 'Journal of Development Economics'}},
         'authorships': [{'author': {'id': 'https://openalex.org/A1', 'display_name': 'Ada Lovelace'}, 'institutions': [{'display_name': 'MIT'}]}],
         'abstract_inverted_index': {word: [i] for i, word in enumerate(words)} if abstract else None,
         'cited_by_count': 12, 'counts_by_year': [{'year': 2026, 'cited_by_count': 5}, {'year': 2025, 'cited_by_count': 7}],
         'referenced_works': [f'https://openalex.org/W{r}' for r in refs],
         'primary_topic': {'field': {'display_name': 'Economics, Econometrics and Finance'}, 'subfield': {'display_name': 'Economics and Econometrics'}},
         'keywords': [], 'locations': [], 'best_oa_location': None}
    w.update(over)
    return w


class FakeSearcher(cf.Searcher):
    """Serves pages from {query text: [page1, page2, ...]}; counts and caps like the real one."""

    def __init__(self, pages, budget=100):
        super().__init__(budget)
        self.pages, self.calls = pages, []

    def page(self, query, since, page):
        if self.used >= self.budget:
            raise cf.OutOfBudget()
        self.used += 1
        self.calls.append((query['q'][:20], since, page))
        rows = [w for chunk in self.pages.get(query['q'], []) for w in chunk if w['publication_date'] >= since]
        return rows[(page - 1) * 200:page * 200], len(rows)


class Focus(unittest.TestCase):
    def setUp(self):
        self.area = cf.Area(SPEC, TAX)

    def test_config_strands_and_outcomes_compile(self):
        keys = [s['key'] for s in SPEC['strands']]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertTrue(all(q['in'] in ('title', 'title_and_abstract') for s in SPEC['strands'] for q in s['queries']))
        self.assertEqual(SPEC['since'], '2015-01-01')

    def test_record_tags_strands_outcomes_and_discipline(self):
        rec, refs, _ = cf.record_from(work(1, refs=[2, 3]), self.area, TODAY)
        self.assertEqual(rec['strands'], ['uct', 'cash'] if 'cash' in rec['strands'] else ['uct'])
        self.assertIn('labour', rec['outcomes'])
        self.assertEqual((rec['disc'], rec['sub'], rec['kind']), ('Economics', 'Economics and Econometrics', 'article'))
        self.assertEqual(rec['cy'], [0, 0, 7, 5])
        self.assertEqual(refs, ['W2', 'W3'])
        self.assertEqual(rec['venue'], 'Journal of Development Economics')

    def test_title_only_strands_need_the_title(self):
        # "cash transfers" in the abstract alone does not make a paper part of the broad cash-transfer strand
        rec, _, _ = cf.record_from(work(1, title='Universal Basic Income and Work', abstract='Cash transfers to all residents of a town.'), self.area, TODAY)
        self.assertEqual(rec['strands'], ['ubi'])
        self.assertIsNone(cf.record_from(work(2, title='Firm Dynamics', abstract='Nothing about transfers here.'), self.area, TODAY))
        self.assertEqual(cf.record_from(work(3, type='preprint'), self.area, TODAY)[0]['kind'], 'working')

    def test_store_merges_refreshes_and_links_citations_within_the_area(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = cf.AreaStore(Path(tmp), 'x')
            store.put(*cf.record_from(work(1, refs=[2, 99]), self.area, TODAY), TAX, TODAY)
            store.put(*cf.record_from(work(2), self.area, TODAY), TAX, TODAY)
            first = store.papers['W1']
            first['q'] = 'kept'
            again = cf.record_from(work(1, refs=[2, 99], cited_by_count=40, title='Universal Basic Income and Unconditional Cash Transfers'), self.area, TODAY)
            self.assertFalse(store.put(*again, TAX, TODAY))
            self.assertEqual((store.added, store.updated), (2, 1))
            self.assertEqual(first['cited'], 40)
            self.assertEqual(first['q'], 'kept', 'tags and summaries survive a refresh')
            self.assertIn('ubi', first['strands'])
            store.save({'key': 'x', 'title': 'X', 'since': '2015-01-01'}, TODAY)
            saved = json.loads((Path(tmp) / 'focus-x.json').read_text())
            self.assertEqual({p['id']: p.get('cites', []) for p in saved['papers']}, {'W1': ['W2'], 'W2': []})
            self.assertNotIn('abstract', saved['papers'][0], 'abstracts live in their own file')
            self.assertNotIn('url', saved['papers'][0], 'a DOI link is rebuilt from the DOI')
            self.assertTrue(json.loads((Path(tmp) / 'focus-x-abstracts.json').read_text())['W1'].startswith('We study'))
            reloaded = cf.AreaStore(Path(tmp), 'x')
            self.assertEqual(reloaded.papers['W1']['abstract'], first['abstract'])
            self.assertEqual(reloaded.papers['W1']['url'], 'https://doi.org/10.1/1')
            self.assertEqual(json.loads((Path(tmp) / 'focus-x-refs.json').read_text())['W1'], ['W2', 'W99'])
            self.assertEqual(first['by'], 'rules')
            self.assertNotIn('summary', saved['papers'][1], 'rules summaries would only repeat the abstract')

    def test_public_copy_has_only_summarised_papers_citing_each_other(self):
        with tempfile.TemporaryDirectory() as tmp:
            public = Path(tmp) / 'public'
            store = cf.AreaStore(Path(tmp) / 'store', 'x', public=public)
            for n, title in ((1, 'Universal Basic Income and Work'), (2, 'Universal Basic Income in Finland'), (3, 'Universal Basic Income and Spending')):
                store.put(*cf.record_from(work(n, title=title, refs=[2, 3]), self.area, TODAY), TAX, TODAY)
            store.papers['W1'].update(by='claude-sonnet-5-5', summary='Labour supply holds.', q='', ident='', contribution='')
            store.papers['W3'].update(by='claude-sonnet-5-5', summary='Spending rises.', q='', ident='', contribution='')
            store.save({'key': 'x', 'title': 'X', 'since': '2015-01-01'}, TODAY)
            shown = json.loads((public / 'focus-x.json').read_text())
            self.assertEqual({p['id']: p.get('cites', []) for p in shown['papers']}, {'W1': ['W3'], 'W3': []})
            self.assertEqual(shown['total'], 2)
            self.assertNotIn('searches', shown)
            self.assertEqual(sorted(f.name for f in public.iterdir()), ['focus-x.json'], 'no abstracts or references published')
            self.assertNotIn('We study', (public / 'focus-x.json').read_text())
            self.assertEqual(len(json.loads((Path(tmp) / 'store' / 'focus-x.json').read_text())['papers']), 3)

    def test_duplicates_merge_into_the_journal_version_and_citations_follow(self):
        title = 'Universal Basic Income and the Labor Supply of Young Adults'
        with tempfile.TemporaryDirectory() as tmp:
            store = cf.AreaStore(Path(tmp), 'x')
            store.put(*cf.record_from(work(1, title=title, type='preprint', cited_by_count=30, refs=[7]), self.area, TODAY), TAX, TODAY)
            store.put(*cf.record_from(work(2, title=title + '.', cited_by_count=12, refs=[8]), self.area, TODAY), TAX, TODAY)
            store.put(*cf.record_from(work(3, refs=[1]), self.area, TODAY), TAX, TODAY)
            store.put(*cf.record_from(work(4, title='Basic Income', abstract='A universal basic income.'), self.area, TODAY), TAX, TODAY)
            store.put(*cf.record_from(work(5, title='Basic Income', abstract='A universal basic income, again.'), self.area, TODAY), TAX, TODAY)
            store.save({'key': 'x', 'title': 'X', 'since': '2015-01-01'}, TODAY)
            self.assertEqual(sorted(store.papers), ['W2', 'W3', 'W4', 'W5'], 'short titles are never merged')
            self.assertEqual((store.papers['W2']['kind'], store.papers['W2']['cited']), ('article', 30))
            self.assertEqual(store.papers['W3']['cites'], ['W2'], 'a citation of the preprint counts for the journal version')
            self.assertEqual(store.alias, {'W1': 'W2'})
            again = cf.AreaStore(Path(tmp), 'x')
            self.assertFalse(again.put(*cf.record_from(work(1, title=title, type='preprint', cited_by_count=45), self.area, TODAY), TAX, TODAY))
            self.assertEqual((sorted(again.papers), again.papers['W2']['cited'], again.papers['W2']['kind']), (['W2', 'W3', 'W4', 'W5'], 45, 'article'))

    def test_papers_follow_edits_to_focus_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = cf.AreaStore(Path(tmp), 'x')
            store.put(*cf.record_from(work(1), self.area, TODAY), TAX, TODAY)
            store.put(*cf.record_from(work(2, title='Universal Basic Income in Finland', abstract='Employment effects.'), self.area, TODAY), TAX, TODAY)
            store.put(*cf.record_from(work(3, title='Cash-transfer programmes and school enrolment', abstract='Enrolment rises.'), self.area, TODAY), TAX, TODAY)
            store.put(*cf.record_from(work(4, title='A study of household finance', abstract=('Words ' * 160) + 'and a universal basic income.'), self.area, TODAY), TAX, TODAY)
            self.assertEqual(store.papers['W3']['strands'], ['cash'], 'a hyphen still matches')
            self.assertEqual(store.prune(self.area), 0, 'a match past the stored excerpt is kept')
            narrower = dict(SPEC, strands=[s for s in SPEC['strands'] if s['key'] not in ('uct', 'cash')])
            self.assertEqual(store.prune(cf.Area(narrower, TAX)), 2)
            self.assertEqual(sorted(store.papers), ['W2', 'W4'])

    def test_other_senses_and_data_deposits_are_left_out(self):
        insurance = work(1, title='Customer Satisfaction with Bancassurance', abstract='Policies with a guaranteed income benefit sold by banks.')
        self.assertIsNone(cf.record_from(insurance, self.area, TODAY))
        self.assertIsNone(cf.record_from(work(2, title='Data and code: Effects of cash transfers on mental health'), self.area, TODAY))
        rec = cf.record_from(work(3, primary_location={'source': {'display_name': 'QJE', 'is_core': True}}), self.area, TODAY)[0]
        self.assertTrue(rec['core'])

    def test_a_pass_cut_short_resumes_where_it_stopped_then_only_new_papers_are_asked_for(self):
        q = SPEC['strands'][0]['queries'][0]['q']
        pages = {q: [[work(i) for i in range(200)], [work(i) for i in range(200, 400)], [work(400)]]}
        with tempfile.TemporaryDirectory() as tmp:
            store = cf.AreaStore(Path(tmp), SPEC['key'])
            s1 = FakeSearcher(pages, budget=2)
            cf.update_area(SPEC, TAX, store, s1, TODAY)
            self.assertEqual(store.state['uct#0'], {'next': 3})
            self.assertEqual(len(store.papers), 400)
            s2 = FakeSearcher(pages, budget=100)
            cf.update_area(SPEC, TAX, store, s2, TODAY)
            self.assertEqual(s2.calls[0][2], 3, 'resumes at page 3, not page 1')
            self.assertEqual(store.state['uct#0'], {'full': '2026-11-12', 'recent': '2026-11-12'})
            self.assertEqual(len(store.papers), 401)
            later = date(2026, 11, 20)
            s3 = FakeSearcher(pages, budget=100)
            cf.update_area(SPEC, TAX, store, s3, later)
            uct = [c for c in s3.calls if c[0] == q[:20]]
            self.assertEqual(uct, [(q[:20], '2026-07-23', 1)], 'after a full pass: only the last 120 days')

    def test_refusal_keeps_what_was_read(self):
        class Refusing(FakeSearcher):
            def page(self, query, since, page):
                raise OSError('connection reset')
        with tempfile.TemporaryDirectory() as tmp:
            store = cf.AreaStore(Path(tmp), SPEC['key'])
            with self.assertLogs('radar', 'WARNING'):
                cf.update_area(SPEC, TAX, store, Refusing({}), TODAY)
            self.assertEqual(store.state['uct#0'], {'next': 1})


if __name__ == '__main__':
    unittest.main()
