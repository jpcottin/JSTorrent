#!/usr/bin/env python3
"""
Generate translated Android strings.xml files using open-source torrent clients as sources.

Sources (checked in priority order):
  1. MANUAL_TRANSLATIONS - per-language overrides
  2. MANUAL_ID_MAP - JSTorrent ID -> LibreTorrent ID (different English, same meaning)
  3. LibreTorrent - exact English text match (Android strings.xml)
  4. Transmission - exact English text match (Qt .ts files)
  5. qBittorrent - exact English text match (Qt .ts files)

Only strings with a translation are emitted. Untranslated strings are omitted from output.

Usage:
    python translate.py de                 # generate German, write to values-de/strings.xml
    python translate.py de --dry-run       # preview without writing
    python translate.py --all              # generate tier 1 languages
    python translate.py --all --dry-run    # preview tier 1 languages
    python translate.py --all-sources      # generate ALL available languages (not just tier 1)
    python translate.py --summary          # coverage table across all available languages

Reference repos expected at:
    ~/code/reference/libretorrent/
    ~/code/reference/transmission/
    ~/code/reference/qbittorrent/
"""

import argparse

from translate_common import (
    ANDROID_RES, JSTORRENT_STRINGS, LIBRETORRENT_EN, SKIP_IDS, MANUAL_ID_MAP,
    parse_android, build_reverse, write_strings_xml,
    load_lt_translations, load_tx_translations, load_qb_translations,
    get_tier1_languages, get_all_languages,
)

# Per-language translations for strings that have no match in any source.
MANUAL_TRANSLATIONS = {
    "de": {},
}


def generate_translation(lang_code, jst_en=None, lt_en_reverse=None):
    """Generate translations for a language from all sources.

    Returns (results, stats) where results is a list of
    (name, en_text, translated, source) tuples.
    """
    if jst_en is None:
        jst_en = parse_android(JSTORRENT_STRINGS)
    if lt_en_reverse is None:
        lt_en = parse_android(LIBRETORRENT_EN)
        lt_en_reverse = build_reverse(lt_en)

    lt_translated = load_lt_translations(lang_code)
    tx_translated = load_tx_translations(lang_code)
    qb_translated = load_qb_translations(lang_code)

    manual = MANUAL_TRANSLATIONS.get(lang_code, {})

    stats = {"manual": 0, "mapped": 0, "lt": 0, "tx": 0, "qb": 0, "skipped": 0, "untranslated": 0}

    results = []
    for name, en_text in jst_en.items():
        if name in SKIP_IDS:
            stats["skipped"] += 1
            continue

        translated = None
        source = None
        normalized = en_text.strip().lower()

        # 1. Manual per-language translations (highest priority)
        if name in manual:
            translated = manual[name]
            source = "manual"
            stats["manual"] += 1

        # 2. Manual ID mapping to LibreTorrent
        if not translated and name in MANUAL_ID_MAP:
            lt_id = MANUAL_ID_MAP[name]
            if lt_id in lt_translated:
                translated = lt_translated[lt_id]
                source = f"lt-map:{lt_id}"
                stats["mapped"] += 1

        # 3. LibreTorrent auto-match by English text
        if not translated and normalized in lt_en_reverse:
            for lt_id in lt_en_reverse[normalized]:
                if lt_id in lt_translated:
                    translated = lt_translated[lt_id]
                    source = f"lt:{lt_id}"
                    stats["lt"] += 1
                    break

        # 4. Transmission auto-match by English text
        if not translated and normalized in tx_translated:
            translated = tx_translated[normalized]
            source = "tx"
            stats["tx"] += 1

        # 5. qBittorrent auto-match by English text
        if not translated and normalized in qb_translated:
            translated = qb_translated[normalized]
            source = "qb"
            stats["qb"] += 1

        # 6. Not translated
        if not translated:
            source = "UNTRANSLATED"
            stats["untranslated"] += 1

        results.append((name, en_text, translated, source))

    return results, stats


def write_report(results, stats, lang_code):
    """Print a human-readable report."""
    total = sum(stats.values())
    covered = stats["manual"] + stats["mapped"] + stats["lt"] + stats["tx"] + stats["qb"]
    pct = covered / (total - stats["skipped"]) * 100 if (total - stats["skipped"]) else 0

    print(f"\n=== {lang_code}: {covered} translated ({pct:.0f}%) ===")
    print(f"  LibreTorrent:  {stats['lt']} auto + {stats['mapped']} mapped")
    print(f"  Transmission:  {stats['tx']}")
    print(f"  qBittorrent:   {stats['qb']}")
    print(f"  Manual:        {stats['manual']}")
    print(f"  Untranslated:  {stats['untranslated']}")

    # Show what came from TX/qBT
    tx_qb = [(n, e, t, s) for n, e, t, s in results if s and (s.startswith("tx") or s.startswith("qb"))]
    if tx_qb:
        print(f"\n  From Transmission/qBittorrent:")
        for name, en_text, translated, source in tx_qb:
            print(f"    {name}: \"{en_text}\" -> \"{translated}\"  [{source}]")


def cmd_generate(args):
    jst_en = parse_android(JSTORRENT_STRINGS)
    lt_en = parse_android(LIBRETORRENT_EN)
    lt_en_reverse = build_reverse(lt_en)

    if args.all_sources:
        langs = get_all_languages()
    elif args.all:
        langs = get_tier1_languages()
    else:
        langs = [args.lang]

    for lang in langs:
        results, stats = generate_translation(lang, jst_en=jst_en, lt_en_reverse=lt_en_reverse)
        output_path = ANDROID_RES / f"values-{lang}" / "strings.xml"

        covered = stats["manual"] + stats["mapped"] + stats["lt"] + stats["tx"] + stats["qb"]
        if covered == 0:
            if not args.all and not args.all_sources:
                print(f"No translations found for '{lang}'")
            continue

        # Build dict of translated strings for write_strings_xml
        translated_strings = {}
        for name, en_text, translated, source in results:
            if translated is not None:
                translated_strings[name] = translated

        if args.dry_run:
            write_report(results, stats, lang)
            print(f"  [DRY RUN] Would write to: {output_path}")
        else:
            write_strings_xml(translated_strings, output_path)
            write_report(results, stats, lang)
            print(f"  Written to: {output_path}")


def cmd_summary(args):
    jst_en = parse_android(JSTORRENT_STRINGS)
    lt_en = parse_android(LIBRETORRENT_EN)
    lt_en_reverse = build_reverse(lt_en)

    total_translatable = len(jst_en) - len(SKIP_IDS & set(jst_en.keys()))
    langs = get_all_languages()

    print(f"JSTorrent: {len(jst_en)} total, {total_translatable} translatable")
    print(f"Languages: {len(langs)} available")
    print()
    print(f"{'Lang':<12} {'LT':>4} {'TX':>4} {'qBT':>4} {'Map':>4} {'Man':>4} {'Total':>6} {'Need':>6} {'Cov':>5}")
    print("-" * 56)

    for lang in langs:
        _results, s = generate_translation(lang, jst_en=jst_en, lt_en_reverse=lt_en_reverse)
        covered = s["manual"] + s["mapped"] + s["lt"] + s["tx"] + s["qb"]
        pct = covered / total_translatable * 100 if total_translatable else 0
        print(f"{lang:<12} {s['lt']:>4} {s['tx']:>4} {s['qb']:>4} {s['mapped']:>4} {s['manual']:>4} {covered:>6} {s['untranslated']:>6} {pct:>4.0f}%")


def main():
    parser = argparse.ArgumentParser(
        description="Generate translated strings.xml from open-source torrent clients")

    parser.add_argument("lang", nargs="?", help="Language code (e.g. de, pt-rBR)")
    parser.add_argument("--all", action="store_true", help="Generate tier 1 languages")
    parser.add_argument("--all-sources", action="store_true", help="Generate ALL available languages (not just tier 1)")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing files")
    parser.add_argument("--summary", action="store_true", help="Show coverage table")

    args = parser.parse_args()

    if args.summary:
        cmd_summary(args)
    elif args.all or args.all_sources or args.lang:
        cmd_generate(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
