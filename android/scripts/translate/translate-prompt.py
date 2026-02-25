#!/usr/bin/env python3
"""
Generate a structured LLM prompt for translating JSTorrent's unmatched strings.

Produces a self-contained prompt that can be pasted into any LLM (Claude, GPT, Gemini, etc.)
and returns results in a parseable format for comparison.

Usage:
    python translate-prompt.py de                    # full prompt for German
    python translate-prompt.py de --group settings    # only settings strings
    python translate-prompt.py de --group dialog,tab  # multiple groups
    python translate-prompt.py de --list-groups       # show available groups
    python translate-prompt.py de --reference         # include already-translated strings as context
    python translate-prompt.py de --diff              # only strings not already in claude/<lang>.json
    python translate-prompt.py de --diff --reference  # diff mode with open-source + existing LLM context

Output goes to stdout. Redirect or pipe as needed:
    python translate-prompt.py de > prompt-de.txt
    python translate-prompt.py de | pbcopy
"""

import argparse
import json
from pathlib import Path

from translate_common import (
    JSTORRENT_STRINGS, LIBRETORRENT_EN, LIBRETORRENT_DIR,
    TRANSMISSION_EN, LANG_NAMES, SKIP_IDS, MANUAL_ID_MAP,
    parse_android, build_reverse, parse_qt_sources, get_qb_sources,
    load_tx_translations, load_qb_translations,
)

SCRIPT_DIR = Path(__file__).parent
CLAUDE_DIR = SCRIPT_DIR / "claude"


def get_unmatched(jst_en, lang_code=None):
    """Return dict of strings that have no auto-match in any source.

    If lang_code is provided, also includes strings that match in English but
    have no actual translation available for that language (coverage gaps).
    """
    lt_en = parse_android(LIBRETORRENT_EN)
    lt_reverse = build_reverse(lt_en)
    tx_sources = parse_qt_sources(TRANSMISSION_EN)
    qb_sources = get_qb_sources()

    # If lang_code given, load actual translations to detect coverage gaps
    if lang_code:
        lt_translated = parse_android(LIBRETORRENT_DIR / f"values-{lang_code}" / "strings.xml")
        tx_translated = load_tx_translations(lang_code)
        qb_translated = load_qb_translations(lang_code)
    else:
        lt_translated = tx_translated = qb_translated = None

    unmatched = {}
    for name, text in jst_en.items():
        if name in SKIP_IDS:
            continue
        key = text.strip().lower()

        # Manual ID map — check if translation exists for this language
        if name in MANUAL_ID_MAP:
            if lang_code:
                lt_id = MANUAL_ID_MAP[name]
                if lt_id not in lt_translated:
                    unmatched[name] = text
            continue

        has_source = key in lt_reverse or key in tx_sources or key in qb_sources

        if not has_source:
            unmatched[name] = text
        elif lang_code:
            # Source exists in English, but check if translation is available
            found = False
            if key in lt_reverse:
                for lt_id in lt_reverse[key]:
                    if lt_id in lt_translated:
                        found = True
                        break
            if not found and key in tx_translated:
                found = True
            if not found and key in qb_translated:
                found = True
            if not found:
                unmatched[name] = text

    return unmatched


def get_matched_translations(jst_en, lang_code):
    """Return dict of name -> (en_text, translation) for strings that ARE auto-matched."""
    lt_en = parse_android(LIBRETORRENT_EN)
    lt_reverse = build_reverse(lt_en)
    tx_sources = parse_qt_sources(TRANSMISSION_EN)
    qb_sources = get_qb_sources()

    lt_translated = parse_android(LIBRETORRENT_DIR / f"values-{lang_code}" / "strings.xml")
    tx_translated = load_tx_translations(lang_code)
    qb_translated = load_qb_translations(lang_code)

    matched = {}
    for name, text in jst_en.items():
        if name in SKIP_IDS:
            continue
        key = text.strip().lower()

        # Manual ID map
        if name in MANUAL_ID_MAP:
            lt_id = MANUAL_ID_MAP[name]
            if lt_id in lt_translated:
                matched[name] = (text, lt_translated[lt_id])
            continue

        # LT auto
        if key in lt_reverse:
            for lt_id in lt_reverse[key]:
                if lt_id in lt_translated:
                    matched[name] = (text, lt_translated[lt_id])
                    break
            if name in matched:
                continue

        # TX auto
        if key in tx_translated:
            matched[name] = (text, tx_translated[key])
            continue

        # qBT auto
        if key in qb_translated:
            matched[name] = (text, qb_translated[key])

    return matched


def load_existing_llm(lang_code):
    """Load existing LLM translations from claude/<lang>.json. Returns dict or {}."""
    json_path = CLAUDE_DIR / f"{lang_code}.json"
    if not json_path.exists():
        return {}
    with open(json_path) as f:
        return json.load(f)


def get_diff_strings(unmatched, lang_code):
    """Return only unmatched strings not already in claude/<lang>.json."""
    existing = load_existing_llm(lang_code)
    return {k: v for k, v in unmatched.items() if k not in existing}


def group_strings(strings):
    """Group strings by their name prefix (first segment before _)."""
    groups = {}
    for name, text in strings.items():
        prefix = name.split("_")[0] if "_" in name else "other"
        groups.setdefault(prefix, []).append((name, text))
    for g in groups.values():
        g.sort()
    return groups


def generate_prompt(lang_code, unmatched_strings, reference_translations=None,
                    existing_llm_translations=None, jst_en=None):
    """Generate the LLM translation prompt.

    Args:
        existing_llm_translations: dict of name -> translation from previous LLM runs.
            Included as context for terminology consistency in diff mode.
        jst_en: dict of name -> English text (used to show English alongside existing translations).
    """
    lang_name = LANG_NAMES.get(lang_code, lang_code)

    lines = []
    lines.append(f"Translate the following Android UI strings from English to {lang_name}.")
    lines.append("")
    lines.append("Context: These are from JSTorrent, a BitTorrent client for Android. "
                 "The strings are used in the app's UI — buttons, labels, descriptions, "
                 "dialog messages, settings screens, status indicators, and tooltips.")
    lines.append("")
    lines.append("Rules:")
    lines.append("- Keep translations concise — these appear in mobile UI with limited space")
    lines.append("- Preserve all format specifiers exactly: %1$s, %1$d, %2$d, etc.")
    lines.append("- Preserve all escape sequences exactly as shown (e.g. \\n, \\u2022)")
    lines.append("- Use plain apostrophes (') not escaped (\\')")
    lines.append("- Do NOT translate: 'JSTorrent', 'DHT', 'UPnP', 'SOCKS5', 'PEX', 'WiFi', 'VPN', 'ETA'")
    lines.append("- Use standard Android/torrent terminology for the target language")
    lines.append("- The string ID (e.g. settings_power_keep_seeding_label) gives context about where it appears")
    lines.append("")

    if reference_translations:
        lines.append(f"Reference: Here are strings already translated to {lang_name} (from open-source torrent clients).")
        lines.append("Use these for terminology consistency:")
        lines.append("")
        for name, (en, tr) in sorted(reference_translations.items()):
            lines.append(f"  {name}: \"{en}\" -> \"{tr}\"")
        lines.append("")

    if existing_llm_translations:
        lines.append(f"Previously translated: Here are strings already translated to {lang_name} in prior runs.")
        lines.append("Use these for terminology and style consistency (do NOT re-translate these):")
        lines.append("")
        for name, tr in sorted(existing_llm_translations.items()):
            en_text = jst_en.get(name, "") if jst_en else ""
            if en_text:
                lines.append(f"  {name}: \"{en_text}\" -> \"{tr}\"")
            else:
                lines.append(f"  {name}: \"{tr}\"")
        lines.append("")

    lines.append("Output format: Return ONLY a JSON object mapping string ID to translation.")
    lines.append("No commentary, no markdown fences, just the JSON. Example:")
    lines.append("")
    lines.append('{')
    lines.append(f'  "example_string": "translated text in {lang_name}"')
    lines.append('}')
    lines.append("")
    lines.append(f"Strings to translate ({len(unmatched_strings)} total):")
    lines.append("")

    groups = group_strings(unmatched_strings)
    for prefix, items in sorted(groups.items()):
        lines.append(f"  # {prefix} ({len(items)} strings)")
        for name, text in items:
            lines.append(f'  {name}: "{text}"')
        lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Generate LLM translation prompts")
    parser.add_argument("lang", help="Language code (e.g. de)")
    parser.add_argument("--group", help="Comma-separated groups to include (e.g. settings,dialog)")
    parser.add_argument("--list-groups", action="store_true", help="List available string groups")
    parser.add_argument("--reference", action="store_true", help="Include already-translated strings as context")
    parser.add_argument("--diff", action="store_true",
                        help="Only include strings not already in claude/<lang>.json")

    args = parser.parse_args()

    jst_en = parse_android(JSTORRENT_STRINGS)

    if args.list_groups:
        unmatched = get_unmatched(jst_en)  # no lang_code for listing
        groups = group_strings(unmatched)
        for prefix, items in sorted(groups.items()):
            print(f"{prefix}: {len(items)} strings")
        print(f"\nTotal: {len(unmatched)} unmatched strings")
        return

    # Pass lang_code so coverage gaps (matched in English but no translation) are included
    unmatched = get_unmatched(jst_en, lang_code=args.lang)

    # In diff mode, load existing LLM translations for context and filter
    existing_llm = None
    if args.diff:
        all_existing = load_existing_llm(args.lang)
        # Only keep existing translations for strings that are still unmatched
        # (some may have gained open-source matches since last run)
        existing_llm = {k: v for k, v in all_existing.items() if k in unmatched}
        unmatched = get_diff_strings(unmatched, args.lang)
        if not unmatched:
            import sys
            print(f"No new strings to translate for {args.lang} "
                  f"(all {len(existing_llm)} unmatched strings already in claude/{args.lang}.json)",
                  file=sys.stderr)
            return

    # Filter by groups if specified
    if args.group:
        selected = set(args.group.split(","))
        filtered = {}
        for name, text in unmatched.items():
            prefix = name.split("_")[0] if "_" in name else "other"
            if prefix in selected:
                filtered[name] = text
        unmatched = filtered

    reference = None
    if args.reference:
        reference = get_matched_translations(jst_en, args.lang)

    prompt = generate_prompt(args.lang, unmatched, reference, existing_llm, jst_en)
    print(prompt)


if __name__ == "__main__":
    main()
