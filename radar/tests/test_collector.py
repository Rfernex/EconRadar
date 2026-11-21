"""Collector checks that need no network. Run: python3 -m unittest discover -s radar/tests"""
import json
import sys
import tempfile
import unittest
import contextlib
import io
import unittest.mock
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
import collect_literature as cl  # noqa: E402
import radar_enrich as enrich  # noqa: E402

CONFIG = json.loads((ROOT / 'radar/config.json').read_text())
TAX = enrich.Taxonomy(CONFIG)


def work(**over):
    w = {'id': 'https://openalex.org/W1', 'doi': 'https://doi.org/10.1257/aer.1', 'title': 'Minimum Wages and Monopsony',
         'publication_date': '2026-10-01', 'type': 'article',
         'primary_location': {'source': {'id': 'https://openalex.org/S23254222'}},
         'authorships': [{'author': {'id': 'https://openalex.org/A1', 'display_name': 'Ada Lovelace', 'orcid': 'https://orcid.org/0000-1'},
                          'institutions': [{'display_name': 'MIT'}], 'countries': ['US']}],
         'abstract_inverted_index': {'We': [0], 'study': [1], 'wages.': [2]},
         'best_oa_location': {'pdf_url': 'https://arxiv.org/pdf/1'}, 'locations': [{'pdf_url': 'https://arxiv.org/pdf/1'}],
         'keywords': [{'display_name': 'Minimum wage', 'score': 0.9}], 'biblio': {}}
    w.update(over)
    return w


class Collector(unittest.TestCase):
    journals = {j['openalex']: j for j in CONFIG['journals']}

    def test_config_keys_are_unique_and_families_known(self):
        for section in ('fields', 'methods', 'dataTypes', 'journals'):
            keys = [x['key'] for x in CONFIG[section]]
            self.assertEqual(len(keys), len(set(keys)), section)
        families = {f['key'] for f in CONFIG['families']}
        self.assertTrue(all(f['family'] in families for f in CONFIG['fields']))
        econ = [j for j in CONFIG['journals'] if j['group'] in ('general', 'field')]
        self.assertLessEqual(len(econ), 30)
        groups = {g['key'] for g in CONFIG['journalGroups']}
        self.assertTrue(all(j['group'] in groups for j in CONFIG['journals']))

    def test_candidate_normalises_openalex(self):
        c = cl.candidate(work(), self.journals)
        self.assertEqual(c['journal'], 'aer')
        self.assertEqual(c['doi'], '10.1257/aer.1')
        self.assertEqual(c['abstract'], 'We study wages.')
        self.assertEqual(c['authors'][0], {'n': 'Ada Lovelace', 'id': 'A1', 'orcid': '0000-1', 'inst': 'MIT', 'cc': 'US'})
        self.assertEqual(c['_pdfs'], ['https://arxiv.org/pdf/1'])
        self.assertIsNone(cl.candidate(work(primary_location={'source': {'id': 'S0'}}), self.journals))

    def test_nber_working_papers_get_their_own_pdf_and_kind(self):
        w = work(id='https://openalex.org/W9', doi='https://doi.org/10.3386/w36000', type='report',
                 primary_location={'source': {'id': 'https://openalex.org/S2809516038'}},
                 best_oa_location={'pdf_url': 'https://doi.org/10.3386/w36000'}, locations=[])
        c = cl.candidate(w, self.journals)
        self.assertEqual(c['journal'], 'nber')
        self.assertEqual(c['kind'], 'working')
        self.assertEqual(c['_pdfs'][0], 'https://www.nber.org/system/files/working_papers/w36000/w36000.pdf')

    def test_non_research_items_are_skipped(self):
        for title in ['Front Matter', 'Corrigendum to “X”', 'Book Reviews', 'Report of the Editor',
                      'The Making of Modern Europe. By Jane Doe. Cambridge University Press, 2024. Pp. 300.']:
            self.assertFalse(cl.is_research(cl.candidate(work(title=title), self.journals)), title)
        self.assertTrue(cl.is_research(cl.candidate(work(), self.journals)))
        self.assertFalse(cl.is_research(cl.candidate(work(authorships=[]), self.journals)))

    def test_conclusion_section_found_after_the_table_of_contents(self):
        body = 'Intro text. ' * 400
        text = f'Contents\n1 Introduction\n6 Conclusion\n{body}\n6 Conclusion\nWe find large effects of the policy. ' + 'It matters. ' * 40 + '\nReferences\nSmith (2020).'
        conc = cl.conclusion_section(text)
        self.assertTrue(conc.startswith('We find large effects'))
        self.assertNotIn('Smith (2020)', conc)
        self.assertEqual(cl.conclusion_section('no headings here ' * 300), '')

    def test_store_keeps_history_and_upgrades_in_place(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = cl.Store(Path(tmp))
            store.add({'id': 'W1', 'doi': 'd1', 'added': '2026-10-02', 'published': '2026-10-01', 'title': 'A', 'topics': ['x'], 'by': 'rules'})
            store.save({'at': '2026-10-02T05:00:00+00:00', 'added': 1})
            store = cl.Store(Path(tmp))
            store.add({'id': 'W2', 'doi': 'd2', 'added': '2026-11-12', 'published': '2025-11-01', 'title': 'B', 'topics': ['x', 'y'], 'by': 'rules', 'abstract': 'We study y.', 'url': 'https://doi.org/d2'})
            old = next(p for _, p in store.papers() if p['id'] == 'W1')
            old['by'] = 'claude-opus-5-5'
            store.touch(old)
            store.save({'at': '2026-11-12T05:00:00+00:00', 'added': 1})
            index = json.loads((Path(tmp) / 'index.json').read_text())
            self.assertEqual(index['total'], 2)
            self.assertEqual([s['year'] for s in index['shards']], ['2026', '2025'], 'one file per publication year')
            shard = json.loads((Path(tmp) / 'papers-2025.json').read_text())['papers'][0]
            self.assertNotIn('abstract', shard, 'abstracts have their own file')
            self.assertNotIn('url', shard, 'a DOI link is rebuilt from the DOI')
            self.assertEqual(json.loads((Path(tmp) / 'abstracts-2025.json').read_text()), {'W2': 'We study y.'})
            self.assertEqual(len(index['runs']), 2)
            reread = cl.Store(Path(tmp))
            self.assertEqual(reread.known()[0], {'W1', 'W2'})
            self.assertEqual(next(p for _, p in reread.papers() if p['id'] == 'W1')['by'], 'claude-opus-5-5')
            self.assertEqual(reread.top_topics(), ['x', 'y'])
            self.assertEqual(next(p for _, p in reread.papers() if p['id'] == 'W2')['abstract'], 'We study y.')
            self.assertEqual(reread.remove(lambda p: p['id'] != 'W1'), 1)

    def test_public_copy_has_only_model_summaries_and_no_abstracts(self):
        with tempfile.TemporaryDirectory() as tmp:
            private, public = Path(tmp) / 'store', Path(tmp) / 'public'
            public.mkdir()
            (public / 'abstracts-2024.json').write_text('{}')  # left over from before: removed
            store = cl.Store(private, public=public)
            store.add({'id': 'W1', 'added': '2026-11-12', 'published': '2026-10-01', 'title': 'A', 'abstract': 'We study x.',
                       'summary': 'We study x.', 'by': 'rules'})
            store.add({'id': 'W2', 'added': '2026-11-12', 'published': '2025-10-01', 'title': 'B', 'abstract': 'We study y.',
                       'summary': 'Y rises.', 'by': 'claude-sonnet-5-5'})
            store.save({'at': '2026-11-12T05:00:00+00:00', 'added': 2})
            self.assertEqual(sorted(f.name for f in public.iterdir()), ['index.json', 'papers-2025.json'])
            index = json.loads((public / 'index.json').read_text())
            self.assertEqual((index['total'], index['waiting'], index['shards']), (1, 1, [{'year': '2025', 'file': 'papers-2025.json', 'count': 1}]))
            self.assertEqual(len(index['runs']), 1)
            text = ''.join(f.read_text() for f in public.iterdir())
            self.assertNotIn('We study', text, 'no abstract and no rule text copied from one')
            self.assertEqual(json.loads((private / 'index.json').read_text())['total'], 2, 'the private store keeps everything')
            self.assertEqual(json.loads((private / 'abstracts-2026.json').read_text()), {'W1': 'We study x.'})

    def test_store_rewrites_month_files_by_year(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'papers-2026-11.json').write_text(json.dumps({'papers': [
                {'id': 'W1', 'added': '2026-11-12', 'published': '2024-03-01', 'abstract': 'A.'},
                {'id': 'W2', 'added': '2026-11-12', 'published': '2026-10-01', 'abstract': 'B.'}]}))
            (root / 'index.json').write_text(json.dumps({'version': 1, 'shards': [{'month': '2026-11', 'file': 'papers-2026-11.json', 'count': 2}], 'runs': [{'at': 'x'}]}))
            store = cl.Store(root)
            self.assertTrue(store.dirty)
            store.save()
            self.assertEqual(sorted(f.name for f in root.glob('*.json')), ['abstracts-2024.json', 'abstracts-2026.json', 'index.json', 'papers-2024.json', 'papers-2026.json'])
            self.assertEqual(json.loads((root / 'index.json').read_text())['runs'], [{'at': 'x'}])

    def test_trickling_download_hits_the_deadline(self):
        import socket
        import threading
        import time as clock
        server = socket.socket()
        server.bind(('127.0.0.1', 0))
        server.listen(1)

        def trickle():
            conn, _ = server.accept()
            conn.recv(1024)
            conn.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n')
            try:
                for _ in range(40):
                    conn.sendall(b'x')
                    clock.sleep(0.1)
            except OSError:
                pass
            conn.close()

        threading.Thread(target=trickle, daemon=True).start()
        started = clock.monotonic()
        with self.assertRaises(TimeoutError):
            cl.fetch(f'http://127.0.0.1:{server.getsockname()[1]}/slow.pdf', timeout=0.5, retries=1)
        self.assertLess(clock.monotonic() - started, 3)
        server.close()

    def test_excerpt_is_capped(self):
        self.assertTrue(cl.excerpt('word ' * 300).endswith('…'))
        self.assertEqual(len(cl.excerpt('word ' * 300).split()), 181)


NBER_PAGE = """<html><head>
<meta name="citation_title" content="Prices &amp; Wages: New Evidence" />
<meta name="citation_doi" content="10.3386/w36010" />
<meta name="citation_author" content="Ada Lovelace" />
<meta name="citation_author" content="José Núñez Jr." />
<meta name="citation_publication_date" content="2026/11/09" />
<meta name="citation_pdf_url" content="https://www.nber.org/system/files/working_papers/w36010/w36010.pdf" />
</head><body><div class="page-header__intro-inner">
      <p>
Abstract: We study wages and prices in 40 countries.
</p>
          </div></body></html>"""


def listed(number='w36010', month='2026-11', **over):
    row = {'number': number, 'title': 'Prices and Wages', 'month': month, 'authors': ['Ada Lovelace'],
           'abstract': 'We study wages and prices in'}
    row.update(over)
    return row


class Nber(unittest.TestCase):
    journal = next(j for j in CONFIG['journals'] if j['key'] == 'nber')

    def test_nber_is_read_from_its_own_site(self):
        self.assertEqual(self.journal.get('listing'), 'nber', 'OpenAlex misfiles and misdates NBER papers')

    def test_paper_page_gives_the_release_day_and_full_abstract(self):
        page = cl.parse_nber_page(NBER_PAGE)
        self.assertEqual(page['date'], '2026-11-09')
        self.assertEqual(page['title'], 'Prices & Wages: New Evidence')
        self.assertEqual(page['authors'], ['Ada Lovelace', 'José Núñez Jr.'])
        self.assertEqual(page['abstract'], 'We study wages and prices in 40 countries.')
        self.assertEqual(cl.parse_nber_page('<html>maintenance</html>')['date'], '')
        self.assertEqual(cl.listing_month('November 2026'), '2026-11')
        self.assertEqual(cl.listing_month(''), '')

    def test_authors_take_openalex_ids_when_surnames_match(self):
        rows = [{'n': 'Jose Nunez', 'id': 'A7', 'inst': 'UCM'}, {'n': 'A. Lovelace', 'id': 'A1'}]
        merged = cl.merge_authors(['Ada Lovelace', 'José Núñez Jr.', 'Grace Hopper'], rows)
        self.assertEqual([a.get('id') for a in merged], ['A1', 'A7', None])
        self.assertEqual(merged[2], {'n': 'Grace Hopper'})

    def test_candidate_before_openalex_has_the_paper(self):
        c = cl.nber_candidate(listed(), cl.parse_nber_page(NBER_PAGE), None, self.journal)
        self.assertEqual((c['id'], c['doi'], c['journal'], c['kind']), ('nber-w36010', '10.3386/w36010', 'nber', 'working'))
        self.assertEqual(c['published'], '2026-11-09')
        self.assertEqual(c['_pdfs'], ['https://www.nber.org/system/files/working_papers/w36010/w36010.pdf'])
        self.assertTrue(cl.is_research(c))
        bare = cl.nber_candidate(listed(), {}, None, self.journal)
        self.assertEqual(bare['published'], '2026-11-01', 'no page: the listing month')
        self.assertEqual((bare['abstract'], bare['_short']), ('', 'We study wages and prices in …'))

    def test_candidate_keeps_nber_date_over_a_misfiled_openalex_record(self):
        w = work(id='https://openalex.org/W77', doi='https://doi.org/10.3386/w36010', type='report', publication_date='2026-01-01',
                 primary_location={'source': {'id': 'https://openalex.org/S7407053623'}})
        c = cl.nber_candidate(listed(), cl.parse_nber_page(NBER_PAGE), w, self.journal)
        self.assertEqual((c['id'], c['journal'], c['published']), ('W77', 'nber', '2026-11-09'))
        self.assertEqual(c['authors'][0]['id'], 'A1')
        self.assertEqual(c['_pdfs'][0], 'https://www.nber.org/system/files/working_papers/w36010/w36010.pdf')

    def test_collect_adds_new_papers_and_gives_stored_ones_author_ids(self):
        stored = {'10.3386/w36001': {'id': 'nber-w36001', 'doi': '10.3386/w36001', 'authors': [{'n': 'Ada Lovelace'}]}}
        pages = {'w36010': cl.parse_nber_page(NBER_PAGE), 'w35900': {'date': '2026-08-31'}}
        later = work(id='https://openalex.org/W5', doi='https://doi.org/10.3386/w36001', type='report')
        with mock.patch.object(cl, 'nber_listing', return_value=[listed(), listed('w36001'), listed('w35900', '2026-09')]), \
                mock.patch.object(cl, 'nber_page', side_effect=lambda n: pages.get(n, {})), \
                mock.patch.object(cl, 'openalex_by_doi', return_value={'10.3386/w36001': later}) as lookup:
            cands, touched = cl.collect_nber(self.journal, '2026-09-13', set(), stored)
        self.assertEqual([c['id'] for c in cands], ['nber-w36010'], 'known papers skipped; papers released before `since` left out')
        self.assertEqual(sorted(lookup.call_args[0][0]), ['10.3386/w35900', '10.3386/w36001', '10.3386/w36010'])
        self.assertEqual(touched, [stored['10.3386/w36001']])
        self.assertEqual(stored['10.3386/w36001']['authors'][0]['id'], 'A1')

    def test_listing_failure_does_not_stop_the_run(self):
        with mock.patch.object(cl, 'nber_listing', side_effect=OSError('down')), self.assertLogs('radar', 'WARNING'):
            self.assertEqual(cl.collect_nber(self.journal, '2026-09-13', set(), {}), ([], []))

    def test_redate_sets_release_days_and_completes_short_abstracts(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = cl.Store(Path(tmp))
            store.add({'id': 'W1', 'doi': '10.3386/w36010', 'journal': 'nber', 'published': '2026-11-01', 'added': '2026-11-12', 'abstract': 'We'})
            store.add({'id': 'W2', 'doi': '10.1257/aer.1', 'journal': 'aer', 'published': '2026-11-01', 'added': '2026-11-12', 'abstract': 'We'})
            with mock.patch.object(cl, 'nber_page', return_value=cl.parse_nber_page(NBER_PAGE)) as page:
                self.assertEqual(cl.redate_nber(store), (1, 1))
            page.assert_called_once_with('w36010')
            rows = {p['id']: p for _, p in store.papers()}
            self.assertEqual(rows['W1']['published'], '2026-11-09')
            self.assertEqual(rows['W1']['abstract'], 'We study wages and prices in 40 countries.')
            self.assertEqual(rows['W2']['published'], '2026-11-01')


class Enrichment(unittest.TestCase):
    def test_rules_tag_from_text_and_journal(self):
        paper = {'title': 'Staggered Minimum Wage Increases and Employment', 'journal': 'jole', 'authors': []}
        abstract = ('We study how minimum wage increases affect employment in the United States between 1990 and 2015. '
                    'Using a staggered difference-in-differences design with administrative data, we find small effects.')
        r = enrich.rules(paper, abstract, '', TAX, ['Minimum wage', 'Employment'])
        self.assertEqual(r['fields'][0], 'labour')
        self.assertIn('did', r['methods'])
        self.assertIn('staggered-did', r['methods'])
        self.assertIn('admin', r['data'])
        self.assertIn('United States', r['geo'])
        self.assertEqual(r['period'], '1990–2015')
        self.assertTrue(r['q'].startswith('We study'))
        self.assertIn('staggered difference-in-differences', r['ident'])

    def test_rules_pick_a_contribution_sentence(self):
        abstract = ('We study railways in nineteenth-century France. We provide the first causal evidence that rail access raised literacy. '
                    'Using an instrumental variables strategy based on straight lines between cities, we find large effects.')
        extras = enrich.rule_extras(abstract, '', TAX)
        self.assertTrue(extras['contribution'].startswith('We provide the first causal evidence'))
        self.assertTrue(extras['ident'].startswith('Using an instrumental variables strategy'))

    def test_validate_drops_unknown_keys(self):
        out = enrich.validate({'summary': 'S.', 'contribution': '  Provides new  evidence. ', 'fields': ['labour', 'astrology'], 'methods': ['staggered-did', 'magic'],
                               'data_types': ['admin', 'tea leaves'], 'topics': ['Minimum Wage', 'x'], 'jel': ['J31', 'bad']}, TAX)
        self.assertEqual(out['fields'], ['labour'])
        self.assertEqual(out['contribution'], 'Provides new evidence.')
        self.assertEqual(out['methods'], ['did', 'staggered-did'])
        self.assertEqual(out['data'], ['admin'])
        self.assertEqual(out['topics'], ['minimum wage'])
        self.assertEqual(out['jel'], ['J31'])
        self.assertIn('contribution', enrich.output_schema(TAX)['required'])
        with self.assertRaises(enrich.EnrichError):
            enrich.validate({'summary': '', 'fields': ['labour']}, TAX)

    def test_schema_and_prompt_cover_the_taxonomy(self):
        schema = enrich.output_schema(TAX)
        self.assertEqual(schema['properties']['methods']['items']['enum'], TAX.method_keys)
        self.assertFalse(schema['additionalProperties'])
        prompt = enrich.system_prompt(TAX, ['minimum wage'])
        self.assertIn('staggered-did', prompt)
        self.assertIn('minimum wage', prompt)

    def test_parse_json_text_tolerates_fences(self):
        self.assertEqual(enrich.parse_json_text('```json\n{"a": 1}\n```'), {'a': 1})
        with self.assertRaises(enrich.EnrichError):
            enrich.parse_json_text('no json')

    def test_no_key_means_rules(self):
        self.assertIsNone(enrich.choose_provider(TAX, env={}))

    def test_enrich_all_falls_back_per_paper_and_stops_on_quota(self):
        class Fake:
            name, workers = 'fake-model', 1

            def __init__(self):
                self.calls = 0

            def enrich(self, message):
                self.calls += 1
                if 'Title: bad' in message:
                    raise enrich.EnrichError('nonsense answer')
                if 'Title: quota' in message:
                    raise enrich.QuotaReached('daily allowance')
                return enrich.validate({'question': 'Q?', 'summary': 'S.', 'fields': ['macro'], 'methods': ['iv'], 'topics': []}, TAX)

        def item(title):
            record = {'id': title, 'title': title, 'journal': 'aer', 'authors': [], 'published': '2026-11-01'}
            return (record, 'We study inflation.', '', ['Inflation'], '')

        items = [item('good'), item('bad'), item('quota'), item('after')]
        stats = {'llm': 0, 'llm_failed': 0, 'rules': 0}
        fake = Fake()
        cl.enrich_all(items, fake, TAX, stats)
        by = {r['id']: r['by'] for r, *_ in items}
        self.assertEqual(by, {'good': 'fake-model', 'bad': 'rules', 'quota': 'rules', 'after': 'rules'})
        self.assertEqual(fake.calls, 3, 'no call after the allowance ran out')
        self.assertEqual(items[0][0]['topics'], ['inflation'], 'keywords fill empty topics')
        self.assertEqual(items[0][0]['text'], ['abstract'])
        self.assertEqual(stats, {'llm': 1, 'llm_failed': 1, 'rules': 3})

    def test_past_the_time_budget_upgrades_wait_and_new_papers_get_rules(self):
        import time as clock

        class Never:
            name, workers = 'fake-model', 1

            def enrich(self, message):
                raise AssertionError('no model call after the deadline')

        old = {'id': 'old', 'title': 'Old', 'journal': 'aer', 'authors': [], 'by': 'rules', 'summary': 'kept'}
        new = {'id': 'new', 'title': 'New', 'journal': 'aer', 'authors': [], 'published': '2026-11-01'}
        stats = {'llm': 0, 'llm_failed': 0, 'rules': 0}
        past = clock.monotonic() - 1
        cl.enrich_all([(old, 'We study x.', '', [], '')], Never(), TAX, stats, past, keep_if_late=True)
        self.assertEqual(old['summary'], 'kept')
        self.assertNotIn('at', old)
        cl.enrich_all([(new, 'We study inflation.', '', [], '')], Never(), TAX, stats, past)
        self.assertEqual(new['by'], 'rules')
        self.assertEqual(stats, {'llm': 0, 'llm_failed': 0, 'rules': 1, 'deferred': 1})



class OpenRouter(unittest.TestCase):
    """The free-model path, with OpenRouter's API replaced by canned answers."""
    MODELS = [
        {'id': 'google/gemma-4-31b-it:free', 'pricing': {'prompt': '0', 'completion': '0'}, 'context_length': 262144, 'supported_parameters': ['response_format', 'reasoning']},
        {'id': 'nvidia/nemotron-3.5-super-vl:free', 'pricing': {'prompt': '0', 'completion': '0'}, 'context_length': 1000000, 'supported_parameters': ['structured_outputs', 'response_format', 'reasoning']},
        {'id': 'baidu/ernie-5.5-flash-preview:free', 'pricing': {'prompt': '0', 'completion': '0'}, 'context_length': 1024000, 'supported_parameters': ['structured_outputs', 'response_format']},
        {'id': 'liquid/lfm-3-1.7b:free', 'pricing': {'prompt': '0', 'completion': '0'}, 'supported_parameters': ['structured_outputs']},
        {'id': 'cohere/north-mini-code:free', 'pricing': {'prompt': '0', 'completion': '0'}, 'supported_parameters': []},
        {'id': 'openrouter/free', 'pricing': {'prompt': '0', 'completion': '0'}, 'supported_parameters': ['structured_outputs']},
        {'id': 'openai/gpt-6', 'pricing': {'prompt': '0.00001', 'completion': '0.00003'}, 'supported_parameters': ['structured_outputs']},
    ]
    GOOD = {'question': 'Q?', 'contribution': 'C.', 'summary': 'S.', 'fields': ['labour'], 'methods': ['iv']}

    def run_with(self, answers):
        import io
        import urllib.error
        from unittest import mock
        sent = []

        def fake_urlopen(req, timeout=0):
            sent.append(json.loads(req.data))
            answer = answers.pop(0)
            if isinstance(answer, tuple):  # (status, body) -> HTTP error
                raise urllib.error.HTTPError(req.full_url, answer[0], 'error', {}, io.BytesIO(json.dumps(answer[1]).encode()))
            return io.BytesIO(json.dumps(answer).encode())

        for patch in (mock.patch.object(enrich.urllib.request, 'urlopen', fake_urlopen), mock.patch.object(enrich.time, 'sleep', lambda s: None)):
            patch.start()
            self.addCleanup(patch.stop)  # stays active until the test ends, so no real request is ever sent
        provider = enrich.OpenRouterEnricher(TAX, key='sk-or-test', models=self.MODELS)
        provider._pace = lambda: None
        return provider, sent, (lambda: provider.enrich('Title: T'))

    @staticmethod
    def reply(model, content, finish='stop'):
        return {'model': model, 'choices': [{'message': {'content': content}, 'finish_reason': finish}]}

    def test_free_models_are_ranked_for_dependable_json(self):
        ranked = [m['id'] for m in enrich.rank_free_models(self.MODELS)]
        self.assertEqual(ranked, ['nvidia/nemotron-3.5-super-vl:free', 'baidu/ernie-5.5-flash-preview:free', 'google/gemma-4-31b-it:free'],
                         'enforced-JSON models first; tiny, code, router and paid models left out')

    def test_answer_records_the_model_that_replied(self):
        provider, sent, call = self.run_with([self.reply('nvidia/nemotron-3.5-super-vl:free', json.dumps(self.GOOD))])
        out = call()
        self.assertEqual(out['by'], 'openrouter:nvidia/nemotron-3.5-super-vl:free')
        body = sent[0]
        self.assertEqual(body['model'], 'nvidia/nemotron-3.5-super-vl:free')
        self.assertEqual(body['response_format']['type'], 'json_schema')
        self.assertEqual(body['reasoning'], {'effort': 'low'})
        self.assertEqual(body['provider'], {'require_parameters': True})
        self.assertIn('contribution', body['messages'][0]['content'])

    def test_a_bad_answer_moves_to_the_next_model(self):
        provider, sent, call = self.run_with([self.reply('x', '', finish='length'), self.reply('google/gemma-4-31b-it:free', json.dumps(self.GOOD))])
        out = call()
        self.assertEqual([b['model'] for b in sent], ['nvidia/nemotron-3.5-super-vl:free', 'baidu/ernie-5.5-flash-preview:free'])
        self.assertEqual(out['by'], 'openrouter:google/gemma-4-31b-it:free')
        self.assertEqual(sent[1]['response_format']['type'], 'json_schema')
        self.assertNotIn('reasoning', sent[1], 'only sent to models that accept it')

    def test_failures_are_explained_and_repeat_offenders_dropped(self):
        bad = self.reply('x', 'Sure! Here is a summary of the paper', finish='stop')
        provider, sent, call = self.run_with([bad] * 3 + [bad] * 3)
        with self.assertRaisesRegex(enrich.EnrichError, r"finish=stop, \d+ chars: 'Sure! Here is a summary"):
            call()
        with self.assertRaises(enrich.EnrichError):
            call()
        self.assertEqual(provider.dropped, {'nvidia/nemotron-3.5-super-vl:free', 'baidu/ernie-5.5-flash-preview:free', 'google/gemma-4-31b-it:free'})

    def test_many_failed_papers_in_a_row_stop_the_run(self):
        bad = self.reply('x', 'no json')
        provider, sent, call = self.run_with([bad] * 30)
        for _ in range(4):
            with self.assertRaises(enrich.EnrichError):
                call()
        with self.assertRaises(enrich.QuotaReached):
            call()

    def test_placeholder_text_is_never_kept(self):
        junk = dict(self.GOOD, contribution='placeholder', conclusion='N/A', data_detail='...')
        provider, sent, call = self.run_with([self.reply('m', json.dumps(junk))])
        out = call()
        self.assertEqual((out['contribution'], out['conclusion'], out['dataDetail']), ('', '', ''))
        self.assertEqual(out['summary'], 'S.')
        self.assertIn('nemotron-3.5-super-vl:free 1 ok/0 rejected', provider.report())
        with self.assertRaises(enrich.EnrichError):
            enrich.validate(dict(self.GOOD, summary='placeholder'), TAX)
        for remark in ('Abstract unavailable: the paper studies x.', '(Abstract not available) The paper studies x.', 'Based on the title alone, the paper studies x.'):
            self.assertEqual(enrich.answer(remark, 200), 'The paper studies x.', remark)

    def test_daily_limit_stops_the_provider(self):
        per_day = {'error': {'code': 429, 'message': 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day'}}
        for answer in [(429, per_day), per_day]:  # as an HTTP error, and inside a 200
            _, _, call = self.run_with([answer])
            with self.assertRaises(enrich.QuotaReached):
                call()

    def test_privacy_block_is_explained(self):
        _, _, call = self.run_with([(404, {'error': {'message': 'No endpoints found matching your data policy'}})])
        with self.assertRaisesRegex(enrich.QuotaReached, 'settings/privacy'):
            call()


if __name__ == '__main__':
    unittest.main()


class Batch(unittest.TestCase):
    """Summaries written by a Claude session: export a batch, import the answers."""

    def test_export_then_import_checks_answers_against_the_taxonomy(self):
        import radar_batch as rb
        with tempfile.TemporaryDirectory() as tmp:
            store = cl.Store(Path(tmp))
            store.add({'id': 'W1', 'journal': 'aer', 'title': 'Minimum Wages', 'published': '2026-10-01', 'added': '2026-11-10',
                       'authors': [{'n': 'Ada Lovelace'}], 'abstract': 'We study wages.', 'by': 'rules', 'topics': ['wages']})
            store.add({'id': 'W2', 'journal': 'qje', 'title': 'Old', 'published': '2021-01-01', 'added': '2026-11-01',
                       'authors': [{'n': 'X'}], 'abstract': 'Old paper.', 'by': 'claude-sonnet-5-5'})
            store.save()
            target = rb.Target(tmp)
            text = rb.export(target, TAX, 10, {'W1': 'We conclude that wages rose.'})
            self.assertEqual(text.count('### '), 1, 'papers with a model summary are not exported')
            self.assertIn('### W1\nJournal: American Economic Review', text)
            self.assertIn('Conclusion excerpt', text)
            good = {'question': 'Do minimum wages cut jobs?', 'contribution': 'C.', 'summary': 'S.', 'conclusion': '', 'fields': ['labour', 'astrology'],
                    'methods': ['did'], 'identification': 'State borders.', 'data_types': ['admin'], 'data_detail': '', 'topics': [],
                    'geography': ['United States'], 'period': '', 'jel': ['J38']}
            done, rejected, unknown = rb.import_answers(target, TAX, {'W1': good, 'W2': {'summary': ''}, 'W9': good}, 'claude-sonnet-5-5', {})
            self.assertEqual((done, list(rejected), unknown), (['W1'], ['W2'], ['W9']))
            again = {p['id']: p for _, p in cl.Store(Path(tmp)).papers()}
            self.assertEqual((again['W1']['by'], again['W1']['fields'], again['W1']['topics']), ('claude-sonnet-5-5', ['labour'], ['wages']))
            self.assertEqual(rb.Target(tmp).pending(), [])
            self.assertIn('HOW TO ANSWER', rb.instructions(TAX, ['wages']))

    def test_dry_run_compares_a_model_on_papers_already_summarised(self):
        import radar_batch as rb
        with tempfile.TemporaryDirectory() as tmp:
            store = cl.Store(Path(tmp))
            store.add({'id': 'W2', 'journal': 'qje', 'title': 'Old', 'published': '2021-01-01', 'added': '2026-11-01',
                       'authors': [{'n': 'X'}], 'abstract': 'Old paper.', 'by': 'claude-sonnet-5-5', 'summary': 'Kept.'})
            store.save()
            target = rb.Target(tmp)
            self.assertEqual(rb.export(target, TAX, 10, {}, ids=['W2', 'W404']).count('### '), 1)
            answer = {'question': 'Q?', 'contribution': 'C.', 'summary': 'New.', 'conclusion': '', 'fields': ['labour'], 'methods': ['theory'],
                      'identification': 'Theory: x', 'data_types': [], 'data_detail': '', 'topics': ['x'], 'geography': [], 'period': '', 'jel': []}
            checked, rejected, _ = rb.import_answers(target, TAX, {'W2': answer}, 'claude-haiku-5-5', {}, dry_run=True)
            self.assertEqual((checked['W2']['summary'], rejected), ('New.', {}))
            again = {p['id']: p for _, p in cl.Store(Path(tmp)).papers()}
            self.assertEqual((again['W2']['summary'], again['W2']['by']), ('Kept.', 'claude-sonnet-5-5'))


class Flags(unittest.TestCase):
    """Readers' flags from the Google Form's responses sheet."""

    def test_flags_are_listed_then_fixed_or_dismissed(self):
        import radar_flags as rf
        with tempfile.TemporaryDirectory() as tmp:
            store = cl.Store(Path(tmp))
            store.add({'id': 'W1', 'journal': 'aer', 'title': 'Minimum Wages', 'published': '2026-10-01', 'added': '2026-11-10',
                       'authors': [{'n': 'A'}], 'abstract': 'We study wages.', 'by': 'claude-sonnet-5-5', 'summary': 'Wages rose.'})
            store.save()
            sheet = Path(tmp) / 'flags.csv'
            sheet.write_text('Timestamp,Paper id,Paper title,What is inaccurate?,Your note\n'
                             '13/11/2026 10:00:00,W1,Minimum Wages,Summary,"It says wages rose, they fell."\n'
                             '13/11/2026 11:00:00,W9,Gone,Tags,x\n'
                             '13/11/2026 12:00:00,,,,empty row\n')
            flags = rf.parse(sheet.read_text())
            self.assertEqual([(f['paper'], f['what']) for f in flags], [('W1', 'Summary'), ('W9', 'Tags')])
            with unittest.mock.patch.object(rf, 'DECISIONS', Path(tmp) / 'decisions.json'):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    rf.main(['list', '--csv', str(sheet), '--store-dir', tmp, '--data-dir', tmp + '/public'])
                self.assertIn('they fell', out.getvalue())
                self.assertIn('Summary: Wages rose.', out.getvalue())
                rf.main(['resolve', flags[0]['flag'], '--fixed', '--reason', 'Re-summarised', '--csv', str(sheet), '--store-dir', tmp, '--data-dir', tmp + '/public'])
                rf.main(['resolve', flags[1]['flag'], '--dismissed', '--csv', str(sheet), '--store-dir', tmp, '--data-dir', tmp + '/public'])
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    rf.main(['list', '--csv', str(sheet), '--store-dir', tmp, '--data-dir', tmp + '/public'])
                self.assertTrue(out.getvalue().startswith('0 open flags (2 in all)'))
            again = {p['id']: p for _, p in cl.Store(Path(tmp)).papers()}
            self.assertTrue(again['W1']['corrected'])


class Routine(unittest.TestCase):
    """Scheduled runs: the catch-up stays within its weekly share; worktrees share one cache."""

    def test_catchup_budget_stops_at_its_weekly_share(self):
        import radar_routine as rr
        with tempfile.TemporaryDirectory() as tmp, unittest.mock.patch.object(rr, 'LEDGER', Path(tmp) / 'ledger.json'), \
                contextlib.redirect_stdout(io.StringIO()):
            week, nxt = '2026-11-21T07:00:00Z', '2026-11-28T07:00:00Z'
            self.assertEqual(rr.budget(40, 10, week), 0)
            for _ in range(30):
                rr.record(40, 40, week)  # the meter did not move: each run still counts RUN_FLOOR
            self.assertEqual(rr.budget(40, 10, week), 0, 'a 31st run ends at 24.8%')
            rr.record(40, 40, week)
            self.assertEqual(rr.budget(40, 10, week), 2, 'a 32nd would pass 25%')
            self.assertEqual(rr.budget(40, 10, nxt), 0, 'a new week starts from zero')
            rr.record(50, 54, nxt)
            self.assertEqual(json.loads((Path(tmp) / 'ledger.json').read_text())[nxt[:13]]['used'], 4.0)
            self.assertEqual(rr.budget(96, 10, nxt), 2, 'never near the weekly limit')
            self.assertEqual(rr.budget(50, 80, nxt), 2, 'leaves a busy 5-hour window alone')

    def test_one_week_key_for_the_same_reset(self):
        import radar_routine as rr
        self.assertEqual(rr.week_key('2026-11-21T06:59:59.766Z'), rr.week_key('2026-11-21T07:00:00Z'))
        self.assertNotEqual(rr.week_key('2026-11-21T06:59:59Z'), rr.week_key('2026-11-28T06:59:59Z'))

    def test_worktrees_share_the_main_checkout_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            main, wt = Path(tmp) / 'repo', Path(tmp) / 'routine'
            (main / '.git' / 'worktrees' / 'routine').mkdir(parents=True)
            wt.mkdir()
            (wt / '.git').write_text(f"gitdir: {main / '.git' / 'worktrees' / 'routine'}\n")
            self.assertEqual(cl.main_checkout(wt), main)
            self.assertEqual(cl.main_checkout(main), main)
