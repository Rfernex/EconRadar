# EconRadar weekly update (for the scheduled Claude session)

Run every Tuesday morning, after NBER's Monday-evening release. You are the model that writes
the summaries: there is no API key. Work from the repository root:
`/Users/rfernex/Documents/Personal/Utile/apps/repository`. Keep token use low: read each file once,
do not re-read papers you already answered, and do not explore the code.

## 1. Collect

```
git pull --ff-only origin main
python3 tools/collect_literature.py --no-model
python3 tools/collect_focus.py --model-budget 0
```

If `git pull` fails because of local changes, stop and report: never stash, reset or commit
other files. If OpenAlex refuses (daily allowance), continue with what was collected.

## 2. Summarise

```
python3 tools/radar_batch.py status
python3 tools/radar_batch.py instructions > /tmp/econradar-instructions.txt
```

Read the instructions once. Then repeat, 25 papers at a time:

```
python3 tools/radar_batch.py export --n 25 --out /tmp/econradar-batch.md
# read the batch, write /tmp/econradar-answers.json: {"<id>": {question, contribution, ...}, ...}
python3 tools/radar_batch.py import --answers /tmp/econradar-answers.json
```

- Answer every paper in the batch, from its abstract and conclusion excerpt only. Leave a
  string empty rather than guess; never invent a result.
- `import` prints what it stored and what it rejected (with the reason). Fix rejected answers
  once by re-answering only those ids; if they fail again, move on.
- Stop when `status` shows `addedThisWeek: 0`, then continue with the backlog for at most
  **4 more batches** (100 papers). The backlog is summarised a little each week.
- The Focus area (`--area basic-income`) is summarised only on request.

## 3. Newsletter

```
python3 tools/newsletter.py build
```

Read the issue it wrote (`radar/data/newsletter/<today>.json`). Write `/tmp/econradar-texts.json`:

```
{"brief": "3-4 sentences: what stands out this week (papers, methods, a trend), plain and factual.",
 "families": {"labour": "1-2 sentences on this week's papers in that field", ...}}
```

Only for families with papers this week; only claims the issue's papers support. Then:

```
python3 tools/newsletter.py texts --texts /tmp/econradar-texts.json
python3 tools/newsletter.py send      # creates a DRAFT in Buttondown; you review and send it from Buttondown
```

If `send` says BUTTONDOWN_API_KEY is not set, skip it: the issue is still in the app.

## 4. Publish

```
python3 -m unittest discover -s radar/tests
git add radar/data
git commit -m "EconRadar: weekly update $(date +%Y-%m-%d)"
git push origin HEAD:main
```

Stage `radar/data` only, never other files. If tests fail, do not push: report the failure.

## 5. Report

One short message: papers added (journals / NBER), summaries written and rejected, backlog
left (`status`), newsletter draft created or skipped, and anything that failed.

## Catch-up (the backlog, on request)

To summarise a slice of the backlog in its own session ("summarise 500 EconRadar papers"):
pull as in step 1, read the instructions once, run step 2's loop **20 times** (500 papers,
newest published first; stop early if `export` writes 0 papers), then step 4 (tests, commit
`radar/data` as "EconRadar: summaries for <n> more papers", push). Report summaries written,
rejected, and what `status` says is left. Several such sessions can run one after another;
not in parallel, since each one rewrites the same data files.
