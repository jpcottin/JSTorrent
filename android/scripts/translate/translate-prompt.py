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

Output goes to stdout. Redirect or pipe as needed:
    python translate-prompt.py de > prompt-de.txt
    python translate-prompt.py de | pbcopy
"""

import argparse

from translate_common import (
    JSTORRENT_STRINGS, LIBRETORRENT_EN, LIBRETORRENT_DIR,
    TRANSMISSION_EN, LANG_NAMES, SKIP_IDS, MANUAL_ID_MAP,
    parse_android, build_reverse, parse_qt_sources, get_qb_sources,
    load_tx_translations, load_qb_translations,
)


def get_unmatched(jst_en):
    """Return dict of strings that have no auto-match in any source."""
    lt_en = parse_android(LIBRETORRENT_EN)
    lt_reverse = build_reverse(lt_en)
    tx_sources = parse_qt_sources(TRANSMISSION_EN)
    qb_sources = get_qb_sources()

    unmatched = {}
    for name, text in jst_en.items():
        if name in SKIP_IDS:
            continue
        if name in MANUAL_ID_MAP:
            continue
        key = text.strip().lower()
        if key not in lt_reverse and key not in tx_sources and key not in qb_sources:
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


def group_strings(strings):
    """Group strings by their name prefix (first segment before _)."""
    groups = {}
    for name, text in strings.items():
        prefix = name.split("_")[0] if "_" in name else "other"
        groups.setdefault(prefix, []).append((name, text))
    for g in groups.values():
        g.sort()
    return groups


def generate_prompt(lang_code, unmatched_strings, reference_translations=None):
    """Generate the LLM translation prompt."""
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

    args = parser.parse_args()

    jst_en = parse_android(JSTORRENT_STRINGS)
    unmatched = get_unmatched(jst_en)

    if args.list_groups:
        groups = group_strings(unmatched)
        for prefix, items in sorted(groups.items()):
            print(f"{prefix}: {len(items)} strings")
        print(f"\nTotal: {len(unmatched)} unmatched strings")
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

    prompt = generate_prompt(args.lang, unmatched, reference)
    print(prompt)


if __name__ == "__main__":
    main()
