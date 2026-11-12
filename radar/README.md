# EconRadar

New papers from the top economics journals and NBER working papers (and a few journals beyond economics), collected twice a week, summarised, tagged and mapped. Installable like the other apps; it works offline with the last papers it loaded.

## What it does

- **Latest**: every new paper with its research question, a 2–3 sentence summary, what the conclusion says (when an open-access copy could be read), and tags for field, method, data, topics. Papers new since your last visit are marked. Save, mark read, add a private note, export BibTeX / RIS / CSV.
- **Network**, three lenses on whatever the filters select:
  - *Strands*: fields, methods, data sources and topics linked whenever they meet in a paper. Size is popularity. Dashed ink links and ringed nodes are new, so you can see which methods a literature is starting to use and on what data.
  - *Papers*: each paper linked to its nearest neighbours (shared authors and topics count most), so clusters are strands of research.
  - *Authors*: who publishes in which field and with whom.
  - **Replay history** rebuilds the network week by week by publication date. Click a node, then one of its ties, to list the papers that combine the two.
- **Authors**: who is active in what (heat map by field family), sortable by output, recent activity or name; profiles with field/method mix, co-authors and papers. Follow authors to have their new papers flagged.
- **Trends**: papers per quarter or month by field family; methods, data, topics or fields over time (share of papers, small multiples); what is rising or fading (last 90 days against before); a **frontier log** of firsts (the first time a method or data source shows up in a field since the radar started); the latest research questions.
- **Filters** (shared by every view): text search, publication date (presets or a range; NBER papers carry the day NBER released them), field or field family, method, data, source (journal or NBER), author, saved, unread, followed authors, model-summarised only. On Latest, the update chips show what one collection added.

## Where the papers come from

`tools/collect_literature.py` runs from `.github/workflows/literature-radar.yml` every Tuesday and Friday at 05:23 UTC (NBER releases its new working papers on Monday evenings, so they arrive the next morning):

1. **OpenAlex** lists articles in the journals of `config.json` published in the last 60 days and not yet stored (authors with stable ids, institutions, abstracts). **NBER** working papers come from NBER's own listing and paper pages: the day NBER released each one, its full abstract and authors, and its open PDF. OpenAlex misfiles some NBER papers and dates them to a month, so it only adds author ids and institutions, now or on a later run once it has the paper (`"listing": "nber"` in `config.json`).
2. Missing abstracts come from **Crossref** and **Semantic Scholar**. When a legal open-access PDF exists (arXiv, repositories, open publisher copies), its conclusion section is extracted. Publishers that block scripts (Wiley, OUP, ScienceDirect, SSRN…) are skipped, never worked around.
3. `tools/radar_enrich.py` writes the question, summary, conclusion, identification strategy, data description, and tags (fields, methods, data types, topics, geography, period, JEL) with **Claude** (`ANTHROPIC_API_KEY`) or **OpenRouter** free models (`OPENROUTER_API_KEY`), validated against the lists in `config.json`. Without a key, keyword rules tag the paper (marked “auto-extracted”); each later run upgrades up to 60 of those once a key exists.
4. Papers are appended to `data/papers-YYYY-MM.json` (by month added) and `data/index.json` keeps the shard list and the run log. Nothing is ever removed, so the network and trends grow over time. Abstracts are kept as excerpts of at most 180 words with a link to the article; PDF text is never stored.

### Setup (GitHub → Settings → Secrets and variables → Actions)

| Name | Kind | What for |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | Model summaries with Claude (recommended). |
| `OPENROUTER_API_KEY` | secret | Alternative: OpenRouter's free models, used only when there is no Anthropic key. About 50 summaries a day (1,000 once $10 of credit has ever been bought): each run summarises its new papers first, and stops calling once the day's allowance is used. Free endpoints must be allowed at openrouter.ai/settings/privacy. The collector ranks the live free-model list (models that enforce JSON first), moves to the next model when an answer is unusable, and stops for the run after 5 papers in a row fail, to save the allowance. `RADAR_OPENROUTER_MODEL` pins one model. When an Anthropic key is added later, Claude redoes these summaries after the rule-tagged ones. |
| `OPENALEX_API_KEY` | secret | Optional, free from openalex.org/settings/api. Without it the collector shares OpenAlex's small keyless daily budget with every GitHub runner on the same IP. |
| `RADAR_MODEL` | variable | Claude model; default `claude-opus-5-5`. `claude-haiku-5-5` costs about 1/40th. |

**Cost** with Claude Opus 5.5 at low effort: roughly 3–4 cents a paper, so about 60 papers a week ≈ $2/week. Re-summarising the ~1,400 seeded papers once ≈ $40–50 (Haiku 5.5: about $1). Start that catch-up from **Actions → EconRadar → Run workflow** with “papers to re-summarise” = 1500. A run stops starting new summaries after 80 minutes (`--time-budget`) and saves what it has; the rest wait for the next run. A new Anthropic account has low rate limits, so expect to start it two or three times.

### Running it by hand

```
python3 tools/collect_literature.py                    # new papers in the 60-day window
python3 tools/collect_literature.py --since 2026-05-01 # backfill
python3 tools/collect_literature.py --reenrich 200     # upgrade rule-tagged papers (needs a key)
python3 tools/collect_literature.py --dry-run --limit 5
python3 tools/collect_literature.py --redate-nber      # stored NBER papers: release day from NBER's pages
```

Needs Python 3.12; `pip install pypdf` for conclusions and `pip install anthropic` for Claude.

### Adding a journal or a field

Append to `journals` in `config.json` with its OpenAlex source id (`https://api.openalex.org/sources/issn:XXXX-XXXX` returns it), a `group` (`general`, `field`, `beyond`) and default `fields`. Set `enabled: false` to pause one; its papers stay. Fields, methods and data types are also defined there (each with the regular expression the rules use); the model only ever chooses among them. Fields roll up into eight families, which take the eight colours of the network and charts.

## Focus areas (personal)

`radar/focus.json` defines literatures followed in depth, beyond the radar's journals: today *Basic income, cash transfers & wealth taxation*, every paper since January 2015 in any journal, working-paper series or book that OpenAlex indexes (about 7,500 papers, with the citations between them). The **Focus** tab shows it: what is new, the most cited papers within the literature, papers per year by strand, which outcomes each strand studies, a citation map that grows year by year, the authors, and for each paper what it builds on, who cites it and which papers share its references. By default it hides unindexed venues (switch on *All venues* to see everything).

The tab appears only on devices where it was switched on: open `…/radar/#focus` once in that browser (*Hide it on this device* at the bottom of the tab undoes it). Nothing else links to it, but the data files are public like the rest of the site, so this keeps it out of view without making it private.

`tools/collect_focus.py` runs after the radar's collector. Each strand is a set of OpenAlex searches (quoted phrases in titles, or titles and abstracts) confirmed by a regular expression; an optional `exclude` pattern drops other senses of a phrase. A strand is read in full once, then each run asks for the last 120 days, and every 30 days a full pass refreshes citation counts. Duplicate records (a working paper and its journal version, a preprint posted twice) are merged into the journal version. Editing a pattern re-tags the stored papers on the next run, and papers that no longer match a title-only strand leave. Searches cost ten ordinary OpenAlex requests: without `OPENALEX_API_KEY` a run makes at most 30 (about 100 a day are shared by everyone on the runner's IP), with a key 60. With `ANTHROPIC_API_KEY`, Claude summarises up to 40 focus papers a run, newest first; free OpenRouter models are kept for the radar's own new papers.

Files: `data/focus-<area>.json` (papers, loaded first), `data/focus-<area>-abstracts.json` (loaded in the background), `data/focus-<area>-refs.json` (every paper's references, for the collector only).

```
python3 tools/collect_focus.py                 # update every area
python3 tools/collect_focus.py --budget 60     # more searches (with an OpenAlex key)
```

## Personal data

Saved papers, read marks, notes, followed authors and the date of your last visit live in this browser's `localStorage` only. **Sources → Save a backup** downloads them as JSON; **Restore a backup** loads them on another device.

## Checks

```
node --test radar/tests/
python3 -m unittest discover -s radar/tests
```

`tools/render_radar_icon.py` redraws `icon.svg` and the PNG icons. When app files change, bump `?v=` in `index.html` and the cache name in `sw.js`. The vendored `vendor/d3.min.js` is d3 v7.9.0 (ISC licence, `vendor/D3-LICENSE`).
