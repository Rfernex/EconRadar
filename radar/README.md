# Literature Radar

New papers from the top economics journals (and a few beyond economics), collected twice a week, summarised, tagged and mapped. Installable like the other apps; it works offline with the last papers it loaded.

## What it does

- **Latest**: every new paper with its research question, a 2–3 sentence summary, what the conclusion says (when an open-access copy could be read), and tags for field, method, data, topics. Papers new since your last visit are marked. Save, mark read, add a private note, export BibTeX / RIS / CSV.
- **Network**, three lenses on whatever the filters select:
  - *Strands*: fields, methods, data sources and topics linked whenever they meet in a paper. Size is popularity. Dashed ink links and ringed nodes are new, so you can see which methods a literature is starting to use and on what data.
  - *Papers*: each paper linked to its nearest neighbours (shared authors and topics count most), so clusters are strands of research.
  - *Authors*: who publishes in which field and with whom.
  - **Replay history** rebuilds the network week by week by publication date. Click a node, then one of its ties, to list the papers that combine the two.
- **Authors**: who is active in what (heat map by field family), sortable by output, recent activity or name; profiles with field/method mix, co-authors and papers. Follow authors to have their new papers flagged.
- **Trends**: papers per quarter or month by field family; methods, data, topics or fields over time (share of papers, small multiples); what is rising or fading (last 90 days against before); a **frontier log** of firsts (the first time a method or data source shows up in a field since the radar started); the latest research questions.
- **Filters** (shared by every view): text search, date added, field or field family, method, data, journal, author, saved, unread, followed authors, model-summarised only.

## Where the papers come from

`tools/collect_literature.py` runs from `.github/workflows/literature-radar.yml` every Monday and Thursday at 05:23 UTC:

1. **OpenAlex** lists articles in the journals of `config.json` published in the last 60 days that are not yet stored (authors with stable ids, institutions, abstracts).
2. Missing abstracts come from **Crossref** and **Semantic Scholar**. When a legal open-access PDF exists (arXiv, repositories, open publisher copies), its conclusion section is extracted. Publishers that block scripts (Wiley, OUP, ScienceDirect, SSRN…) are skipped, never worked around.
3. `tools/radar_enrich.py` writes the question, summary, conclusion, identification strategy, data description, and tags (fields, methods, data types, topics, geography, period, JEL) with **Claude** (`ANTHROPIC_API_KEY`) or **OpenRouter** free models (`OPENROUTER_API_KEY`), validated against the lists in `config.json`. Without a key, keyword rules tag the paper (marked “auto-extracted”); each later run upgrades up to 60 of those once a key exists.
4. Papers are appended to `data/papers-YYYY-MM.json` (by month added) and `data/index.json` keeps the shard list and the run log. Nothing is ever removed, so the network and trends grow over time. Abstracts are kept as excerpts of at most 180 words with a link to the article; PDF text is never stored.

### Setup (GitHub → Settings → Secrets and variables → Actions)

| Name | Kind | What for |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | Model summaries with Claude (recommended). |
| `OPENROUTER_API_KEY` | secret | Alternative: OpenRouter's free models (rate-limited; used only if no Anthropic key). |
| `OPENALEX_API_KEY` | secret | Optional, free from openalex.org/settings/api. Without it the collector shares OpenAlex's small keyless daily budget with every GitHub runner on the same IP. |
| `RADAR_MODEL` | variable | Claude model; default `claude-opus-5-5`. `claude-haiku-5-5` costs about 1/40th. |

**Cost** with Claude Opus 5.5 at low effort: roughly 3–4 cents a paper, so about 60 papers a week ≈ $2/week. Re-summarising the ~1,400 seeded papers once ≈ $40–50 (Haiku 5.5: about $1). Start that catch-up from **Actions → Literature Radar → Run workflow** with “papers to re-summarise” = 1500. A run stops starting new summaries after 80 minutes (`--time-budget`) and saves what it has; the rest wait for the next run. A new Anthropic account has low rate limits, so expect to start it two or three times.

### Running it by hand

```
python3 tools/collect_literature.py                    # new papers in the 60-day window
python3 tools/collect_literature.py --since 2026-05-01 # backfill
python3 tools/collect_literature.py --reenrich 200     # upgrade rule-tagged papers (needs a key)
python3 tools/collect_literature.py --dry-run --limit 5
```

Needs Python 3.12; `pip install pypdf` for conclusions and `pip install anthropic` for Claude.

### Adding a journal or a field

Append to `journals` in `config.json` with its OpenAlex source id (`https://api.openalex.org/sources/issn:XXXX-XXXX` returns it), a `group` (`general`, `field`, `beyond`) and default `fields`. Set `enabled: false` to pause one; its papers stay. Fields, methods and data types are also defined there (each with the regular expression the rules use); the model only ever chooses among them. Fields roll up into eight families, which take the eight colours of the network and charts.

## Personal data

Saved papers, read marks, notes, followed authors and the date of your last visit live in this browser's `localStorage` only. **Sources → Save a backup** downloads them as JSON; **Restore a backup** loads them on another device.

## Checks

```
node --test radar/tests/
python3 -m unittest discover -s radar/tests
```

`tools/render_radar_icon.py` redraws `icon.svg` and the PNG icons. When app files change, bump `?v=` in `index.html` and the cache name in `sw.js`. The vendored `vendor/d3.min.js` is d3 v7.9.0 (ISC licence, `vendor/D3-LICENSE`).
