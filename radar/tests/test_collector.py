"""Collector checks that need no network. Run: python3 -m unittest discover -s radar/tests"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

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
            store.add({'id': 'W2', 'doi': 'd2', 'added': '2026-11-12', 'published': '2026-11-01', 'title': 'B', 'topics': ['x', 'y'], 'by': 'rules'})
            old = next(p for _, p in store.papers() if p['id'] == 'W1')
            old['by'] = 'claude-opus-5-5'
            store.touch(old)
            store.save({'at': '2026-11-12T05:00:00+00:00', 'added': 1})
            index = json.loads((Path(tmp) / 'index.json').read_text())
            self.assertEqual(index['total'], 2)
            self.assertEqual([s['month'] for s in index['shards']], ['2026-11', '2026-10'])
            self.assertEqual(len(index['runs']), 2)
            reread = cl.Store(Path(tmp))
            self.assertEqual(reread.known()[0], {'W1', 'W2'})
            self.assertEqual(next(p for _, p in reread.papers() if p['id'] == 'W1')['by'], 'claude-opus-5-5')
            self.assertEqual(reread.top_topics(), ['x', 'y'])

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
