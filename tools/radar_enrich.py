"""Summaries and tags for EconRadar papers.

Three ways to enrich a paper, chosen by which secret the collector finds:

* Claude (ANTHROPIC_API_KEY): structured JSON output, model from RADAR_MODEL
  (default claude-opus-5-5; claude-haiku-5-5 is ~40x cheaper).
* OpenRouter free models (OPENROUTER_API_KEY): same prompt, JSON validated here.
* Rules (no key, or when a call fails): sentence extraction and the regular
  expressions in radar/config.json. Rule-tagged papers are upgraded on later runs
  once a key is available.

Whatever a model returns is validated against the taxonomy in config.json, so an
unknown field or method key can never reach the app.
"""
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request

WORD = re.compile(r'\s+')


def clean(value, limit=None):
    text = WORD.sub(' ', str(value or '')).strip()
    return text[:limit].rstrip() if limit and len(text) > limit else text


def respace(text):
    """Indexes sometimes run sentences together ("portfolio.Covariance"): restore the space."""
    return re.sub(r'([a-z)\]%]{2})([.?!])([A-Z][a-z])', r'\1\2 \3', clean(text))


def sentences(text):
    text = respace(text)
    if not text:
        return []
    # Split on sentence ends, but not after common abbreviations or initials.
    parts = re.split(r'(?<=[.!?])(?<!\b[A-Z]\.)(?<!\bU\.S\.)(?<!\be\.g\.)(?<!\bi\.e\.)(?<!\bal\.)(?<!\bvs\.)\s+(?=[A-Z0-9“"(])', text)
    return [p.strip() for p in parts if len(p.strip()) > 2]


class Taxonomy:
    """The keys a paper may be tagged with, from radar/config.json."""

    def __init__(self, config):
        self.config = config
        self.families = {f['key']: f for f in config['families']}
        self.fields = config['fields']
        self.methods = config['methods']
        self.data_types = config['dataTypes']
        self.field_keys = [f['key'] for f in self.fields]
        self.method_keys = [m['key'] for m in self.methods]
        self.data_keys = [d['key'] for d in self.data_types]
        self.journals = {j['key']: j for j in config['journals']}
        compile_ = lambda rows: [(r['key'], re.compile(r['match'], re.I)) for r in rows if r.get('match')]
        self.field_re = compile_(self.fields)
        self.method_re = compile_(self.methods)
        self.data_re = compile_(self.data_types)
        self.method_group = {m['key']: m.get('group', '') for m in self.methods}
        self.jel_to_field = []
        for f in self.fields:
            for code in f.get('jel', []):
                self.jel_to_field.append((code, f['key']))
        self.jel_to_field.sort(key=lambda x: -len(x[0]))  # most specific prefix first

    def field_from_jel(self, code):
        for prefix, key in self.jel_to_field:
            if code.startswith(prefix):
                return key
        return None


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------
AIM = re.compile(r'\b(?:we|this (?:paper|article|study|note))\b[^.?!]{0,60}?\b(?:stud(?:y|ies)|examine|investigate|ask|analy[sz]e|explore|quantif(?:y|ies)|estimate|test|evaluate|assess|measure|document|propose|develop)', re.I)
CONTRIB = re.compile(r'\bcontribut|\b(?:we are|is) the first|\bfirst (?:to|paper|study|evidence|causal|systematic)|\bnovel\b|'
                     r'\bnew (?:data|dataset|evidence|approach|method|measure|framework|estimator|insight)|'
                     r'\b(?:this|our) (?:paper|article|study|analysis|work) (?:adds|extends|complements|advances|fills|offers|provides)|\bliterature\b', re.I)
DESIGN_GROUPS = ('design', 'model')


def trim_words(text, n):
    words = clean(text).split()
    return ' '.join(words[:n]) + (' …' if len(words) > n else '')


def rule_extras(abstract, conclusion, tax, exclude=()):
    """Contribution and identification sentences picked from the text, for rule-tagged papers."""
    sents = sentences(abstract) + sentences(conclusion)
    contrib = next((s for s in sents if CONTRIB.search(s) and s not in exclude), '') or next((s for s in sents if CONTRIB.search(s)), '')
    design = [rx for key, rx in tax.method_re if tax.method_group.get(key) in DESIGN_GROUPS]
    ident = next((s for s in sents if s != contrib and any(rx.search(s) for rx in design)), '')
    return {'contribution': trim_words(contrib, 45), 'ident': trim_words(ident, 40)}


FINDING = re.compile(r'\bwe (?:find|show|document|estimate|establish)|\bresults (?:show|suggest|indicate|reveal)|\b(?:finds?|shows?) that\b', re.I)
YEARS = re.compile(r'\b(1[5-9]\d\d|20[0-2]\d)\s*(?:-|–|—|to|and)\s*(1[5-9]\d\d|20[0-2]\d)\b')
PLACES = [
    ('United States', r'\bU\.\s?S\.(?!\w)|\bUnited States\b|\bUSA\b|\bAmerican (?:states|counties|cities|workers|households)'),
    ('United Kingdom', r'\bUnited Kingdom\b|\bU\.K\.|\bBritain\b|\bBritish\b|\bEngland\b|\bEnglish (?:parishes|counties)'),
    ('China', r'\bChina\b|\bChinese\b'), ('India', r'\bIndia\b|\bIndian (?:states|districts|villages|households)'),
    ('Brazil', r'\bBrazil'), ('Mexico', r'\bMexic'), ('Germany', r'\bGerman'), ('France', r'\bFrance\b|\bFrench\b'),
    ('Italy', r'\bItal(?:y|ian)'), ('Spain', r'\bSpain\b|\bSpanish\b'), ('Sweden', r'\bSwed(?:en|ish)'),
    ('Denmark', r'\bDen(?:mark|ish)\b'), ('Norway', r'\bNorw(?:ay|egian)'), ('Finland', r'\bFin(?:land|nish)\b'),
    ('Netherlands', r'\bNetherlands\b|\bDutch\b'), ('Canada', r'\bCanad'), ('Japan', r'\bJapan'),
    ('South Korea', r'\bKorea'), ('Indonesia', r'\bIndonesia'), ('Kenya', r'\bKenya'), ('Uganda', r'\bUganda'),
    ('Ethiopia', r'\bEthiopia'), ('Nigeria', r'\bNigeria'), ('South Africa', r'\bSouth Africa'),
    ('Ghana', r'\bGhana'), ('Bangladesh', r'\bBangladesh'), ('Pakistan', r'\bPakistan'), ('Colombia', r'\bColombia'),
    ('Chile', r'\bChile'), ('Peru', r'\bPeru\b|\bPeruvian'), ('Argentina', r'\bArgentin'), ('Russia', r'\bRussia|\bSoviet'),
    ('Ottoman Empire', r'\bOttoman'), ('Portugal', r'\bPortug'), ('Switzerland', r'\bSwiss\b|\bSwitzerland'),
    ('Austria', r'\bAustria'), ('Belgium', r'\bBelgi'), ('Poland', r'\bPol(?:and|ish)\b'), ('Turkey', r'\bTurk(?:ey|ish)\b|\bTürkiye'),
    ('Vietnam', r'\bViet ?nam'), ('Philippines', r'\bPhilippin'), ('Australia', r'\bAustralia'), ('Israel', r'\bIsrael'),
    ('Europe', r'\bEurope(?:an Union)?\b|\beuro area\b'), ('Sub-Saharan Africa', r'\bsub-Saharan\b|\bAfrica\b'),
    ('Latin America', r'\bLatin America'), ('Global', r'\bcross-country\b|\b\d{2,3} countries\b'),
]
PLACES = [(name, re.compile(pattern)) for name, pattern in PLACES]


def question_from(title, abstract_sents):
    for s in abstract_sents:
        if s.endswith('?') and len(s.split()) <= 45:
            return s
    for s in abstract_sents:
        if AIM.search(s):
            words = s.split()
            return ' '.join(words[:45]) + (' …' if len(words) > 45 else '')
    return ''


def rules(paper, abstract, conclusion, tax, keywords=(), tldr=''):
    """A best-effort record from text alone. Marked by='rules' so a model can redo it later."""
    title = paper.get('title', '')
    abs_sents = sentences(abstract)
    head = f'{title}. {abstract}'
    body = f'{head} {conclusion[:5000]}'
    summary = abs_sents[:2]
    finding = next((s for s in abs_sents[2:] if FINDING.search(s)), None)
    if finding:
        summary.append(finding)
    summary_text = clean(' '.join(summary), 700) or clean(tldr, 500)
    conc_text = clean(' '.join(sentences(conclusion)[:2]), 500)

    journal = tax.journals.get(paper.get('journal'), {})
    scores = {}
    for key in journal.get('fields', []):
        scores[key] = scores.get(key, 0) + 3
    for key, rx in tax.field_re:
        in_title = len(rx.findall(title))
        in_text = len(rx.findall(head))
        if in_title or in_text:
            scores[key] = scores.get(key, 0) + 2 * min(in_title, 2) + min(in_text, 3)
    # A field needs the journal's own focus, a title hit, or repeated mentions in the abstract.
    fields = [k for k, v in sorted(scores.items(), key=lambda kv: -kv[1]) if v >= 3][:3]

    methods = [k for k, rx in tax.method_re if rx.search(body)]
    if 'staggered-did' in methods and 'did' not in methods:
        methods.insert(methods.index('staggered-did'), 'did')
    methods = methods[:4]
    experimental = {'rct', 'lab-exp', 'survey-exp'} & set(methods)
    data = [k for k, rx in tax.data_re if rx.search(body) and (k != 'experimental' or experimental)][:4]

    topics = []
    for kw in keywords:
        kw = clean(kw).lower()
        if 2 < len(kw) <= 40 and kw not in topics:
            topics.append(kw)
    geo = [name for name, rx in PLACES if rx.search(head)][:4]
    years = YEARS.search(head)
    extras = rule_extras(abstract, conclusion, tax, exclude=summary)
    return {
        'q': question_from(title, abs_sents),
        'contribution': extras['contribution'],
        'summary': summary_text,
        'conclusion': conc_text,
        'fields': fields,
        'methods': methods,
        'ident': extras['ident'],
        'data': data,
        'dataDetail': '',
        'topics': topics[:4],
        'geo': geo,
        'period': f'{years.group(1)}–{years.group(2)}' if years else '',
        'jel': [],
    }


# ---------------------------------------------------------------------------
# Prompt, schema, validation (shared by both model providers)
# ---------------------------------------------------------------------------
def system_prompt(tax, vocabulary=()):
    fields = '\n'.join(f"- {f['key']}: {f['label']}" + (f" (JEL {', '.join(f['jel'])})" if f.get('jel') else '') for f in tax.fields)
    groups = {g['key']: g['label'] for g in tax.config['methodGroups']}
    methods = '\n'.join(f"- {m['key']}: {m['label']} [{groups.get(m['group'], m['group'])}]" for m in tax.methods)
    data = '\n'.join(f"- {d['key']}: {d['label']}" for d in tax.data_types)
    vocab = ', '.join(vocabulary) if vocabulary else '(none yet)'
    return f"""You index research papers for EconRadar, a digest of papers from leading economics journals and NBER working papers, kept by an economics researcher. For each paper you receive its metadata, its abstract and, when an open-access copy could be read, an excerpt of its conclusion section. Return one JSON object that summarises and classifies the paper. Researchers skim these entries to decide what to read, and the tags feed a network linking papers by topic, method, identification strategy and data, so a wrong tag is worse than a missing one.

Writing
- question: the research question as one direct question of at most 30 words, ending with "?". Name the setting, population or mechanism when the paper does. A question, not a topic ("How does X affect Y among Z?").
- contribution: what is new, in 1-2 sentences of at most 35 words, starting with a verb ("Provides the first causal estimate of ...", "Develops a model in which ..."). Name the specific novelty: the new data, setting, design, estimator or mechanism, and what it improves on when the text says so. Never vague phrases such as "sheds light on", "contributes to the literature" or "provides insights"; do not repeat the summary.
- summary: 2-3 sentences: what the paper does, then its main findings. Give headline magnitudes with units and their comparison point when the text gives them ("raises employment by 4% relative to ..."). Start with the finding or the setting, never with "This paper", "The paper", "We" or "The authors", and do not restate the question or copy the abstract's sentences.
- conclusion: 1-2 sentences on the implications drawn in the conclusion excerpt; without an excerpt, the policy or theoretical implication stated in the abstract, or "" if there is none. Do not repeat the summary.
- identification: at most 25 words. Empirical causal work: the design and the source of variation ("Staggered DiD exploiting the county-level rollout of X, 1995-2010"; "IV using rainfall shocks as instrument for income"). Structural or quantitative work: "Structural: " or "Quantitative: ", the model, and what it is estimated or calibrated on. Pure theory: "Theory: " and the type of model. Descriptive or measurement work: "Descriptive: " and what is measured. Econometric methods: "Econometric theory: " and the problem addressed.
- data_detail: the main data sources named concretely (survey, registry, country, years) in at most 20 words; "" if none.

Classifying (use only the keys listed below)
- fields: 1-3 field keys, primary first, chosen by the economic question rather than the journal.
- methods: 1-4 method keys the paper actually uses, research design first, then estimation or modelling. Tag the design the text describes even when it does not name it: outcomes compared before and after a policy between affected and unaffected units is did (event-study when effects are traced period by period); a cutoff or threshold rule is rdd; an instrument or exogenous shifter of the treatment is iv.
  - theory: the main output is a model with formal results. Not for empirical papers that write a small model to motivate estimates.
  - structural: model parameters are estimated or calibrated on data and used for counterfactuals. Not for pure theory.
  - quant-macro: calibrated or estimated macro models (DSGE, HANK, growth, OLG, quantitative trade or spatial models). Use it instead of structural for macro models.
  - metrics-theory: new estimators, tests or identification results; add simulations only through data_types if they are central.
  - descriptive: documents facts or measures something without a causal design. Do not combine with a causal design key unless the paper has both parts.
  - panel-fe: only when fixed-effects regressions are the main design, not as a by-product of DiD or event studies.
  - staggered-did: only when the paper uses heterogeneity-robust estimators or explicitly addresses staggered timing; tag it together with did.
- data_types: 0-4 keys for data the paper itself analyses. Pure theory and pure econometric theory: [] (a numerical example is not data). simulated: only when simulation or a calibrated numerical model produces the paper's main results. experimental: data from an experiment the authors ran.
- topics: 2-5 short lowercase noun phrases for the substantive subject, such as "minimum wage", "intergenerational mobility" or "railways". Specific enough to group related papers, general enough to be shared ("unemployment insurance", not "the 2009 extension of UI in Michigan"; not "economics" or "policy"). Reuse a label from the existing topics when one fits. No method names, no country names, no sentences.
- geography: countries or regions the data cover, as plain names ("United States", "Sub-Saharan Africa"); [] for theory or global studies.
- period: the period the data cover, such as "1850-1910"; "" if not applicable.
- jel: 1-4 JEL codes at the three-character level, such as "J31".

Use only what the provided text supports; never invent results, magnitudes or data it does not state. If only a title is available: summary is one sentence on what the title says the paper studies; contribution, conclusion, identification and data_detail are ""; methods and data_types only if the title names them; geography and period only if the title states them.

Field keys
{fields}

Method keys
{methods}

Data keys
{data}

Existing topics
{vocab}"""


def output_schema(tax):
    text = {'type': 'string'}
    strings = {'type': 'array', 'items': {'type': 'string'}}
    enum = lambda keys: {'type': 'array', 'items': {'type': 'string', 'enum': list(keys)}}
    props = {
        'question': text, 'contribution': text, 'summary': text, 'conclusion': text,
        'fields': enum(tax.field_keys), 'methods': enum(tax.method_keys),
        'identification': text, 'data_types': enum(tax.data_keys), 'data_detail': text,
        'topics': strings, 'geography': strings, 'period': text, 'jel': strings,
    }
    return {'type': 'object', 'properties': props, 'required': list(props), 'additionalProperties': False}


def user_message(paper, journal, abstract, conclusion):
    authors = ', '.join(a['n'] + (f" ({a['inst']})" if a.get('inst') else '') for a in paper.get('authors', [])[:12])
    parts = [
        f"{'Working paper series' if journal.get('kind') == 'working' else 'Journal'}: {journal.get('name', paper.get('journal'))}",
        f"Published: {paper.get('published') or 'unknown'}",
        f"Title: {paper.get('title')}",
        f"Authors: {authors or 'unknown'}",
        f"Abstract: {abstract or '(not available)'}",
    ]
    if conclusion:
        parts.append(f'Conclusion excerpt (from an open-access copy):\n{conclusion}')
    return '\n'.join(parts)


class EnrichError(Exception):
    pass


# Weak models sometimes fill a field with a stand-in instead of an answer.
JUNK = re.compile(r'^(?:placeholder|n/?a|none|null|nil|tbd|todo|unknown|string|text|not (?:available|applicable|stated|provided|reported)|\.{2,}|-+|…|lorem ipsum.*)\.?$', re.I)


# ...or opens with a remark about its input ("Abstract unavailable: ...", "Based on the title alone, ...").
_MISSING = r'(?:the )?(?:abstract|full text|text|conclusion)\s+(?:is\s+)?(?:unavailable|not available|not provided|missing)'
REMARK = re.compile(rf'^\s*(?:\({_MISSING}\)\s*[:.;,\-–—]?\s*|{_MISSING}\s*[:.;,\-–—]\s*'
                    r'|based (?:only |solely )?on the title(?: alone)?,?\s*)', re.I)


def answer(value, limit):
    text = clean(value, limit)
    stripped = REMARK.sub('', text)
    if stripped != text and stripped:
        text = stripped[0].upper() + stripped[1:]
    return '' if JUNK.match(text) else text


def _strings(value, limit, size):
    out = []
    for item in value if isinstance(value, list) else []:
        item = answer(item, size)
        if item and item.lower() not in {x.lower() for x in out}:
            out.append(item)
    return out[:limit]


def _keys(value, allowed, limit):
    out = []
    for item in value if isinstance(value, list) else []:
        if item in allowed and item not in out:
            out.append(item)
    return out[:limit]


def validate(raw, tax):
    """Model output -> record fields. Raises EnrichError when the answer is unusable."""
    if not isinstance(raw, dict):
        raise EnrichError('answer is not a JSON object')
    summary = answer(raw.get('summary'), 900)
    fields = _keys(raw.get('fields'), set(tax.field_keys), 3)
    if not summary or not fields:
        raise EnrichError('answer lacks a summary or a field')
    methods = _keys(raw.get('methods'), set(tax.method_keys), 4)
    if 'staggered-did' in methods and 'did' not in methods:
        methods.insert(methods.index('staggered-did'), 'did')
        methods = methods[:4]
    topics = [t.lower() for t in _strings(raw.get('topics'), 5, 48) if len(t) >= 3]
    jel = [j.upper() for j in _strings(raw.get('jel'), 4, 4) if re.fullmatch(r'[A-Za-z]\d{0,2}', j)]
    question = answer(raw.get('question'), 320)
    return {
        'q': question,
        'contribution': answer(raw.get('contribution'), 400),
        'summary': summary,
        'conclusion': answer(raw.get('conclusion'), 600),
        'fields': fields,
        'methods': methods,
        'ident': answer(raw.get('identification'), 260),
        'data': _keys(raw.get('data_types'), set(tax.data_keys), 4),
        'dataDetail': answer(raw.get('data_detail'), 220),
        'topics': topics,
        'geo': _strings(raw.get('geography'), 4, 40),
        'period': answer(raw.get('period'), 30).replace('-', '–'),
        'jel': jel,
    }


def parse_json_text(text):
    text = (text or '').strip()
    text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text)
    start, end = text.find('{'), text.rfind('}')
    if start < 0 or end <= start:
        raise EnrichError('no JSON object in the answer')
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError as e:
        raise EnrichError(f'invalid JSON: {e}') from e


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------
# Models that accept the server-side refusal fallback ("default" routing).
FALLBACK_MODELS = re.compile(r'^claude-(opus-5|fable-5|sonnet-5-5)')


class ClaudeEnricher:
    def __init__(self, tax, vocabulary=(), model=None):
        import anthropic  # installed by the workflow; only needed when a key is set
        self.anthropic = anthropic
        self.client = anthropic.Anthropic(max_retries=4, timeout=180.0)
        self.model = model or os.environ.get('RADAR_MODEL') or 'claude-opus-5-5'
        self.name = self.model
        self.tax = tax
        self.system = system_prompt(tax, vocabulary)
        self.schema = output_schema(tax)
        self.fallbacks = bool(FALLBACK_MODELS.match(self.model))
        self.workers = 4

    def _call(self, message):
        kwargs = dict(
            model=self.model,
            max_tokens=6000,
            system=self.system,
            cache_control={'type': 'ephemeral'},
            output_config={'effort': 'low', 'format': {'type': 'json_schema', 'schema': self.schema}},
            messages=[{'role': 'user', 'content': message}],
        )
        if self.fallbacks:
            try:
                return self.client.beta.messages.create(
                    betas=['server-side-fallback-2026-07-01'], fallbacks='default', **kwargs)
            except self.anthropic.BadRequestError as e:
                if 'fallback' not in str(e).lower():
                    raise
                self.fallbacks = False  # this account or model does not take it; carry on without
        return self.client.messages.create(**kwargs)

    def enrich(self, message):
        try:
            response = self._call(message)
        except self.anthropic.AuthenticationError as e:
            raise SystemExit(f'Anthropic API key rejected: {e}') from e
        except self.anthropic.APIStatusError as e:
            raise EnrichError(f'Anthropic API {e.status_code}: {e.message}') from e
        except self.anthropic.APIConnectionError as e:
            raise EnrichError(f'Anthropic API unreachable: {e}') from e
        if response.stop_reason == 'refusal':
            raise EnrichError('model declined')
        if response.stop_reason == 'max_tokens':
            raise EnrichError('answer cut off at max_tokens')
        text = next((b.text for b in response.content if b.type == 'text'), '')
        return validate(parse_json_text(text), self.tax)


# Free models are many, change often and vary a lot in how reliably they return JSON. Rank
# the live list: enforced JSON (structured outputs) first, then JSON mode, then the rest;
# within each, the families the other apps on this site prefer (shared/openrouter.mjs).
OPENROUTER_PREFER = ['gemma-4-31b', 'nemotron-3.5-super', 'nemotron-3-super', 'gemma-4', 'deepseek', 'qwen3', 'llama-4',
                     'gpt-oss', 'ernie', 'glm', 'kimi', 'mistral', 'dots', 'nemotron']
OPENROUTER_SKIP = re.compile(r'content-safety|guard|lyria|embed|tts|whisper|rerank|\bxs\b|code|inkling|nano|audio|image', re.I)


def model_size(model_id):
    m = re.search(r'(\d+(?:\.\d+)?)b\b', model_id.split('/')[-1])
    return float(m.group(1)) if m else None


def rank_free_models(models):
    """OpenRouter /models entries -> free text models, most dependable for JSON first."""
    ranked = []
    for m in models:
        mid = m.get('id', '')
        price = m.get('pricing') or {}
        try:
            free = mid.endswith(':free') or (float(price.get('prompt') or 1) == 0 and float(price.get('completion') or 1) == 0)
        except ValueError:
            free = False
        size = model_size(mid)
        if not free or mid == 'openrouter/free' or OPENROUTER_SKIP.search(mid) or (size is not None and size < 8):
            continue
        params = set(m.get('supported_parameters') or [])
        json_tier = 0 if 'structured_outputs' in params else 1 if 'response_format' in params else 2
        prefer = next((i for i, p in enumerate(OPENROUTER_PREFER) if p in mid), len(OPENROUTER_PREFER))
        ranked.append(((json_tier, prefer, -(m.get('context_length') or 0)), {
            'id': mid, 'structured': json_tier == 0, 'json_mode': json_tier <= 1, 'reasoning': 'reasoning' in params}))
    return [m for _, m in sorted(ranked, key=lambda r: r[0])]


class OpenRouterEnricher:
    URL = 'https://openrouter.ai/api/v1/chat/completions'
    MODELS_URL = 'https://openrouter.ai/api/v1/models'

    def __init__(self, tax, vocabulary=(), model=None, key=None, models=None):
        self.key = key or os.environ['OPENROUTER_API_KEY']
        self.tax = tax
        self.schema = output_schema(tax)
        keys = ', '.join(self.schema['properties'])
        self.system = system_prompt(tax, vocabulary) + (
            f'\n\nAnswer with one JSON object and nothing else. Keys: {keys}. '
            'fields, methods, data_types, topics, geography and jel are arrays of strings; the rest are strings.')
        pinned = model or os.environ.get('RADAR_OPENROUTER_MODEL')
        if pinned:
            self.models = [{'id': pinned, 'structured': False, 'json_mode': True, 'reasoning': False}]
        else:
            self.models = rank_free_models(models if models is not None else self._live_models())
        # The router is the last resort: it picks any free model, JSON or not.
        self.models.append({'id': 'openrouter/free', 'structured': False, 'json_mode': True, 'reasoning': False})
        self.name = 'openrouter:' + self.models[0]['id']
        self.workers = 1
        self.lock = threading.Lock()
        self.stamps = []
        self.failures = {}       # model id -> consecutive failed answers
        self.dropped = set()     # models failing repeatedly, not tried again this run
        self.papers_failed = 0   # consecutive papers no model could summarise
        self.tally = {}          # model id -> [answers used, answers rejected]

    def _live_models(self):
        try:
            req = urllib.request.Request(self.MODELS_URL, headers={'User-Agent': 'EconRadar/1.0'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r).get('data') or []
        except Exception:
            return []

    def _pace(self):
        # Free models allow about 20 requests a minute; stay under 15.
        with self.lock:
            now = time.time()
            self.stamps = [t for t in self.stamps if now - t < 60]
            if len(self.stamps) >= 15:
                time.sleep(60 - (now - self.stamps[0]) + 0.5)
            self.stamps.append(time.time())

    @staticmethod
    def _problem(code, detail):
        """Turn an OpenRouter error into: stop the run, stop the provider, or try another model."""
        if code in (401, 403):
            return SystemExit(f'OpenRouter key rejected ({code}): {detail}')
        if code == 402 or (code == 429 and re.search(r'per[- ]?day|daily', detail, re.I)):
            return QuotaReached(f'OpenRouter free allowance used up for today ({code}): {detail}')
        if code == 404 and re.search(r'data policy|privacy', detail, re.I):
            return QuotaReached('OpenRouter found no free model your privacy settings allow; enable free endpoints at '
                                f'https://openrouter.ai/settings/privacy ({detail})')
        return EnrichError(f'OpenRouter {code}: {detail}')

    def _body(self, model, message):
        body = {
            'model': model['id'],
            'messages': [{'role': 'system', 'content': self.system}, {'role': 'user', 'content': message}],
            'max_tokens': 6000,
        }
        if model['structured']:
            body['response_format'] = {'type': 'json_schema', 'json_schema': {'name': 'paper', 'strict': True, 'schema': self.schema}}
        elif model['json_mode']:
            body['response_format'] = {'type': 'json_object'}
        if model['reasoning']:
            body['reasoning'] = {'effort': 'low'}  # thinking models otherwise spend the budget before answering
        if model['id'] != 'openrouter/free':
            body['provider'] = {'require_parameters': True}  # only providers that honour the JSON format
        return json.dumps(body).encode()

    def report(self):
        rows = [f"{mid.split('/')[-1]} {ok} ok/{bad} rejected" for mid, (ok, bad) in self.tally.items()]
        return 'OpenRouter models: ' + ('; '.join(rows) or 'none called') + (f" (dropped: {', '.join(sorted(self.dropped))})" if self.dropped else '')

    def _fail(self, model, error):
        self.tally.setdefault(model['id'], [0, 0])[1] += 1
        n = self.failures.get(model['id'], 0) + 1
        self.failures[model['id']] = n
        if n >= 2 and model['id'] != 'openrouter/free':
            self.dropped.add(model['id'])
        return error

    def enrich(self, message):
        last = None
        tried = [m for m in self.models if m['id'] not in self.dropped][:3]
        for model in tried:
            self._pace()
            req = urllib.request.Request(self.URL, data=self._body(model, message), headers={
                'Authorization': f'Bearer {self.key}', 'Content-Type': 'application/json',
                'X-Title': 'EconRadar'})
            content, finish = '', ''
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    data = json.load(r)
                if data.get('error'):  # OpenRouter also reports upstream failures inside a 200
                    err = data['error'] if isinstance(data['error'], dict) else {'message': str(data['error'])}
                    raise self._problem(int(err.get('code') or 0), clean(err.get('message'), 300))
                choice = (data.get('choices') or [{}])[0]
                content = (choice.get('message') or {}).get('content') or ''
                finish = choice.get('finish_reason') or choice.get('native_finish_reason') or ''
                out = validate(parse_json_text(content), self.tax)
                out['by'] = f"openrouter:{data.get('model') or model['id']}"
                self.failures[model['id']] = 0
                self.papers_failed = 0
                self.tally.setdefault(model['id'], [0, 0])[0] += 1
                return out
            except urllib.error.HTTPError as e:
                problem = self._problem(e.code, e.read()[:300].decode('utf-8', 'replace'))
                if not isinstance(problem, EnrichError):
                    raise problem from e
                last = self._fail(model, EnrichError(f"{model['id']}: {problem}"))
            except EnrichError as e:
                shown = clean(content, 120)
                last = self._fail(model, EnrichError(f"{model['id']}: {e} (finish={finish or '?'}, {len(content)} chars{': ' + repr(shown) if shown else ''})"))
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
                last = self._fail(model, EnrichError(f"{model['id']}: {e}"))
        self.papers_failed += 1
        if self.papers_failed >= 5:
            raise QuotaReached(f'Free models failed on {self.papers_failed} papers in a row; '
                               f'stopping for this run to save the daily allowance (last: {last})')
        raise last or EnrichError('no free model available')


class QuotaReached(Exception):
    """Stop calling the provider for the rest of the run; remaining papers keep rule tags."""


def choose_provider(tax, vocabulary=(), env=os.environ):
    if env.get('ANTHROPIC_API_KEY'):
        return ClaudeEnricher(tax, vocabulary)
    if env.get('OPENROUTER_API_KEY'):
        return OpenRouterEnricher(tax, vocabulary, key=env['OPENROUTER_API_KEY'])
    return None
