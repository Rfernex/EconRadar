"""EconRadar focus areas: follow a whole literature, not only new papers in the radar's journals.

    python3 tools/collect_focus.py                 # update every area in radar/focus.json
    python3 tools/collect_focus.py --budget 40     # at most 40 OpenAlex searches this run
    python3 tools/collect_focus.py --dry-run       # fetch and report, write nothing

Each area in radar/focus.json has strands, and each strand one or more OpenAlex searches
(quoted phrases in titles, or in titles and abstracts) over papers published since the
area's start date, in any journal, working-paper series or book. A search is first read
in full (a "pass"); after that each run asks only for papers published in the last 120
days, and every 30 days a new pass refreshes citation counts and picks up papers OpenAlex
indexed late. A search costs ten ordinary requests on OpenAlex's free tier (about 100
searches a day per IP address without OPENALEX_API_KEY), so a pass that runs out of
budget resumes where it stopped on the next run.

Papers are stored privately in .radar-cache/store (git-ignored): focus-<area>.json, their
abstracts in focus-<area>-abstracts.json and the OpenAlex ids of all their references in
focus-<area>-refs.json. The papers file lists, for each paper, the references that are
themselves in the area: the citation map is drawn from those. The app's copy,
radar/data/focus-<area>.json, holds only the papers a model has summarised, with no abstract. Tags
come from the radar's keyword rules (fields, methods, data, places) plus the area's
strands and outcomes; with ANTHROPIC_API_KEY, Claude summarises the newest papers first.
"""
import argparse
import json
import logging
import os
import re
import sys
import time
import urllib.error
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_literature as cl  # noqa: E402
import radar_enrich as enrich  # noqa: E402

FOCUS = cl.APP / 'focus.json'
SELECT = ('id,doi,title,publication_date,type,primary_location,best_oa_location,locations,authorships,'
          'abstract_inverted_index,keywords,cited_by_count,counts_by_year,referenced_works,primary_topic')
TYPES = 'article|preprint|report|book-chapter|book|review'
RECENT_DAYS = 120
REFRESH_DAYS = 30
KEEP = ('q', 'contribution', 'summary', 'ident', 'fields', 'methods', 'data', 'dataDetail', 'topics', 'geo', 'period', 'jel')
FIELD_SHORT = {'Economics, Econometrics and Finance': 'Economics', 'Social Sciences': 'Social sciences',
               'Business, Management and Accounting': 'Business', 'Arts and Humanities': 'Humanities',
               'Medicine': 'Health', 'Nursing': 'Health', 'Health Professions': 'Health', 'Psychology': 'Psychology',
               'Environmental Science': 'Environment', 'Decision Sciences': 'Decision sciences'}

log = logging.getLogger('radar')


# Replication files and data deposits (often on Zenodo) are not papers.
DATASET = re.compile(r'^(?:data(?:set)?|code|replication)(?:\s+(?:and|&)\s+code|\s+(?:files|package|data|materials))?\s*(?:for|:|-|–)', re.I)


class OutOfBudget(Exception):
    pass


class BadSearch(Exception):
    """OpenAlex rejected a search (a typo in focus.json): skip it, keep the others."""


class Searcher:
    """OpenAlex searches with a hard cap per run; a refusal (429) ends the run's searching."""

    def __init__(self, budget, key=''):
        self.budget, self.key, self.used = budget, key, 0

    def page(self, query, since, page):
        if self.used >= self.budget:
            raise OutOfBudget()
        params = {'filter': f"{query['in']}.search:{query['q']},from_publication_date:{since},type:{TYPES},has_abstract:true,language:en",
                  'per_page': '200', 'page': str(page), 'sort': 'publication_date:desc', 'select': SELECT}
        if self.key:
            params['api_key'] = self.key
        self.used += 1
        try:
            data = cl.get_json(f'{cl.OPENALEX}?{urlencode(params)}', retries=3, timeout=60)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                log.warning('OpenAlex: daily search allowance used up; the rest waits for the next run')
                self.budget = self.used
                raise OutOfBudget() from e
            if e.code == 400:
                raise BadSearch(e.read()[:300].decode('utf-8', 'replace')) from e
            raise
        return data.get('results') or [], (data.get('meta') or {}).get('count', 0)


# ---------------------------------------------------------------------------
# Records
# ---------------------------------------------------------------------------
def tolerant(pattern):
    """A focus.json pattern where a space also matches a hyphen ("cash-transfer programmes")."""
    return re.compile(pattern.replace(' ', r'[\s-]'), re.I)


class Area:
    def __init__(self, spec, tax):
        self.spec, self.tax, self.key = spec, tax, spec['key']
        self.strands = spec['strands']
        self.strand_re = []
        self.title_only = set()
        for s in self.strands:
            title_only = all(q['in'] == 'title' for q in s['queries'])
            if title_only:
                self.title_only.add(s['key'])
            self.strand_re.append((s['key'], tolerant(s['match']), title_only, tolerant(s['exclude']) if s.get('exclude') else None))
        self.outcome_re = [(o['key'], re.compile(o['match'], re.I)) for o in spec.get('outcomes', [])]

    def strands_of(self, title, abstract):
        text = f'{title}. {abstract}'
        return [k for k, rx, title_only, ex in self.strand_re
                if rx.search(title if title_only else text) and not (ex and ex.search(text))]

    def excluded(self, key, title, abstract):
        ex = next((x[3] for x in self.strand_re if x[0] == key), None)
        return bool(ex and ex.search(f'{title}. {abstract}'))

    def outcomes_of(self, title, abstract):
        text = f'{title}. {abstract}'
        return [k for k, rx in self.outcome_re if rx.search(text)][:5]


def kind_of(work):
    t = work.get('type')
    return {'report': 'working', 'preprint': 'working', 'book-chapter': 'chapter', 'book': 'book', 'review': 'review'}.get(t, 'article')


def citations_by_year(work, today):
    rows = {r.get('year'): r.get('cited_by_count', 0) for r in work.get('counts_by_year') or [] if isinstance(r.get('year'), int)}
    return [rows.get(y, 0) for y in range(today.year - 3, today.year + 1)]


def record_from(work, area, today):
    """A focus record, or None when the hit does not actually mention the area's terms."""
    c = cl.candidate(work, {}, {'key': '', 'group': 'focus'})
    abstract = cl.excerpt(c['abstract'], 150) if c['abstract'] else ''
    strands = area.strands_of(c['title'], c['abstract'])
    if not strands or not cl.is_research(c) or DATASET.search(c['title']):
        return None
    source = (work.get('primary_location') or {}).get('source') or {}
    topic = work.get('primary_topic') or {}
    field = ((topic.get('field') or {}).get('display_name')) or ''
    pdf = next((u for u in c['_pdfs'] if u), '')
    record = {
        'id': c['id'], 'doi': c['doi'], 'title': c['title'], 'venue': cl.clean(source.get('display_name')),
        'kind': kind_of(work), 'published': c['published'],
        'authors': [{k: a[k] for k in ('n', 'id', 'inst') if a.get(k)} for a in c['authors'][:12]],
        'abstract': abstract, 'url': c['url'], 'pdf': pdf,
        'strands': strands, 'disc': FIELD_SHORT.get(field, field or 'Other'),
        'sub': cl.clean((topic.get('subfield') or {}).get('display_name')),
        'core': bool(source.get('is_core')),
        'cited': int(work.get('cited_by_count') or 0), 'cy': citations_by_year(work, today),
        'outcomes': area.outcomes_of(c['title'], c['abstract']),
    }
    if not pdf:
        record.pop('pdf')
    refs = [r.split('/')[-1] for r in work.get('referenced_works') or []]
    return record, refs, c['_keywords']


def title_key(p):
    words = re.findall(r'[a-z0-9]+', cl.unicodedata.normalize('NFKD', p.get('title', '')).encode('ascii', 'ignore').decode().lower())
    first = cl.surname(p['authors'][0]['n']) if p.get('authors') else ''
    return f"{' '.join(words)}|{first}" if len(words) >= 6 and first else ''


def tag_with_rules(record, keywords, tax):
    out = enrich.rules({'title': record['title'], 'journal': ''}, record['abstract'], '', tax, keywords)
    for k in KEEP:
        if k in out and k != 'summary':  # the abstract is shown in full; a rules summary would repeat it
            record[k] = out[k]
    record['by'] = 'rules'


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------
class AreaStore:
    def __init__(self, root, key, public=None):
        self.public = public and public / f'focus-{key}.json'
        self.path = root / f'focus-{key}.json'
        self.refs_path, self.abstracts_path = root / f'focus-{key}-refs.json', root / f'focus-{key}-abstracts.json'
        data = json.loads(self.path.read_text()) if self.path.exists() else {}
        self.state = data.get('searches', {})
        self.alias = data.get('aliases', {})  # duplicate record id -> the id kept
        self.papers = {p['id']: p for p in data.get('papers', [])}
        abstracts = json.loads(self.abstracts_path.read_text()) if self.abstracts_path.exists() else {}
        for pid, p in self.papers.items():
            p.setdefault('abstract', abstracts.get(pid, ''))
            p.setdefault('url', f"https://doi.org/{p['doi']}" if p.get('doi') else '')
        self.refs = json.loads(self.refs_path.read_text()) if self.refs_path.exists() else {}
        self.by_doi = {p['doi']: p['id'] for p in self.papers.values() if p.get('doi')}
        self.added = self.updated = 0

    def put(self, record, refs, keywords, tax, today):
        kept = self.alias.get(record['id'])
        if kept in self.papers:  # a second record of a paper already merged: only its counts matter
            known = self.papers[kept]
            known['cited'] = max(known.get('cited', 0), record['cited'])
            known['cy'] = [max(a, b) for a, b in zip(known.get('cy') or [0] * 4, record['cy'])]
            self.refs[kept] = list(dict.fromkeys(self.refs.get(kept, []) + refs))
            self.updated += 1
            return False
        known = self.papers.get(record['id']) or self.papers.get(self.by_doi.get(record['doi'], ''))
        if known:
            for k in ('title', 'venue', 'kind', 'published', 'cited', 'cy', 'disc', 'sub', 'outcomes', 'url', 'core'):
                known[k] = record[k]
            known['strands'] = [s for s in dict.fromkeys(known.get('strands', []) + record['strands'])]
            if record.get('pdf'):
                known['pdf'] = record['pdf']
            if len(record['abstract']) > len(known.get('abstract', '')):
                known['abstract'] = record['abstract']
            if sum('id' in a for a in record['authors']) > sum('id' in a for a in known.get('authors', [])):
                known['authors'] = record['authors']
            self.refs[known['id']] = refs or self.refs.get(known['id'], [])
            self.updated += 1
            return False
        tag_with_rules(record, keywords, tax)
        record['added'] = today.isoformat()
        self.papers[record['id']] = record
        if record['doi']:
            self.by_doi[record['doi']] = record['id']
        self.refs[record['id']] = refs
        self.added += 1
        return True

    def prune(self, area):
        """Strands follow focus.json: a paper is re-tagged with today's patterns, and one that
        no longer matches any strand leaves the area (edit a pattern, and the next run tidies up)."""
        gone = 0
        known = {s['key'] for s in area.strands}
        for pid in list(self.papers):
            p = self.papers[pid]
            strands = area.strands_of(p.get('title', ''), p.get('abstract', ''))
            # Only the title is certain evidence: a strand found in the full abstract may sit
            # past the stored excerpt, so it stays unless the strand itself was removed.
            strands += [k for k in p.get('strands', []) if k in known and k not in area.title_only and k not in strands
                        and not area.excluded(k, p.get('title', ''), p.get('abstract', ''))]
            if DATASET.search(p.get('title', '')):
                strands = []
            strands.sort(key=[s['key'] for s in area.strands].index)
            if strands:
                p['strands'] = strands
                p['outcomes'] = area.outcomes_of(p.get('title', ''), p.get('abstract', ''))
            else:
                del self.papers[pid]
                self.refs.pop(pid, None)
                gone += 1
        self.by_doi = {p['doi']: p['id'] for p in self.papers.values() if p.get('doi')}
        return gone

    def merge_duplicates(self):
        """One record per paper: the same title (six words or more) by the same first author is
        one paper, often a working paper and its journal version, or a preprint posted twice.
        The journal version is kept; citations to the others count for it."""
        rank = {'article': 0, 'review': 1, 'chapter': 2, 'book': 3, 'working': 4}
        groups = {}
        for p in self.papers.values():
            key = title_key(p)
            if key:
                groups.setdefault(key, []).append(p)
        merged = 0
        for rows in groups.values():
            if len(rows) < 2:
                continue
            rows.sort(key=lambda p: (rank.get(p.get('kind'), 5), -p.get('cited', 0), p.get('published', '')))
            keep = rows[0]
            for dup in rows[1:]:
                keep['cited'] = max(keep.get('cited', 0), dup.get('cited', 0))
                keep['cy'] = [max(a, b) for a, b in zip(keep.get('cy') or [0] * 4, dup.get('cy') or [0] * 4)]
                keep['strands'] = list(dict.fromkeys(keep.get('strands', []) + dup.get('strands', [])))
                if not keep.get('pdf') and dup.get('pdf'):
                    keep['pdf'] = dup['pdf']
                if len(dup.get('abstract', '')) > len(keep.get('abstract', '')):
                    keep['abstract'] = dup['abstract']
                if dup.get('by', 'rules') != 'rules' and keep.get('by', 'rules') == 'rules':
                    keep.update({k: dup[k] for k in KEEP if k in dup}, by=dup['by'])
                self.refs[keep['id']] = list(dict.fromkeys(self.refs.get(keep['id'], []) + self.refs.pop(dup['id'], [])))
                self.alias[dup['id']] = keep['id']
                for old, target in list(self.alias.items()):
                    if target == dup['id']:
                        self.alias[old] = keep['id']
                del self.papers[dup['id']]
                merged += 1
        self.by_doi = {p['doi']: p['id'] for p in self.papers.values() if p.get('doi')}
        return merged

    def link(self):
        """Each paper's references that are themselves in the area (a reference to a merged
        duplicate points to the record kept)."""
        ids = set(self.papers)
        for pid, p in self.papers.items():
            cites = (self.alias.get(r, r) for r in self.refs.get(pid, []))
            p['cites'] = [r for r in dict.fromkeys(cites) if r in ids and r != pid]

    def save(self, area, today):
        """Three private files: the papers without their abstracts, the abstracts and every paper's
        references. With `public`, also the app's copy: the summarised papers only, citing each other."""
        self.merged = self.merge_duplicates()
        self.link()
        rows = sorted(self.papers.values(), key=lambda p: (p.get('published', ''), p['id']), reverse=True)
        slim = lambda p: {k: v for k, v in p.items() if k != 'abstract' and v not in ('', [], None) and v is not False
                          and not (k == 'url' and v == f"https://doi.org/{p.get('doi')}")}
        # Compact JSON, one paper per line: small files, and readable diffs in git.
        dump = lambda obj: json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
        meta = {'version': 1, 'key': area['key'], 'title': area['title'], 'since': area['since'], 'updated': today.isoformat()}
        write = lambda path, head, papers: path.write_text(dump(head)[:-1] + ',"papers":[\n' + ',\n'.join(dump(p) for p in papers) + '\n]}\n')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        write(self.path, {**meta, 'searches': self.state, 'total': len(rows), 'aliases': self.alias}, [slim(p) for p in rows])
        lines = lambda pairs: '{\n' + ',\n'.join(f'{dump(k)}:{dump(v)}' for k, v in pairs) + '\n}\n'
        self.abstracts_path.write_text(lines((p['id'], p['abstract']) for p in rows if p.get('abstract')))
        self.refs_path.write_text(lines((k, self.refs[k]) for k in sorted(self.refs) if k in self.papers))
        if self.public:
            shown = [slim(p) for p in rows if cl.summarised(p)]
            ids = {p['id'] for p in shown}
            for p in shown:
                if 'cites' in p:
                    p['cites'] = [c for c in p['cites'] if c in ids]
            self.public.parent.mkdir(parents=True, exist_ok=True)
            write(self.public, {**meta, 'total': len(shown)}, [p for p in shown])


# ---------------------------------------------------------------------------
# One run
# ---------------------------------------------------------------------------
def searches(area):
    for strand in area.strands:
        for i, query in enumerate(strand['queries']):
            yield f"{strand['key']}#{i}", strand, query


def read(searcher, store, area, query, since, today, st=None):
    """Read one search page by page. With `st`, the page reached is kept there, so a pass cut
    short by the budget resumes on the next run instead of paying for its first pages again."""
    page = (st or {}).get('next') or 1
    while True:
        results, total = searcher.page(query, since, page)
        for w in results:
            got = record_from(w, area, today)
            if got:
                store.put(*got, area.tax, today)
        if len(results) < 200 or page * 200 >= min(total, 10_000):
            if st is not None:
                st.pop('next', None)
            return
        page += 1
        if st is not None:
            st['next'] = page


def update_area(spec, tax, store, searcher, today):
    area = Area(spec, tax)
    recent_since = max(spec['since'], (today - timedelta(days=RECENT_DAYS)).isoformat())
    stale_before = (today - timedelta(days=REFRESH_DAYS)).isoformat()
    plan = list(searches(area))
    for sid, _, _ in plan:
        store.state.setdefault(sid, {})
    try:
        # 1. New papers, for every search already read in full once.
        for sid, _, query in plan:
            st = store.state[sid]
            if st.get('full') and not st.get('next') and st.get('recent') != today.isoformat():
                try:
                    read(searcher, store, area, query, recent_since, today)
                    st['recent'] = today.isoformat()
                except BadSearch as e:
                    log.warning('Focus %s: search %s rejected by OpenAlex: %s', spec['key'], sid, e)
        # 2. Full passes: unfinished ones first (in strand order), then the stalest refresh.
        due = [x for x in plan if not store.state[x[0]].get('full') or store.state[x[0]].get('next')]
        stale = sorted((x for x in plan if x not in due and store.state[x[0]]['full'] <= stale_before),
                       key=lambda x: store.state[x[0]]['full'])
        for sid, _, query in due + stale:
            st = store.state[sid]
            st['next'] = st.get('next') or 1
            try:
                read(searcher, store, area, query, spec['since'], today, st)
            except BadSearch as e:
                log.warning('Focus %s: search %s rejected by OpenAlex: %s', spec['key'], sid, e)
                continue
            st['full'] = st['recent'] = today.isoformat()
            log.info('Focus %s: search %s read in full', spec['key'], sid)
    except OutOfBudget:
        pass
    except Exception as e:  # a network failure keeps what was gathered
        log.warning('Focus %s: search interrupted (%s); progress kept', spec['key'], e)
    return area


def model_pass(store, area, tax, provider, budget, today, deadline):
    if not provider or budget <= 0:
        return 0
    todo = sorted((p for p in store.papers.values() if p.get('by') == 'rules' and p.get('abstract')),
                  key=lambda p: p.get('published', ''), reverse=True)[:budget]
    done = 0
    for p in todo:
        if time.monotonic() > deadline:
            break
        try:
            out = provider.enrich(enrich.user_message(p, {'name': p.get('venue') or 'unknown venue'}, p['abstract'], ''))
        except enrich.QuotaReached as e:
            log.warning('%s', e)
            break
        except enrich.EnrichError as e:
            log.warning('Focus: summary failed for %s (%s)', p['id'], e)
            continue
        p.update({k: out[k] for k in KEEP if k in out})
        p['by'], p['at'] = out.get('by') or provider.name, today.isoformat()
        done += 1
    return done


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    key = os.environ.get('OPENALEX_API_KEY', '')
    p.add_argument('--budget', type=int, default=60 if key else 30, help='OpenAlex searches this run (each returns up to 200 papers)')
    p.add_argument('--model-budget', type=int, default=None, help='papers to summarise with Claude this run (default 40 with a key)')
    p.add_argument('--time-budget', type=float, default=15, help='minutes after which no new summaries start')
    p.add_argument('--area', help='only this area')
    p.add_argument('--dry-run', action='store_true')
    p.add_argument('--store-dir', default=str(cl.STORE), help=argparse.SUPPRESS)
    p.add_argument('--data-dir', default=str(cl.DATA), help=argparse.SUPPRESS)
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format='%(message)s')
    today = date.today()
    deadline = time.monotonic() + args.time_budget * 60
    tax = enrich.Taxonomy(json.loads(cl.CONFIG.read_text()))
    focus = json.loads(FOCUS.read_text())
    searcher = Searcher(args.budget, key)
    provider = enrich.choose_provider(tax)
    # Free OpenRouter models are kept for the radar's own new papers.
    provider = provider if isinstance(provider, enrich.ClaudeEnricher) else None
    model_budget = args.model_budget if args.model_budget is not None else (40 if provider else 0)
    report = []
    for spec in focus['areas']:
        if args.area and spec['key'] != args.area:
            continue
        store = AreaStore(Path(args.store_dir), spec['key'], public=Path(args.data_dir))
        area = update_area(spec, tax, store, searcher, today)
        summarised = model_pass(store, area, tax, provider, model_budget, today, deadline)
        unfinished = [sid for sid, st in store.state.items() if not st.get('full') or st.get('next')]
        report.append({'area': spec['key'], 'papers': len(store.papers), 'added': store.added, 'updated': store.updated,
                       'summarised': summarised, 'unfinished': unfinished})
        log.info('Focus %s: %d papers (%d new, %d refreshed, %d summarised); searches used %d/%d%s',
                 spec['key'], len(store.papers), store.added, store.updated, summarised, searcher.used, searcher.budget,
                 f"; still to read in full: {', '.join(unfinished)}" if unfinished else '')
        pruned = store.prune(area)
        if pruned:
            log.info('Focus %s: %d papers no longer match focus.json and were removed', spec['key'], pruned)
        if not args.dry_run:
            store.save(spec, today)
    return report


if __name__ == '__main__':
    main()
