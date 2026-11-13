# EconRadar

Every paper since 2020 from 20 leading economics journals and NBER, updated weekly, summarised by Claude, tagged, mapped, and recapped in a weekly newsletter. Installable like the other apps; it works offline with the last papers it loaded.

## What it does

The app is read-only for visitors: they browse, filter, save papers on their own device and subscribe to the newsletter. All collecting and summarising happens in the weekly update.

- **Latest**: every new paper with its research question, a 2–3 sentence summary, what the conclusion says (when an open-access copy could be read), and tags for field, method, data, topics. Papers new since your last visit are marked. Save, mark read, add a private note, export BibTeX / RIS / CSV.
- **Network**, three lenses on whatever the filters select:
  - *Strands*: fields, methods, data sources and topics linked whenever they meet in a paper. Size is popularity. Dashed ink links and ringed nodes are new, so you can see which methods a literature is starting to use and on what data.
  - *Papers*: each paper linked to its nearest neighbours, matched on what you choose: topic and literature, methodological approach, identification strategy, data, authors, or everything. Clicking a paper shows what it shares with each neighbour.
  - *Authors*: who publishes in which field and with whom.
  - **Replay history** rebuilds the network week by week by publication date. Click a node, then one of its ties, to list the papers that combine the two.
- **Newsletter**: the weekly two-page issue (page 2 for the fields you pick) and the subscribe form.
- **Authors**: who is active in what (heat map by field family), sortable by output, recent activity or name; profiles with field/method mix, co-authors and papers. Follow authors to have their new papers flagged.
- **Trends**: papers per quarter or month by field family; methods, data, topics or fields over time (share of papers, small multiples); what is rising or fading (last 90 days against before); a **frontier log** of firsts (the first time a method or data source shows up in a field since the radar started); the latest research questions.
- **Filters** (shared by every view): text search, publication date (presets or a range; NBER papers carry the day NBER released them), field or field family, method, data, source (journal or NBER), author, saved, unread, followed authors, model-summarised only. On Latest, the update chips show what one collection added.

## Where the papers come from

The corpus is every article published since January 2020 in 20 leading economics journals (the top five, JEEA, EJ, REStat, AER: Insights, the four AEJs, JOLE, JPubE, JDE, JME, JIE, RAND and the Journal of Econometrics) and every NBER working paper since 2020.

1. **OpenAlex** lists the journal articles (authors with stable ids, institutions, abstracts). **NBER** papers come from NBER's own listing and paper pages, each dated to its release day; OpenAlex adds author ids.
2. Missing abstracts come from **Crossref** and **Semantic Scholar**. For new papers, a legal open-access PDF's conclusion is read and kept on the Mac (`.radar-cache/`, never published) until the paper is summarised.
3. **Claude** writes each paper's question, contribution, summary, conclusion, identification and tags in a working session (no API key), validated against the lists in `config.json`. Until then keyword rules tag the paper ("auto-extracted").
4. Papers are stored by publication year: `data/papers-YYYY.json` (one paper per line, loaded newest year first) and `data/abstracts-YYYY.json` (fetched when a paper is opened); `data/index.json` lists the years and the run log. Nothing is removed unless its journal leaves the list.

### The weekly update

A scheduled task in the Claude desktop app (**EconRadar weekly update**, Tuesdays at 08:30, after NBER's Monday release) follows [`tools/WEEKLY.md`](../tools/WEEKLY.md): collect, summarise the week's papers plus up to 100 from the backlog, build the newsletter, run the tests, push `radar/data`. It runs only while the Mac is awake and the app open (a missed run starts at the next launch). The GitHub workflow is kept for manual collection only.

Summaries by hand (a catch-up, or the backlog):

```
python3 tools/radar_batch.py status
python3 tools/radar_batch.py instructions          # once per session
python3 tools/radar_batch.py export --n 25 --out /tmp/batch.md
python3 tools/radar_batch.py import --answers /tmp/answers.json --by claude-sonnet-5-5
```

### The newsletter

`tools/newsletter.py` builds each week's issue (`data/newsletter/<date>.json`, shown in the app's **Newsletter** tab) from the papers the week added: page 1 for everyone (highlights, methods and identification strategies, three-month trends), page 2 per field family (key papers, venue, contribution, the earlier papers they relate to, active authors). Subscribers pick field families on the signup form; they become Buttondown tags, and the email shows each subscriber only their fields' sections (none picked: all).

Setup, once: create a Buttondown account, put its username in `config.json` → `newsletter.buttondown` (the subscribe form appears), and make `BUTTONDOWN_API_KEY` available to the scheduled task (e.g. in `~/.zshenv`). The routine only creates drafts; review and send them from Buttondown (`newsletter.py send --publish` sends directly). Tags may need a paid Buttondown plan; without them everyone gets every section.

### Running it by hand

```
python3 tools/collect_literature.py --no-model                       # new papers (60-day window)
python3 tools/collect_literature.py --no-model --since 2020-01-01 --max-pdfs 0   # rebuild
python3 tools/newsletter.py build && python3 tools/newsletter.py render
```

Needs Python 3.12 and `pip install pypdf` for conclusions.

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
