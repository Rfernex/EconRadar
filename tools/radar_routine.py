"""Housekeeping for EconRadar's scheduled Claude runs: a dedicated checkout, one run at a time,
a weekly usage budget for the catch-up, and a publish step that survives a moving main branch.

The runs work in their own git worktree (default: ../econradar-routine next to this repository),
on a detached copy of origin/main, so the owner's uncommitted work in the main checkout is never
touched and other routines' commits to main never block a run.

    python3 tools/radar_routine.py setup                     # once: create the worktree
    python3 tools/radar_routine.py begin --task catchup      # lock, then reset the worktree to origin/main
    python3 tools/radar_routine.py budget --weekly 69 --five-hour 30 --resets 2026-11-14T07:00:00Z
    python3 tools/radar_routine.py record --before 69 --after 70 --resets 2026-11-14T07:00:00Z
    python3 tools/radar_routine.py publish -m "EconRadar: summaries for 250 more papers"
    python3 tools/radar_routine.py end

`budget` and `record` keep the catch-up within a share of the weekly plan allowance
(BUDGET_SHARE, 25%). The percentages are the plan meters the Claude app reports. Each catch-up run
counts as at least RUN_FLOOR percent, or the meter's rise during the run if larger (other work
in the same window then counts against the catch-up: the error is on the safe side).
"""
import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_literature as cl  # noqa: E402

MAIN = cl.main_checkout(cl.ROOT)
WORKTREE = MAIN.parent / 'econradar-routine'
LEDGER = cl.CACHE / 'catchup-budget.json'
LOCK = cl.CACHE / 'routine.lock'
BUDGET_SHARE = 25.0   # percent of the weekly allowance the catch-up may use
RUN_FLOOR = 0.8       # percent counted per catch-up run at least (measured: 0.5-0.8 for 250 papers)
FIVE_HOUR_MAX = 75    # skip when the 5-hour window is this full, to leave room for the owner's work
WEEKLY_MAX = 95       # never push the week to its limit
LOCK_STALE = 3 * 3600


def git(*args, cwd=None, check=True):
    return subprocess.run(['git', *args], cwd=cwd or WORKTREE, capture_output=True, text=True, check=check)


def in_worktree():
    """True only inside the dedicated worktree: the commands that reset files never run elsewhere."""
    return cl.ROOT.resolve() == WORKTREE.resolve() and (cl.ROOT / '.git').is_file()


def setup():
    if WORKTREE.exists():
        print(f'Worktree already at {WORKTREE}')
        return 0
    git('fetch', '-q', 'origin', cwd=MAIN)
    git('worktree', 'add', '--detach', str(WORKTREE), 'origin/main', cwd=MAIN)
    print(f'Worktree created at {WORKTREE}')
    return 0


def begin(task):
    if not in_worktree():
        raise SystemExit(f'Run this from the routine worktree: cd {WORKTREE}')
    cl.CACHE.mkdir(exist_ok=True)
    if LOCK.exists():
        held = json.loads(LOCK.read_text())
        if time.time() - held.get('since', 0) < LOCK_STALE:
            print(f"BUSY: a {held.get('task')} run started at {held.get('at')} is still going; stop here.")
            return 3
    LOCK.write_text(json.dumps({'task': task, 'since': time.time(), 'at': datetime.now().isoformat(timespec='minutes')}))
    git('fetch', '-q', 'origin')
    git('reset', '-q', '--hard', 'origin/main')  # the worktree holds nothing but the last run's pushed work
    git('clean', '-q', '-fd', 'radar/data')
    print(f"READY at {git('rev-parse', '--short', 'HEAD').stdout.strip()} (origin/main)")
    return 0


def end():
    LOCK.unlink(missing_ok=True)
    print('Lock released.')
    return 0


def week_key(resets):
    """The reset hour identifies the week, rounded: the meter reports the same reset as 06:59:59.7 or 07:00:00."""
    t = datetime.fromisoformat(resets.replace('Z', '+00:00'))
    return (t + timedelta(minutes=30)).replace(minute=0, second=0, microsecond=0).strftime('%Y-%m-%dT%H')


def load_ledger():
    return json.loads(LEDGER.read_text()) if LEDGER.exists() else {}


def budget(weekly, five_hour, resets):
    ledger = load_ledger()
    used = ledger.get(week_key(resets), {}).get('used', 0.0)
    if used + RUN_FLOOR > BUDGET_SHARE:
        print(f'STOP: the catch-up has used {used:.1f}% of this week (limit {BUDGET_SHARE:.0f}%); next week resets {resets}.')
        return 2
    if weekly >= WEEKLY_MAX:
        print(f'STOP: the weekly allowance is at {weekly}%.')
        return 2
    if five_hour >= FIVE_HOUR_MAX:
        print(f'STOP: the 5-hour window is at {five_hour}%; leaving it for other work.')
        return 2
    print(f'GO: catch-up used {used:.1f}% of {BUDGET_SHARE:.0f}% this week; weekly {weekly}%, 5-hour {five_hour}%.')
    return 0


def record(before, after, resets, papers=0):
    ledger = load_ledger()
    week = ledger.setdefault(week_key(resets), {'used': 0.0, 'runs': []})
    cost = max(after - before, RUN_FLOOR)
    week['used'] = round(week['used'] + cost, 2)
    week['runs'].append({'at': datetime.now(timezone.utc).isoformat(timespec='minutes'), 'before': before, 'after': after,
                         'counted': cost, 'papers': papers})
    cl.CACHE.mkdir(exist_ok=True)
    LEDGER.write_text(json.dumps(ledger, indent=1))
    print(f"Recorded {cost:.1f}%: the catch-up has used {week['used']:.1f}% of {BUDGET_SHARE:.0f}% this week.")
    return 0


def publish(message):
    if not in_worktree():
        raise SystemExit(f'Run this from the routine worktree: cd {WORKTREE}')
    git('add', 'radar/data')
    if not git('diff', '--cached', '--quiet', check=False).returncode:
        print('Nothing to publish.')
        return 0
    git('commit', '-q', '-m', message)
    for attempt in range(3):
        push = git('-c', 'http.postBuffer=524288000', 'push', 'origin', 'HEAD:main', check=False)
        if push.returncode == 0:
            print(f"Pushed {git('rev-parse', '--short', 'HEAD').stdout.strip()} to main.")
            return 0
        git('fetch', '-q', 'origin')  # main moved (another routine): replay this commit on top and retry
        if git('rebase', '-q', 'origin/main', check=False).returncode:
            git('rebase', '--abort', check=False)
            print('FAILED: main changed radar/data in a way that conflicts; the commit stays in the worktree.')
            return 1
    print('FAILED: push refused three times:\n' + push.stderr[-500:])
    return 1


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('command', choices=['setup', 'begin', 'budget', 'record', 'publish', 'end'])
    ap.add_argument('--task', default='catchup')
    ap.add_argument('--weekly', type=float, help='weekly all-models meter, percent')
    ap.add_argument('--five-hour', type=float, default=0, help='5-hour meter, percent')
    ap.add_argument('--resets', help='when the weekly meter resets (ISO time)')
    ap.add_argument('--before', type=float)
    ap.add_argument('--after', type=float)
    ap.add_argument('--papers', type=int, default=0)
    ap.add_argument('-m', '--message')
    args = ap.parse_args(argv)
    if args.command == 'setup':
        return setup()
    if args.command == 'begin':
        return begin(args.task)
    if args.command == 'end':
        return end()
    if args.command == 'budget':
        return budget(args.weekly, args.five_hour, args.resets)
    if args.command == 'record':
        return record(args.before, args.after, args.resets, args.papers)
    return publish(args.message)


if __name__ == '__main__':
    sys.exit(main())
