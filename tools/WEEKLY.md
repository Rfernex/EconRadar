# EconRadar scheduled runs (for the Claude sessions that run them)

You are the model that writes the summaries: there is no API key. Two scheduled tasks use this
file: the **weekly update** (Tuesday morning, after NBER's Monday-evening release) and the
**catch-up** (several times a day until the backlog is done). Keep token use low: read each file
once, do not re-read papers you already answered, and do not explore the code.

Work in the routine's own checkout, never in the owner's:

```
cd /Users/rfernex/Documents/Personal/Utile/apps/econradar-routine
```

(If it does not exist: `cd /Users/rfernex/Documents/Personal/Utile/apps/repository && python3 tools/radar_routine.py setup`, then cd as above.)
Every run starts with `begin` and ends with `end`, even when a step fails:

```
python3 tools/radar_routine.py begin --task weekly     # or --task catchup
...
python3 tools/radar_routine.py end
```

If `begin` prints BUSY, another run is going: stop, without running `end`. `begin` resets this
checkout to origin/main; it holds nothing else. The tools read and write the private store in
`.radar-cache/store` (abstracts included, never published) and refresh `radar/data`, the app's copy:
only model-summarised papers, without abstracts. `publish` commits that copy.

## Weekly update

### 1. Collect

```
python3 tools/collect_literature.py --no-model
python3 tools/collect_focus.py --model-budget 0
```

If OpenAlex refuses (daily allowance), continue with what was collected.

### 2. Summarise

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
- Write in your own words: what you write is published, the abstract is not. `import` rejects
  an answer that copies 12 or more consecutive words from the abstract or conclusion.
- `import` prints what it stored and what it rejected (with the reason). Fix rejected answers
  once by re-answering only those ids; if they fail again, move on.
- Stop when `status` shows `addedThisWeek: 0`. The backlog is the catch-up's job.
- The Focus area (`--area basic-income`) is summarised only on request.

### 3. Readers' flags (report only)

```
python3 tools/radar_flags.py list
```

For each open flag, write in your report: the flag id, the paper, the reader's note, and whether the note
is right according to the abstract, with the correction you would make. **Change nothing**: the
owner decides each flag later. If `ECONRADAR_FLAGS_CSV` is not set, skip this step.

### 4. Publish

```
python3 -m unittest discover -s radar/tests
python3 tools/radar_routine.py publish -m "EconRadar: weekly update $(date +%Y-%m-%d)"
python3 tools/radar_routine.py end
```

If tests fail, do not publish: run `end` and report the failure.

### 5. Report

One short message: papers added (journals / NBER), summaries written and rejected, backlog left
(`status`), open readers' flags (step 3), and anything that failed.

## Catch-up (the backlog, 250 papers per run)

The catch-up may use at most **25% of the weekly plan allowance**. The plan meters come from the
Claude app's usage tool (`mcp__ccd_session_mgmt__get_usage`; load it with ToolSearch if needed):
`Weekly · all models` percent and reset time, and the `5-hour limit` percent. If you cannot read
them, do not summarise anything: report that and stop.

1. `begin --task catchup` (above).
2. Read the meters, then:
   ```
   python3 tools/radar_routine.py budget --weekly <weekly %> --five-hour <5-hour %> --resets <weekly resetsAt>
   ```
   If it prints STOP: run `end` and report its line. Nothing else.
3. Read the instructions once (`radar_batch.py instructions`), then run the Weekly step 2 loop
   **10 times** (250 papers, newest published first; stop early if `export` writes 0 papers).
4. Tests, then `publish -m "EconRadar: summaries for <n> more papers"`.
5. Read the weekly meter again, then record the run:
   ```
   python3 tools/radar_routine.py record --before <weekly % at step 2> --after <weekly % now> --resets <resetsAt> --papers <n>
   ```
6. `end`. Report in one line: summaries stored and rejected, `status` left, the budget line.

Never run two catch-ups at once: they rewrite the same data files (`begin` enforces this).
