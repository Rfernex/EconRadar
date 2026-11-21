"""EconRadar collector: new articles from the journals in radar/config.json.

Runs from the repository root (the weekly routine in tools/WEEKLY.md, or by hand):

    python3 tools/collect_literature.py                    # new papers in the lookback window
    python3 tools/collect_literature.py --since 2026-05-01 # backfill from a date
    python3 tools/collect_literature.py --reenrich 200     # upgrade rule-tagged papers
    python3 tools/collect_literature.py --dry-run --limit 5
    python3 tools/collect_literature.py --redate-nber      # stored NBER papers: release day from NBER

Sources: OpenAlex finds the journal articles (authors with stable ids,
institutions, abstracts). NBER working papers come from NBER's own listing and paper
pages (the release day, full abstract and authors; OpenAlex adds author ids when it
has the paper). Crossref and Semantic Scholar fill missing abstracts and open-access
links; legal open-access PDFs (arXiv, repositories, open publisher copies) supply
the conclusion section. Hosts that refuse automated downloads are skipped, never
worked around. Summaries and tags come from tools/radar_enrich.py.

History is kept: papers are only ever added or upgraded. The full store is private, in
.radar-cache/store (git-ignored, never published): papers-YYYY.json by publication year,
abstracts-YYYY.json (excerpts of at most 180 words) and index.json (the files and the run
log). Each save also writes the app's copy to radar/data: only the papers a model has
summarised, with no abstract and no sentence copied from one. PDF text is never stored,
only what the summary says.
"""
import argparse
import concurrent.futures as futures
import html
import io
import json
import logging
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, urlencode, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import radar_enrich as enrich  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'radar'
DATA = APP / 'data'
CONFIG = APP / 'config.json'
UA = 'EconRadar/1.0 (scholarly digest; python-urllib)'
OPENALEX = 'https://api.openalex.org/works'
SELECT = ('id,doi,title,publication_date,type,primary_location,locations,best_oa_location,'
          'authorships,abstract_inverted_index,biblio,keywords,primary_topic')
# Publisher hosts that answer scripts with a bot-protection page (checked Nov 2026).
REFUSING_HOSTS = {'onlinelibrary.wiley.com', 'academic.oup.com', 'www.sciencedirect.com', 'papers.ssrn.com',
                  'www.tandfonline.com', 'journals.sagepub.com', 'www.jstor.org', 'doi.org', 'dx.doi.org',
                  'www.journals.uchicago.edu', 'www.aeaweb.org', 'pubs.aeaweb.org'}
NOT_RESEARCH = re.compile(
    r'^\s*(front matter|back matter|issue information|editorial board|editorial\b|editors?\W? (introduction|note)|'
    r'erratum|errata|corrigendum|correction|retraction|expression of concern|announcement|report of the|'
    r'minutes of|index to|masthead|acknowledg|(list of )?referees|reviewers|(table of )?contents|forthcoming|'
    r'books? received|book reviews?|notes on contributors|in memoriam|obituary|call for papers|preface|foreword|'
    r'introduction to the (special|symposium)|review of periodical literature|list of publications)', re.I)
BOOK_REVIEW = re.compile(r'\.\s+(?:By|Edited by)\s+[A-Z]|\bPp\.\s*[xivlXIVL\d]|Press,\s*(?:1[89]|20)\d\d')
CONCLUSION_HEAD = re.compile(
    r'(?im)^[ \t]*(?:\d{1,2}\.?|[IVX]{1,5}\.?|[A-H]\.)?[ \t]*'
    r'(conclusions?|concluding (?:remarks|comments|discussion|thoughts)|discussion and conclusions?|'
    r'summary and conclusions?|conclusions? and (?:discussion|implications|policy implications)|final (?:remarks|thoughts)|discussion)'
    r'[ \t]*\.?[ \t]*$')
SECTION_END = re.compile(
    r'(?im)^[ \t]*(?:[A-Z]\.?[ \t]+)?(references|bibliography|works cited|appendix|appendices|acknowledg(?:e)?ments?|'
    r'data availability|online appendix|supplementary (?:material|information)|methods|notes|funding)\b')
PDF_ABSTRACT = re.compile(
    r'(?is)\babstract\b[\s.:—-]*(.{200,3000}?)(?=\n\s*(?:jel\b|keywords?|key words|\d?\.?\s*introduction|i\.?\s+introduction)\b)')

log = logging.getLogger('radar')


def now_utc():
    return datetime.now(timezone.utc)


def clean(value):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', str(value or '')))).strip()


def person_name(value):
    """An author's name without the affiliation letters some sources append ("Jonathan Gruber A B")."""
    words = clean(value).split(' ')
    while len(words) > 2 and re.fullmatch(r'[A-Z]', words[-1]):
        words.pop()
    return ' '.join(words)


LEADING_LABEL = re.compile(r'^\s*(?:abstract|summary)\b[\s.:\u2014-]*', re.I)


def strip_label(text):
    return LEADING_LABEL.sub('', enrich.respace(text))


def excerpt(text, words=180):
    parts = clean(text).split()
    return ' '.join(parts[:words]) + (' …' if len(parts) > words else '')


def fetch(url, *, data=None, headers=None, timeout=40, retries=3, max_bytes=40_000_000):
    head = {'User-Agent': UA, 'Accept': 'application/json'}
    head.update(headers or {})
    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, headers=head)
        try:
            # `timeout` bounds each socket read; the deadline bounds the whole download,
            # so a server trickling bytes cannot stall the run.
            deadline = time.monotonic() + timeout * 2
            with urllib.request.urlopen(req, timeout=timeout) as r:
                chunks, size = [], 0
                while True:
                    chunk = r.read1(256 * 1024)  # returns what has arrived, so the deadline is checked often
                    if not chunk:
                        break
                    chunks.append(chunk)
                    size += len(chunk)
                    if size > max_bytes:
                        raise ValueError('response too large')
                    if time.monotonic() > deadline:
                        raise TimeoutError(f'download exceeded {timeout * 2}s')
                return b''.join(chunks)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                wait = e.headers.get('Retry-After', '')
                time.sleep(min(float(wait) if wait.isdigit() else 3 * 2 ** attempt, 30))
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt < retries - 1:
                time.sleep(2 * 2 ** attempt)
                continue
            raise


def get_json(url, **kw):
    return json.loads(fetch(url, **kw))


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------
def openalex_works(source_ids, since, key=''):
    """All articles from these sources published on or after `since`.

    With a key, cursor paging; without one OpenAlex only allows numbered pages
    (up to 10,000 results), so the order is pinned to keep pages stable."""
    works = []
    # Five journals per query: without a key OpenAlex pages stop at 10,000 results, which a
    # long backfill over all journals at once would exceed.
    for i in range(0, len(source_ids), 5):
        chunk = source_ids[i:i + 5]
        cursor, page_no = '*', 1
        while cursor:
            params = {'filter': f'primary_location.source.id:{"|".join(chunk)},from_publication_date:{since},type:article|review|report|preprint',
                      'per_page': '200', 'select': SELECT, 'sort': 'publication_date:desc'}
            if key:
                params['api_key'] = key
                params['cursor'] = cursor
            else:
                params['page'] = str(page_no)
            try:
                page = get_json(f'{OPENALEX}?{urlencode(params)}', retries=4)
            except urllib.error.HTTPError as e:
                detail = e.read()[:400].decode('utf-8', 'replace')
                raise SystemExit(f'OpenAlex refused the request ({e.code}): {detail}\n'
                                 'Without OPENALEX_API_KEY the free budget is shared per IP address; '
                                 'a free key from https://openalex.org/settings/api gives this collector its own.') from e
            results = page.get('results') or []
            works += results
            if key:
                cursor = (page.get('meta') or {}).get('next_cursor') if results else None
            else:
                page_no += 1
                cursor = '*' if len(results) == 200 and page_no <= 50 else None
    return works


def restore_abstract(index):
    if not isinstance(index, dict):
        return ''
    words = {}
    for word, places in index.items():
        for p in places or []:
            if isinstance(p, int) and 0 <= p < 5000:
                words[p] = word
    return clean(' '.join(words[i] for i in sorted(words)))


def candidate(work, journals, journal=None):
    source = (((work.get('primary_location') or {}).get('source') or {}).get('id') or '').split('/')[-1]
    journal = journal or journals.get(source)
    if not journal:
        return None
    doi = (work.get('doi') or '').replace('https://doi.org/', '').lower()
    authors = []
    for a in work.get('authorships') or []:
        person = a.get('author') or {}
        name = person_name(person.get('display_name'))
        if not name:
            continue
        inst = next((clean(i.get('display_name')) for i in a.get('institutions') or [] if i.get('display_name')), '')
        row = {'n': name, 'id': (person.get('id') or '').split('/')[-1], 'orcid': (person.get('orcid') or '').split('/')[-1],
               'inst': inst, 'cc': (a.get('countries') or [''])[0]}
        authors.append({k: v for k, v in row.items() if v})
    pdfs = []
    for loc in [work.get('best_oa_location')] + list(work.get('locations') or []):
        url = (loc or {}).get('pdf_url')
        if url and url not in pdfs:
            pdfs.append(url)
    # A series' own PDF address (e.g. NBER's) goes first: it is open and readable by scripts.
    template = journal.get('pdfTemplate')
    if template and doi:
        pdfs.insert(0, template.replace('{id}', doi.split('/')[-1]))
    keywords = [clean(k.get('display_name')) for k in sorted(work.get('keywords') or [], key=lambda k: -(k.get('score') or 0))]
    biblio = work.get('biblio') or {}
    return {
        'id': work['id'].split('/')[-1],
        'doi': doi,
        'title': clean(work.get('title')),
        'journal': journal['key'],
        'published': work.get('publication_date') or '',
        'authors': authors[:30],
        'abstract': strip_label(restore_abstract(work.get('abstract_inverted_index'))),
        'url': f'https://doi.org/{doi}' if doi else work['id'],
        'kind': 'working' if journal.get('kind') == 'working' else 'review' if work.get('type') == 'review' else 'article',
        '_pdfs': pdfs,
        '_keywords': keywords[:5],
        '_pages': (biblio.get('first_page'), biblio.get('last_page')),
        '_group': journal.get('group'),
    }


def is_research(c):
    title = c['title']
    if len(title) < 4 or not c['authors']:
        return False
    if NOT_RESEARCH.search(title) or BOOK_REVIEW.search(title):
        return False
    return True


# ---------------------------------------------------------------------------
# NBER working papers, from NBER's own site
# ---------------------------------------------------------------------------
# OpenAlex files some NBER papers under other sources and dates them to a month (sometimes
# the wrong one), so NBER is read directly: the listing finds every new paper and each paper
# page gives the day NBER released it (a batch every Monday), the full abstract and the
# authors. OpenAlex, when it already has the paper, adds author ids and institutions.
NBER = 'https://www.nber.org'
NBER_LISTING = f'{NBER}/api/v1/working_page_listing/contentType/working_paper/_/_/search'
MONTHS = {m: i for i, m in enumerate(('january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
                                      'september', 'october', 'november', 'december'), 1)}
NAME_SUFFIX = {'jr', 'sr', 'ii', 'iii', 'iv'}


def listing_month(label):
    m = re.match(r'\s*([A-Za-z]+)\s+(\d{4})', label or '')
    month = MONTHS.get(m.group(1).lower()) if m else None
    return f'{m.group(2)}-{month:02d}' if month else ''


def nber_listing(since, max_pages=200):
    """NBER working papers, newest first, back to the month of `since` (the listing gives months only)."""
    floor, rows = since[:7], []
    for page in range(1, max_pages + 1):
        query = urlencode({'page': page, 'perPage': 100, 'sortBy': 'public_date'})
        results = get_json(f'{NBER_LISTING}?{query}', retries=3).get('results') or []
        recent = 0
        for r in results:
            number = re.search(r'/papers/(w\d+)$', r.get('url') or '')
            month = listing_month(r.get('displaydate'))
            if not number or (month and month < floor):
                continue
            recent += 1
            rows.append({'number': number.group(1), 'title': clean(r.get('title')), 'month': month,
                         'authors': [a for a in (clean(x) for x in r.get('authors') or []) if a],
                         'abstract': clean(r.get('abstract'))})
        if len(results) < 100 or not recent:
            break
    return rows


def parse_nber_page(page):
    def meta(name):
        return [clean(v) for v in re.findall(rf'<meta\s+name="{name}"\s+content="([^"]*)"', page)]
    day = re.match(r'(\d{4})/(\d{2})/(\d{2})$', (meta('citation_publication_date') or [''])[0])
    intro = re.search(r'class="page-header__intro-inner">(.*?)</div>', page, re.S)
    return {'date': '-'.join(day.groups()) if day else '',
            'title': (meta('citation_title') or [''])[0],
            'authors': [a for a in meta('citation_author') if a],
            'abstract': strip_label(clean(intro.group(1))) if intro else '',
            'pdf': (meta('citation_pdf_url') or [''])[0]}


def nber_page(number):
    """Release day, title, authors, abstract and PDF address from an NBER paper page ({} if unreadable)."""
    try:
        body = fetch(f'{NBER}/papers/{number}', headers={'Accept': 'text/html'}, retries=2, timeout=30, max_bytes=3_000_000)
    except Exception as e:
        log.warning('NBER page %s unreadable (%s)', number, e)
        return {}
    return parse_nber_page(body.decode('utf-8', 'replace'))


def openalex_by_doi(dois, key=''):
    """OpenAlex records for these DOIs, keyed by DOI; DOIs OpenAlex does not have yet are absent."""
    found = {}
    for i in range(0, len(dois), 50):
        params = {'filter': 'doi:' + '|'.join(dois[i:i + 50]), 'per_page': '50', 'select': SELECT}
        if key:
            params['api_key'] = key
        try:
            page = get_json(f'{OPENALEX}?{urlencode(params)}', retries=3)
        except Exception as e:
            log.warning('OpenAlex DOI lookup failed (%s); those NBER authors stay without ids for now', e)
            break
        for w in page.get('results') or []:
            doi = (w.get('doi') or '').replace('https://doi.org/', '').lower()
            found.setdefault(doi, w)
    return found


def surname(name):
    plain = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode().lower()
    parts = [w for w in re.findall(r'[a-z]+', plain) if w not in NAME_SUFFIX]
    return parts[-1] if parts else ''


def merge_authors(names, rows):
    """NBER's author list, each name replaced by OpenAlex's record (id, institution) when the surnames match."""
    pool, out = list(rows), []
    for name in names:
        match = next((r for r in pool if surname(r.get('n', '')) == surname(name)), None)
        if match:
            pool.remove(match)
        out.append(match or {'n': name})
    return out


def nber_candidate(entry, page, work, journal):
    number = entry['number']
    doi = f'10.3386/{number}'
    base = candidate(work, {}, journal) if work else {}
    pdfs = list(base.get('_pdfs') or [])
    for url in (page.get('pdf'), journal['pdfTemplate'].replace('{id}', number) if journal.get('pdfTemplate') else ''):
        if url and url not in pdfs:
            pdfs.insert(0, url)
    month_start = f"{entry['month']}-01" if entry.get('month') else ''
    return {
        'id': base.get('id') or f'nber-{number}',
        'doi': doi,
        'title': page.get('title') or entry['title'] or base.get('title', ''),
        'journal': journal['key'],
        'published': page.get('date') or month_start or base.get('published', ''),
        'authors': merge_authors(page.get('authors') or entry['authors'] or [a['n'] for a in base.get('authors', [])],
                                 base.get('authors', []))[:30],
        'abstract': page.get('abstract') or base.get('abstract', ''),
        'url': f'https://doi.org/{doi}',
        'kind': 'working',
        '_pdfs': pdfs,
        '_keywords': base.get('_keywords', []),
        '_pages': (None, None),
        '_group': journal.get('group'),
        '_short': f"{entry['abstract']} …" if entry.get('abstract') else '',
    }


def collect_nber(journal, since, known_ids, stored_by_doi, key=''):
    """New NBER papers released since `since`, and stored NBER papers that gained OpenAlex author ids."""
    try:
        listing = nber_listing(since)
    except Exception as e:
        log.warning('NBER listing unavailable (%s); its new papers wait for the next run', e)
        return [], []
    new = [e for e in listing if f"10.3386/{e['number']}" not in stored_by_doi]
    with futures.ThreadPoolExecutor(max_workers=3) as pool:
        pages = list(pool.map(lambda e: nber_page(e['number']), new))
    # Papers stored before OpenAlex had them: their authors get ids once it does.
    lacking = [p for p in (stored_by_doi.get(f"10.3386/{e['number']}") for e in listing)
               if p and any(not a.get('id') for a in p.get('authors', []))]
    works = openalex_by_doi([f"10.3386/{e['number']}" for e in new] + [p['doi'] for p in lacking], key)
    touched = []
    for p in lacking:
        if p['doi'] in works:
            merged = merge_authors([a['n'] for a in p['authors']], candidate(works[p['doi']], {}, journal)['authors'])
            if sum('id' in a for a in merged) > sum('id' in a for a in p['authors']):
                p['authors'] = merged
                touched.append(p)
    cands = []
    for e, page in zip(new, pages):
        c = nber_candidate(e, page, works.get(f"10.3386/{e['number']}"), journal)
        if c['id'] in known_ids or (c['published'] and c['published'] < since):
            continue
        cands.append(c)
    log.info('NBER: %d papers listed since %s; %d new (%d dated from their page, %d already in OpenAlex); '
             'author ids added to %d stored papers', len(listing), since[:7], len(cands),
             sum(bool(p.get('date')) for p in pages), sum(f"10.3386/{e['number']}" in works for e in new), len(touched))
    return cands, touched


def redate_nber(store):
    """Give stored NBER papers the day NBER released them (and the full abstract when theirs is cut short)."""
    rows = [p for _, p in store.papers() if p.get('journal') == 'nber' and str(p.get('doi', '')).startswith('10.3386/')]
    with futures.ThreadPoolExecutor(max_workers=3) as pool:
        pages = list(pool.map(lambda p: nber_page(p['doi'].split('/')[-1]), rows))
    dated = longer = 0
    for p, page in zip(rows, pages):
        changed = False
        if page.get('date') and page['date'] != p.get('published'):
            p['published'] = page['date']
            dated += 1
            changed = True
        if page.get('abstract') and len(p.get('abstract') or '') < 300 and len(page['abstract']) > len(p.get('abstract') or ''):
            p['abstract'] = excerpt(page['abstract'])
            longer += 1
            changed = True
        if changed:
            store.touch(p)
    log.info('NBER: %d stored papers checked, %d pages read; %d redated, %d abstracts completed',
             len(rows), sum(bool(x) for x in pages), dated, longer)
    return dated, longer


# ---------------------------------------------------------------------------
# Missing abstracts and open-access copies
# ---------------------------------------------------------------------------
def crossref_abstract(doi):
    try:
        message = get_json(f'https://api.crossref.org/works/{quote(doi)}', retries=2, timeout=25)['message']
        return strip_label(message.get('abstract') or '')
    except Exception:
        return ''


def fill_from_crossref(cands):
    # Elsevier (10.1016) and NBER (10.3386) do not deposit abstracts with Crossref; skip those lookups.
    todo = [c for c in cands if not c['abstract'] and c['doi'] and not c['doi'].startswith(('10.1016/', '10.3386/'))]
    with futures.ThreadPoolExecutor(max_workers=4) as pool:
        for c, text in zip(todo, pool.map(lambda c: crossref_abstract(c['doi']), todo)):
            if len(text) > 120:
                c['abstract'] = text
    return len(todo)


def fill_from_semantic_scholar(cands):
    # Without a key Semantic Scholar shares a small pool across all callers: small batches, paced,
    # and a refused batch is skipped rather than ending the step.
    todo = [c for c in cands if c['doi']]
    found = failed = 0
    for i in range(0, len(todo), 100):
        chunk = todo[i:i + 100]
        body = json.dumps({'ids': [f"DOI:{c['doi']}" for c in chunk]}).encode()
        if i:
            time.sleep(3)
        try:
            rows = get_json('https://api.semanticscholar.org/graph/v1/paper/batch?fields=abstract,openAccessPdf,tldr',
                            data=body, headers={'Content-Type': 'application/json'}, retries=4, timeout=60)
        except Exception as e:
            failed += 1
            if failed >= 3:
                log.warning('Semantic Scholar keeps refusing (%s); continuing without it', e)
                return found
            continue
        for c, row in zip(chunk, rows):
            if not row:
                continue
            if not c['abstract'] and len(clean(row.get('abstract'))) > 120:
                c['abstract'] = strip_label(row['abstract'])
                found += 1
            pdf = (row.get('openAccessPdf') or {}).get('url')
            if pdf and pdf not in c['_pdfs']:
                c['_pdfs'].append(pdf)
            c['_tldr'] = clean((row.get('tldr') or {}).get('text'))
    return found


def pdf_text(body):
    try:
        import pypdf
    except ImportError:
        return ''
    try:
        reader = pypdf.PdfReader(io.BytesIO(body))
        pages = reader.pages
        total = min(len(pages), 90)
        parts = []
        # Text extraction is the slow step. Stop once past the conclusion and into the
        # references: appendices, often half the file, are never needed.
        for i in range(total):
            parts.append(pages[i].extract_text() or '')
            if i >= 3 and i >= total * 0.3 and i % 2:
                text = '\n'.join(parts)
                heads = [m for m in CONCLUSION_HEAD.finditer(text) if m.start() > len(text) * 0.3]
                if heads and SECTION_END.search(text, heads[-1].end()):
                    return text
        return '\n'.join(parts)
    except Exception:
        return ''


def conclusion_section(text):
    """The paper's own conclusion section, if its heading can be found."""
    n = len(text)
    conclusions, discussions = [], []
    for m in CONCLUSION_HEAD.finditer(text):
        if m.start() < n * 0.3:  # headings this early are a table of contents or a roadmap
            continue
        (discussions if m.group(1).lower() == 'discussion' else conclusions).append(m)
    head = (conclusions or discussions or [None])[-1]
    if not head:
        return ''
    rest = text[head.end():]
    end = SECTION_END.search(rest)
    body = rest[:end.start() if end else 9000][:9000]
    body = re.sub(r'-\n(?=[a-z])', '', body)  # re-join hyphenated line breaks
    body = re.sub(r'\s+', ' ', body).strip()
    return body if len(body) >= 300 else ''


def abstract_from_pdf(text):
    m = PDF_ABSTRACT.search(text[:15000])
    return clean(re.sub(r'-\n(?=[a-z])', '', m.group(1))) if m else ''


def read_open_copy(urls, parser=None):
    """(url, conclusion, abstract) from the first open-access PDF that can be read.

    `parser` is an optional process pool: text extraction is CPU-bound, so parsing in
    separate processes lets several PDFs be read at once, and a malformed file that
    makes pypdf spin is abandoned after two minutes."""
    tried = 0
    for url in urls:
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https') or (parsed.hostname or '') in REFUSING_HOSTS:
            continue
        tried += 1
        if tried > 3:
            break
        try:
            body = fetch(url, headers={'Accept': 'application/pdf'}, timeout=45, retries=1, max_bytes=30_000_000)
        except Exception:
            continue
        if not body.startswith(b'%PDF'):
            continue
        try:
            text = parser.submit(pdf_text, body).result(timeout=120) if parser else pdf_text(body)
        except Exception:
            continue
        if len(text) < 2000:
            continue
        return url, conclusion_section(text), abstract_from_pdf(text)
    return '', '', ''


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------
# Conclusions read from open-access copies wait here, on this machine only (never
# published), until a Claude session summarises the paper (tools/radar_batch.py).
def main_checkout(root):
    """The repository's main folder, also when running from a linked git worktree (whose .git is
    a file pointing to <main>/.git/worktrees/<name>), so every checkout shares one cache."""
    git = root / '.git'
    if git.is_file():
        line = git.read_text().strip()
        if line.startswith('gitdir:'):
            target = Path(line.split(':', 1)[1].strip())
            if target.parent.name == 'worktrees':
                return target.parents[2]
    return root


CACHE = main_checkout(ROOT) / '.radar-cache'
CONCLUSIONS = CACHE / 'conclusions.json'
# The full store (every paper, its abstract, the keyword-rule records) stays on this machine.
# radar/data receives only what the app may show: papers a model has summarised, without abstracts.
STORE = CACHE / 'store'


def load_conclusions():
    return json.loads(CONCLUSIONS.read_text()) if CONCLUSIONS.exists() else {}


def save_conclusions(new):
    new = {k: v[:4000] for k, v in (new or {}).items() if v}
    if not new:
        return
    CACHE.mkdir(exist_ok=True)
    data = load_conclusions()
    data.update(new)
    CONCLUSIONS.write_text(json.dumps(data, ensure_ascii=False))


def year_of(p):
    return (p.get('published') or p.get('added') or '0000')[:4]


def dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))


def slim(p):
    """A paper without its abstract (kept in its own file), empty fields, or a link that the DOI
    already gives."""
    return {k: v for k, v in p.items() if k != 'abstract' and v not in ('', [], None)
            and not (k == 'url' and p.get('doi') and v == f"https://doi.org/{p['doi']}")}


def summarised(p):
    """True when a model wrote the paper's summary. Keyword-rule records reuse sentences of the
    abstract, so they are never published."""
    return p.get('by', 'rules') != 'rules'


def write_years(root, rows, abstracts):
    """papers-YYYY.json (one paper per line, newest first), with abstracts-YYYY.json when
    `abstracts`; files of years no longer present are deleted. Returns the index shards."""
    root.mkdir(parents=True, exist_ok=True)
    years = {}
    for p in rows:
        years.setdefault(year_of(p), []).append(p)
    shards = []
    for year, papers in sorted(years.items(), reverse=True):
        papers.sort(key=lambda p: (p.get('published', ''), p.get('added', ''), p['id']), reverse=True)
        head = dump({'version': 2, 'year': year})
        write_text(root / f'papers-{year}.json', head[:-1] + ',"papers":[\n' + ',\n'.join(dump(slim(p)) for p in papers) + '\n]}\n')
        shard = {'year': year, 'file': f'papers-{year}.json', 'count': len(papers)}
        if abstracts:
            pairs = [(p['id'], p['abstract']) for p in papers if p.get('abstract')]
            write_text(root / f'abstracts-{year}.json', '{\n' + ',\n'.join(f'{dump(k)}:{dump(v)}' for k, v in pairs) + '\n}\n')
            shard['abstracts'] = f'abstracts-{year}.json'
        shards.append(shard)
    keep = {s['file'] for s in shards} | {s.get('abstracts') for s in shards}
    for path in list(root.glob('papers-*.json')) + list(root.glob('abstracts-*.json')):
        if path.name not in keep:
            path.unlink()
    return shards


class Store:
    """Every paper, by publication year, in `root` (the private store, .radar-cache/store):
    papers-YYYY.json (one paper per line, without its abstract), abstracts-YYYY.json and
    index.json (the years and the run log). With `public` (radar/data), each save also writes
    the app's copy there: only the papers a model has summarised, and no abstracts.
    Older month files (papers-YYYY-MM.json, abstracts inline) are read and rewritten."""

    def __init__(self, root, public=None):
        self.root, self.public = root, public
        self.index_path = root / 'index.json'
        self.index = json.loads(self.index_path.read_text()) if self.index_path.exists() else {
            'version': 2, 'shards': [], 'runs': []}
        self.rows, self.legacy = {}, []
        for shard in self.index.get('shards', []):
            path = root / shard['file']
            if not path.exists():
                continue
            papers = json.loads(path.read_text()).get('papers', [])
            if 'month' in shard:
                self.legacy.append(path)
            side = root / shard['abstracts'] if shard.get('abstracts') else None
            abstracts = json.loads(side.read_text()) if side and side.exists() else {}
            for p in papers:
                p.setdefault('abstract', abstracts.get(p['id'], ''))
                for a in p.get('authors') or []:  # names stored before person_name existed
                    a['n'] = person_name(a.get('n'))
                if p.get('doi'):
                    p.setdefault('url', f"https://doi.org/{p['doi']}")
                self.rows[p['id']] = p
        self.dirty = bool(self.legacy)

    def papers(self):
        for p in self.rows.values():
            yield year_of(p), p

    def known(self):
        return set(self.rows), {p['doi'] for p in self.rows.values() if p.get('doi')}

    def top_topics(self, n=150):
        counts = {}
        for _, p in self.papers():
            for t in p.get('topics', []):
                counts[t] = counts.get(t, 0) + 1
        return [t for t, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:n]]

    def add(self, record):
        self.rows[record['id']] = record
        self.dirty = True

    def touch(self, record):
        self.dirty = True

    def remove(self, keep):
        """Drop the papers for which keep(paper) is false (e.g. a journal taken off the list)."""
        gone = [pid for pid, p in self.rows.items() if not keep(p)]
        for pid in gone:
            del self.rows[pid]
        self.dirty = self.dirty or bool(gone)
        return len(gone)

    def save(self, run=None):
        for path in self.legacy:
            path.unlink(missing_ok=True)
        shards = write_years(self.root, self.rows.values(), abstracts=True)
        runs = (([run] if run else []) + self.index.get('runs', []))[:300]
        self.index = {'version': 2, 'generatedAt': run['at'] if run else self.index.get('generatedAt', now_utc().isoformat(timespec='seconds')),
                      'total': len(self.rows), 'shards': shards, 'runs': runs}
        write_json(self.index_path, self.index)
        if self.public:
            self.publish()
        self.legacy, self.dirty = [], False

    def publish(self):
        shown = write_years(self.public, [p for p in self.rows.values() if summarised(p)], abstracts=False)
        total = sum(s['count'] for s in shown)
        write_json(self.public / 'index.json', {**self.index, 'total': total, 'waiting': len(self.rows) - total, 'shards': shown})


def write_text(path, text):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(text)
    tmp.replace(path)


def write_json(path, payload):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + '\n')
    tmp.replace(path)


# ---------------------------------------------------------------------------
# Enrichment
# ---------------------------------------------------------------------------
def stored(c):
    record = {k: v for k, v in c.items() if not k.startswith('_')}
    record['abstract'] = excerpt(record.get('abstract', ''))
    if not record.get('pdf'):
        record.pop('pdf', None)
    return record


def enrich_all(items, provider, tax, stats, deadline=None, keep_if_late=False):
    """items: list of (record, abstract, conclusion, keywords, tldr). Fills record in place.

    Past `deadline` (time.monotonic()) no more model calls start: new papers get rule tags,
    and with keep_if_late (upgrades of old papers) records are left as they were for the
    next run. This keeps a long catch-up inside the workflow's time limit."""
    def rule_fill(record, abstract, conclusion, keywords, tldr):
        record.update(enrich.rules(record, abstract, conclusion, tax, keywords, tldr))
        if not record['fields']:
            record['fields'] = list(tax.journals.get(record['journal'], {}).get('fields', []))[:1]
        record['by'] = 'rules'

    stop = False

    def one(item):
        nonlocal stop
        record, abstract, conclusion, keywords, tldr = item
        late = deadline is not None and time.monotonic() > deadline
        if late and keep_if_late:
            stats['deferred'] = stats.get('deferred', 0) + 1
            return
        record['at'] = now_utc().date().isoformat()
        record['text'] = [k for k, v in (('abstract', abstract), ('conclusion', conclusion)) if v]
        if provider and not stop and not late:
            journal = tax.journals.get(record['journal'], {})
            try:
                out = provider.enrich(enrich.user_message(record, journal, abstract, conclusion))
                by = out.pop('by', None) or provider.name
                record.update(out)
                if not record['topics'] and keywords:
                    record['topics'] = [k.lower() for k in keywords[:3]]
                record['by'] = by
                stats['llm'] += 1
                return
            except enrich.QuotaReached as e:
                log.warning('%s', e)
                stop = True
            except enrich.EnrichError as e:
                log.warning('Enrichment failed for %s (%s); using rules', record['id'], e)
                stats['llm_failed'] += 1
        rule_fill(record, abstract, conclusion, keywords, tldr)
        stats['rules'] += 1

    workers = getattr(provider, 'workers', 1) if provider else 1
    with futures.ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(one, items))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('--since', help='collect papers published on or after this date (YYYY-MM-DD)')
    p.add_argument('--limit', type=int, default=0, help='process at most this many new papers')
    p.add_argument('--max-pdfs', type=int, default=250, help='open-access PDFs to read this run')
    p.add_argument('--reenrich', type=int, default=None,
                   help='papers to redo with the model: rule-tagged first, then (with Claude) free-model ones (default 60 with a key, 0 without)')
    p.add_argument('--no-model', action='store_true', help='tag with rules only, even if a key is set')
    p.add_argument('--time-budget', type=float, default=80,
                   help='minutes after which no new model calls start')
    p.add_argument('--dry-run', action='store_true', help='print what would be added; write nothing')
    p.add_argument('--retag-rules', action='store_true',
                   help='rebuild question, summary, contribution and identification of stored rule-tagged papers, then stop')
    p.add_argument('--redate-nber', action='store_true',
                   help='give stored NBER papers the day NBER released them (from their pages), then stop')
    p.add_argument('--store-dir', default=str(STORE), help=argparse.SUPPRESS)
    p.add_argument('--data-dir', default=str(DATA), help=argparse.SUPPRESS)
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    logging.basicConfig(level=logging.INFO, format='%(message)s')
    logging.getLogger('pypdf').setLevel(logging.ERROR)
    started = now_utc()
    if args.retag_rules:
        config = json.loads(CONFIG.read_text())
        tax = enrich.Taxonomy(config)
        store = Store(Path(args.store_dir), public=Path(args.data_dir))
        done = 0
        for _, p in store.papers():
            if p.get('by') == 'rules':
                # Text lines only: the tags were set with the full conclusion, which is not stored.
                p['abstract'] = strip_label(p.get('abstract', ''))
                fresh = enrich.rules(p, p['abstract'], p.get('conclusion', ''), tax, p.get('topics', []))
                for key in ('q', 'summary', 'contribution', 'ident'):
                    p[key] = fresh[key]
                store.touch(p)
                done += 1
        store.save()
        log.info('Rebuilt the text lines of %d rule-tagged papers', done)
        return None
    if args.redate_nber:
        store = Store(Path(args.store_dir), public=Path(args.data_dir))
        redate_nber(store)
        store.save()
        return None
    deadline = time.monotonic() + args.time_budget * 60
    config = json.loads(CONFIG.read_text())
    tax = enrich.Taxonomy(config)
    store = Store(Path(args.store_dir), public=Path(args.data_dir))
    journals = {j['openalex']: j for j in config['journals'] if j.get('enabled', True)}
    listed = [j for j in journals.values() if j.get('listing') == 'nber']  # read from NBER's own site
    since = args.since or (started.date() - timedelta(days=config.get('lookbackDays', 60))).isoformat()
    key = os.environ.get('OPENALEX_API_KEY', '')

    works = openalex_works([s for s, j in journals.items() if j not in listed], since, key)
    listed_keys = {j['key'] for j in config['journals'] if j.get('enabled', True)}
    dropped = store.remove(lambda p: p.get('journal') in listed_keys)
    if dropped:
        log.info('Removed %d papers from journals no longer in config.json', dropped)
    known_ids, known_dois = store.known()
    cands, skipped = [], 0
    for w in works:
        c = candidate(w, journals)
        if c and w.get('type') in ('report', 'preprint') and c['kind'] != 'working':
            skipped += 1
            continue
        if not c or c['id'] in known_ids or (c['doi'] and c['doi'] in known_dois):
            continue
        if not is_research(c):
            skipped += 1
            continue
        known_ids.add(c['id'])
        if c['doi']:
            known_dois.add(c['doi'])
        cands.append(c)
    log.info('OpenAlex: %d works since %s; %d new research papers (%d non-research items skipped)',
             len(works), since, len(cands), skipped)
    stored_by_doi = {p['doi']: p for _, p in store.papers() if p.get('doi')}
    for journal in listed:
        found, touched = collect_nber(journal, since, known_ids, stored_by_doi, key)
        for c in found:
            if c['doi'] in known_dois or not is_research(c):
                continue
            known_ids.add(c['id'])
            known_dois.add(c['doi'])
            cands.append(c)
        for p in touched:
            store.touch(p)
    cands.sort(key=lambda c: c['published'], reverse=True)
    if args.limit:
        cands = cands[:args.limit]

    if cands:
        fill_from_crossref(cands)
        s2 = fill_from_semantic_scholar(cands)
        log.info('Abstracts: %d/%d after Crossref and Semantic Scholar (+%d from S2)',
                 sum(bool(c['abstract']) for c in cands), len(cands), s2)

    # Open-access copies: conclusions, and abstracts the indexes lack.
    texts = {}
    with_pdf = [c for c in cands if c['_pdfs']][:args.max_pdfs]
    done = [0]

    def read(c):
        result = read_open_copy(c['_pdfs'], parser)
        done[0] += 1
        if done[0] % 100 == 0:
            log.info('  … %d/%d open-access copies tried', done[0], len(with_pdf))
        return result

    with futures.ProcessPoolExecutor(max_workers=max(1, min(4, (os.cpu_count() or 2) - 1))) as parser, \
            futures.ThreadPoolExecutor(max_workers=6) as pool:
        for c, (url, conclusion, pdf_abstract) in zip(with_pdf, pool.map(read, with_pdf)):
            if url:
                c['pdf'] = url
                texts[c['id']] = conclusion
                if not c['abstract'] and pdf_abstract:
                    c['abstract'] = pdf_abstract
    log.info('Open-access PDFs read: %d of %d tried; conclusions found: %d',
             len(texts), len(with_pdf), sum(bool(t) for t in texts.values()))
    for c in cands:  # last resort: the listing's opening lines of the abstract
        if not c['abstract'] and c.get('_short'):
            c['abstract'] = c['_short']
    if args.no_model and not args.dry_run:
        save_conclusions(texts)  # kept for the Claude session that summarises these papers

    # Outside economics, an item with no abstract and no text is usually a comment or news piece.
    before = len(cands)
    cands = [c for c in cands if c['_group'] != 'beyond' or c['abstract'] or texts.get(c['id'])]
    if before != len(cands):
        log.info('Dropped %d abstract-less items from non-economics journals', before - len(cands))

    provider = None if args.no_model else enrich.choose_provider(tax, store.top_topics())
    log.info('Enrichment: %s', provider.name if provider else 'rules only (no ANTHROPIC_API_KEY or OPENROUTER_API_KEY)')
    stats = {'llm': 0, 'llm_failed': 0, 'rules': 0}
    added = started.date().isoformat()
    records = []
    items = []
    for c in cands:
        record = stored(c)
        record['added'] = added
        records.append(record)
        items.append((record, c['abstract'], texts.get(c['id'], ''), c['_keywords'], c.get('_tldr', '')))
    enrich_all(items, provider, tax, stats, deadline)

    # Upgrade earlier rule-tagged papers once a model is available.
    upgraded = 0
    budget = args.reenrich if args.reenrich is not None else (60 if provider else 0)
    if provider and budget > 0:
        # Rule-tagged papers first; Claude then also redoes summaries written by free models.
        newest = lambda rows: sorted(rows, key=lambda p: (p['added'], p.get('published', '')), reverse=True)
        stored_papers = [p for _, p in store.papers()]
        old = newest([p for p in stored_papers if p.get('by') == 'rules'])
        if isinstance(provider, enrich.ClaudeEnricher):
            old += newest([p for p in stored_papers if str(p.get('by', '')).startswith('openrouter:')])
        old = old[:budget]
        with futures.ProcessPoolExecutor(max_workers=max(1, min(4, (os.cpu_count() or 2) - 1))) as parser, \
                futures.ThreadPoolExecutor(max_workers=6) as pool:
            conclusions = list(pool.map(lambda p: read_open_copy([p['pdf']], parser)[1] if p.get('pdf') else '', old))
        redo = [(p, p.get('abstract', ''), conc, p.get('topics', []), '') for p, conc in zip(old, conclusions)]
        before_llm = stats['llm']
        enrich_all(redo, provider, tax, stats, deadline, keep_if_late=True)
        upgraded = stats['llm'] - before_llm
        for p, *_ in redo:
            store.touch(p)

    if provider and hasattr(provider, 'report'):
        log.info('%s', provider.report())
    per_journal = {}
    for r in records:
        per_journal[r['journal']] = per_journal.get(r['journal'], 0) + 1
    run = {'at': now_utc().isoformat(timespec='seconds'), 'since': since, 'added': len(records), 'upgraded': upgraded,
           'byModel': stats['llm'], 'byRules': stats['rules'], 'failed': stats['llm_failed'], 'deferred': stats.get('deferred', 0),
           'provider': provider.name if provider else 'rules', 'pdfs': len(texts), 'journals': per_journal,
           'seconds': round((now_utc() - started).total_seconds())}
    if args.dry_run:
        for r in records[:20]:
            print(json.dumps({k: r.get(k) for k in ('journal', 'published', 'title', 'q', 'fields', 'methods', 'data', 'topics', 'by')}, ensure_ascii=False))
        print(json.dumps(run, indent=1))
        return run
    for r in records:
        store.add(r)
    store.save(run)
    log.info('Added %d papers (%d by model, %d by rules), upgraded %d%s; %d papers in the radar',
             len(records), stats['llm'] - upgraded, stats['rules'], upgraded,
             f", {stats['deferred']} left for the next run (time budget)" if stats.get('deferred') else '', store.index['total'])
    return run


if __name__ == '__main__':
    main()
