"""EconRadar summaries written by Claude in a working session, without an API key.

The weekly routine (and any catch-up session) works in batches:

    python3 tools/radar_batch.py status                       # what still has no model summary
    python3 tools/radar_batch.py instructions                 # read once: the rules for every answer
    python3 tools/radar_batch.py export --n 25 --out batch.md # the next papers, as text to read
    python3 tools/radar_batch.py import --answers answers.json --by claude-sonnet-5-5

`export` writes one block per paper (journal, date, title, authors, abstract and, when an
open-access copy was read at collection time, the start of its conclusion). The session
writes answers.json: {"<paper id>": {question, contribution, summary, conclusion, fields,
methods, identification, data_types, data_detail, topics, geography, period, jel}, ...}.
`import` checks every answer against radar/config.json exactly as for the API models
(unknown keys dropped, an answer without a summary or a field rejected) and stores it.

--area basic-income works on a Focus area (radar/focus.json) instead of the radar.
Papers are taken newest first: this week's additions, then the backlog by publication date.
"""
import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_literature as cl  # noqa: E402
import radar_enrich as enrich  # noqa: E402

CONCLUSIONS = cl.CONCLUSIONS
CONCLUSION_CHARS = 1500  # enough to read the main finding; keeps a batch cheap to process
load_conclusions = cl.load_conclusions


def is_news(p, today=None):
    today = today or date.today()
    return (p.get('added', '') >= (today - timedelta(days=7)).isoformat()
            and (p.get('published') or '') >= (today - timedelta(days=60)).isoformat())


class Target:
    """The radar's store or a Focus area's store, behind one interface."""

    def __init__(self, data_dir, area=None):
        self.area = area
        if area:
            import collect_focus as cf
            self.store = cf.AreaStore(Path(data_dir), area)
            self.spec = next(a for a in json.loads(cf.FOCUS.read_text())['areas'] if a['key'] == area)
            self.rows = self.store.papers
        else:
            self.store = cl.Store(Path(data_dir))
            self.rows = {p['id']: p for _, p in self.store.papers()}

    def pending(self, today=None):
        """Papers without a model summary: this week's news first (added in the last 7 days and
        published in the last 60, as in the newsletter), then the backlog, newest published first."""
        rows = [p for p in self.rows.values() if p.get('by', 'rules') == 'rules' and (p.get('abstract') or p.get('title'))]
        return sorted(rows, key=lambda p: (is_news(p, today), p.get('published', ''), p['id']), reverse=True)

    def venue(self, p, tax):
        if self.area:
            return {'name': p.get('venue') or 'unknown venue', 'kind': 'working' if p.get('kind') == 'working' else ''}
        return tax.journals.get(p.get('journal'), {})

    def save(self):
        if self.area:
            self.store.save(self.spec, date.today())
        else:
            self.store.save()


def instructions(tax, vocabulary):
    schema = enrich.output_schema(tax)
    return (enrich.system_prompt(tax, vocabulary)
            + '\n\nHOW TO ANSWER IN THIS SESSION\n'
            'Write one JSON object to the answers file, keyed by paper id (the id after "### "), each value an object '
            'with exactly these keys: ' + ', '.join(schema['properties']) + '. Lists use only the keys given above. '
            'Never invent results that the abstract or conclusion does not state; leave a string empty rather than guess. '
            'Write in English even when the abstract is not.\n')


def export(target, tax, n, conclusions):
    blocks = []
    for p in target.pending()[:n]:
        conc = conclusions.get(p['id'], '')[:CONCLUSION_CHARS]
        blocks.append(f"### {p['id']}\n" + enrich.user_message(p, target.venue(p, tax), p.get('abstract', ''), conc))
    return '\n\n'.join(blocks) + ('\n' if blocks else '')


def import_answers(target, tax, answers, by, conclusions):
    done, rejected, unknown = [], {}, []
    today = date.today().isoformat()
    for pid, raw in answers.items():
        p = target.rows.get(pid)
        if not p:
            unknown.append(pid)
            continue
        try:
            out = enrich.validate(raw, tax)
        except enrich.EnrichError as e:
            rejected[pid] = str(e)
            continue
        if target.area:
            out = {k: v for k, v in out.items() if k in ('q', 'contribution', 'summary', 'ident', 'fields', 'methods', 'data',
                                                          'dataDetail', 'topics', 'geo', 'period', 'jel')}
        if not out.get('topics') and p.get('topics'):
            out['topics'] = p['topics']
        p.update(out)
        p['by'], p['at'] = by, today
        p['text'] = [k for k, v in (('abstract', p.get('abstract')), ('conclusion', conclusions.get(pid))) if v]
        done.append(pid)
    if done:
        target.save()
        left = {k: v for k, v in conclusions.items() if k not in done}
        if CONCLUSIONS.exists() and len(left) != len(conclusions):
            CONCLUSIONS.write_text(json.dumps(left, ensure_ascii=False))
    return done, rejected, unknown


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('command', choices=['status', 'instructions', 'export', 'import'])
    ap.add_argument('--n', type=int, default=25, help='papers per batch (export)')
    ap.add_argument('--out', help='where export writes the batch (default: print)')
    ap.add_argument('--answers', help='JSON file of answers to import')
    ap.add_argument('--by', default='claude-sonnet-5-5', help='recorded as the author of the summaries')
    ap.add_argument('--area', help='a Focus area key instead of the radar')
    ap.add_argument('--data-dir', default=str(cl.DATA), help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    tax = enrich.Taxonomy(json.loads(cl.CONFIG.read_text()))
    target = Target(args.data_dir, args.area)
    if args.command == 'status':
        pending = target.pending()
        recent = sum(is_news(p) for p in pending)
        print(json.dumps({'papers': len(target.rows), 'withoutModelSummary': len(pending), 'addedThisWeek': recent,
                          'conclusionsCached': len(load_conclusions())}))
        return 0
    if args.command == 'instructions':
        vocab = cl.Store(Path(args.data_dir)).top_topics() if not args.area else []
        print(instructions(tax, vocab))
        return 0
    if args.command == 'export':
        text = export(target, tax, args.n, load_conclusions())
        if args.out:
            Path(args.out).write_text(text)
            print(f'{text.count("### ")} papers written to {args.out}')
        else:
            print(text)
        return 0
    answers = json.loads(Path(args.answers).read_text())
    done, rejected, unknown = import_answers(target, tax, answers, args.by, load_conclusions())
    print(json.dumps({'stored': len(done), 'rejected': rejected, 'unknownIds': unknown, 'stillWithout': len(target.pending())}))
    return 1 if rejected or unknown else 0


if __name__ == '__main__':
    sys.exit(main())
