"""Readers' flags on EconRadar summaries: list them, then fix or dismiss each one.

Each paper in the app links to a Google Form (radar/config.json -> feedback.form) pre-filled
with the paper's id and title; the reader says what is inaccurate and adds a note. The form's
responses sheet is read as CSV from the link in ECONRADAR_FLAGS_CSV (set it in ~/.zshenv; it
never goes in the repository). Decisions are kept on this Mac in .radar-cache/flags.json.

    python3 tools/radar_flags.py list              # open flags, each with the paper's current summary
    python3 tools/radar_flags.py list --all        # also the ones already decided
    python3 tools/radar_flags.py resolve <flag> --fixed [--reason "..."]
    python3 tools/radar_flags.py resolve <flag> --dismissed --reason "..."

To fix a paper: re-answer it (radar_batch.py export --ids <file with its id>, then import), or
correct the field the reader pointed at, then `resolve --fixed`, which marks the paper as
corrected in the app ("corrected <date> after a reader's flag").
"""
import argparse
import csv
import hashlib
import io
import json
import os
import sys
import urllib.request
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_literature as cl  # noqa: E402

DECISIONS = cl.CACHE / 'flags.json'
SHOWN = (('q', 'Question'), ('contribution', 'Contribution'), ('summary', 'Summary'), ('ident', 'Identification'),
         ('methods', 'Methods'), ('data', 'Data'), ('dataDetail', 'Data detail'), ('topics', 'Topics'),
         ('fields', 'Fields'), ('geo', 'Geography'), ('period', 'Period'), ('by', 'Summary by'))


def column(header, *words):
    """The first column whose name contains one of `words` (the form's questions may be worded freely)."""
    for i, name in enumerate(header):
        if any(w in name.lower() for w in words):
            return i
    return None


def parse(text):
    """Flags from the responses CSV: Timestamp, paper id, title, what is inaccurate, note."""
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return []
    header, flags = rows[0], []
    at = column(header, 'timestamp', 'horodat')
    pid = column(header, 'paper id', 'id')
    title = column(header, 'title', 'titre')
    what = column(header, 'inaccurate', 'what', 'which')
    note = column(header, 'note', 'comment', 'detail')
    if pid is None:
        raise SystemExit('The responses sheet has no "paper id" column.')
    get = lambda r, i: r[i].strip() if i is not None and i < len(r) else ''
    for r in rows[1:]:
        if not get(r, pid):
            continue
        key = hashlib.sha1(f'{get(r, at)}|{get(r, pid)}|{get(r, note)}'.encode()).hexdigest()[:8]
        flags.append({'flag': key, 'at': get(r, at), 'paper': get(r, pid), 'title': get(r, title),
                      'what': get(r, what), 'note': get(r, note)})
    return flags


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'EconRadar/1.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode('utf-8-sig')


def load_decisions():
    return json.loads(DECISIONS.read_text()) if DECISIONS.exists() else {}


def describe(flag, paper, decision=None):
    lines = [f"## Flag {flag['flag']} · {flag['at']} · paper {flag['paper']}"]
    if decision:
        lines.append(f"Decided: {decision['status']} on {decision['at']}" + (f" ({decision['reason']})" if decision.get('reason') else ''))
    lines += [f"Reader says inaccurate: {flag['what'] or '(not said)'}", f"Reader's note: {flag['note'] or '(none)'}"]
    if not paper:
        lines.append(f"Paper not in the radar (title given: {flag['title'] or 'none'}).")
        return '\n'.join(lines)
    lines.append(f"Paper: {paper['title']} ({paper.get('journal')}, {paper.get('published')})")
    for key, label in SHOWN:
        v = paper.get(key)
        if v:
            lines.append(f"  {label}: {', '.join(v) if isinstance(v, list) else v}")
    if paper.get('abstract'):
        lines.append(f"  Abstract: {paper['abstract']}")
    return '\n'.join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('command', choices=['list', 'resolve'])
    ap.add_argument('flag', nargs='?', help='resolve: the flag id shown by list')
    ap.add_argument('--all', action='store_true', help='list: include flags already decided')
    state = ap.add_mutually_exclusive_group()
    state.add_argument('--fixed', action='store_true')
    state.add_argument('--dismissed', action='store_true')
    ap.add_argument('--reason', default='', help='resolve: what was changed, or why the flag was dismissed')
    ap.add_argument('--csv', help='read the responses from this file instead of ECONRADAR_FLAGS_CSV')
    ap.add_argument('--data-dir', default=str(cl.DATA), help=argparse.SUPPRESS)
    args = ap.parse_args(argv)

    if args.csv:
        text = Path(args.csv).read_text(encoding='utf-8-sig')
    elif os.environ.get('ECONRADAR_FLAGS_CSV'):
        text = fetch(os.environ['ECONRADAR_FLAGS_CSV'])
    else:
        print('ECONRADAR_FLAGS_CSV is not set: no flags to read.')
        return 0
    flags, decisions = parse(text), load_decisions()
    store = cl.Store(Path(args.data_dir))

    if args.command == 'list':
        shown = [f for f in flags if args.all or f['flag'] not in decisions]
        print(f"{len(shown)} {'flags' if args.all else 'open flags'} ({len(flags)} in all)\n")
        print('\n\n'.join(describe(f, store.rows.get(f['paper']), decisions.get(f['flag'])) for f in shown))
        return 0

    flag = next((f for f in flags if f['flag'] == args.flag), None)
    if not flag or not (args.fixed or args.dismissed):
        raise SystemExit('Give a flag id from `list` and --fixed or --dismissed.')
    status = 'fixed' if args.fixed else 'dismissed'
    today = date.today().isoformat()
    if args.fixed and flag['paper'] in store.rows:
        store.rows[flag['paper']]['corrected'] = today
        store.dirty = True
        store.save()
    decisions[flag['flag']] = {'status': status, 'at': today, 'paper': flag['paper'], 'reason': args.reason}
    DECISIONS.parent.mkdir(exist_ok=True)
    DECISIONS.write_text(json.dumps(decisions, ensure_ascii=False, indent=1))
    print(f"Flag {flag['flag']} {status}.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
