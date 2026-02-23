# Translation Tooling

Translates JSTorrent's Android strings by borrowing from open-source torrent clients
and filling gaps with LLM-generated translations.

## Prerequisites

Clone these repos into `~/code/reference/`:

```bash
git clone https://github.com/proninyaroslav/libretorrent ~/code/reference/libretorrent
git clone https://github.com/transmission/transmission ~/code/reference/transmission
git clone https://github.com/qbittorrent/qBittorrent ~/code/reference/qbittorrent
```

No Python dependencies beyond the standard library.

## How It Works

### Phase 1: Auto-match (free translations)

Our English strings are matched case-insensitively against English strings in three
open-source torrent clients. When there's an exact match, we grab their existing
human-verified translation. Priority order:

1. **LibreTorrent** (Android strings.xml, ~50 languages)
2. **Transmission** (Qt .ts files, ~35 languages)
3. **qBittorrent** (Qt .ts files, ~55 languages)

This currently covers ~97 of 282 translatable strings (34%) for top-tier languages.

To increase coverage, we adjusted some English strings to match the open-source wording
(e.g., "Done" -> "Finished", "Verify data" -> "Force recheck"). Only safe, semantically
equivalent changes.

### Phase 2: LLM translation (remaining strings)

For the ~185 strings with no open-source match, we generate structured prompts and
feed them to LLMs. The prompt includes reference translations from Phase 1 for
terminology consistency.

## Scripts

### translate.py — Generate translated strings.xml

The main generator. Pulls from all three sources and writes Android resource files.

```bash
# Single language
python3 translate.py de              # write values-de/strings.xml
python3 translate.py de --dry-run    # preview without writing

# All available languages (75 total)
python3 translate.py --all
python3 translate.py --all --dry-run

# Coverage summary table
python3 translate.py --summary
```

Output only includes strings that have a translation. Android falls back to
`values/strings.xml` (English) for anything missing.

### translate-analyse.py — Analyse against LibreTorrent

Single-source analysis tool for understanding LibreTorrent coverage.

```bash
python3 translate-analyse.py stats              # quick overview
python3 translate-analyse.py unmatched           # strings with no LT match
python3 translate-analyse.py unmatched -g        # grouped by prefix
python3 translate-analyse.py matched             # strings that do match
python3 translate-analyse.py lt-unmatched        # LT strings we don't use
python3 translate-analyse.py lt-unmatched -g     # grouped
python3 translate-analyse.py coverage            # per-language coverage
```

### translate-match.py — Cross-project matching

Find matches across all three projects (LibreTorrent + Transmission + qBittorrent).

```bash
python3 translate-match.py matches      # new matches from TX/qBT (default)
python3 translate-match.py unmatched    # strings with no match anywhere
python3 translate-match.py unmatched -g # grouped by prefix
python3 translate-match.py languages    # language overlap across all 3 projects
python3 translate-match.py summary      # counts only
```

### translate-prompt.py — Generate LLM prompts

Produces prompts for Claude, GPT, Gemini, etc. to translate remaining strings.

```bash
# Full prompt for a language
python3 translate-prompt.py de
python3 translate-prompt.py de --reference      # include matched strings as context

# Subset by group (useful for reviewing in batches)
python3 translate-prompt.py de --list-groups    # show groups and counts
python3 translate-prompt.py de --group dialog
python3 translate-prompt.py de --group settings,tab

# Redirect to file or clipboard
python3 translate-prompt.py de --reference > prompt-de.txt
python3 translate-prompt.py de | pbcopy

# Parse LLM JSON response back to strings.xml format
python3 translate-prompt.py parse response-de.json
```

The prompt instructs the LLM to return a JSON object (`{"string_id": "translation"}`).
The `parse` subcommand converts that JSON to Android XML.

## Workflow: Adding a New Language

```bash
# 1. Generate auto-matched translations
python3 translate.py de --dry-run       # review what we get for free

# 2. Generate the LLM prompt for remaining strings
python3 translate-prompt.py de --reference > prompt-de.txt

# 3. Feed prompt to multiple LLMs, save JSON responses
#    e.g., prompt-de-claude.json, prompt-de-gpt.json, prompt-de-gemini.json

# 4. Compare results, pick best translations, save final JSON
python3 translate-prompt.py parse response-de-final.json > /tmp/llm-de.xml

# 5. Generate the full strings.xml (auto-matched + LLM)
#    Add LLM translations to MANUAL_TRANSLATIONS in translate.py, then:
python3 translate.py de

# 6. Test in app
#    Change device language to German, verify UI
```

## Tier 1 Languages

`tier1-languages.txt` lists the 18 languages we prioritize for full LLM translation.
Selected for: large speaker population, strong torrent user base, and high confidence
in LLM translation quality.

## Key Design Decisions

- **Exact match only.** No fuzzy/semantic matching — too risky for UI strings where
  "Open folder" vs "Go to folder" translate differently.
- **Open-source first.** Human-verified translations from established projects are
  always preferred over LLM output.
- **Partial is fine.** Android resource fallback means shipping 34% translated is
  better than shipping 0%. Users see their language where available, English elsewhere.
- **Reproducible.** Running `translate.py --all` is idempotent and deterministic.
  The LLM prompt workflow produces diffable JSON for review.
