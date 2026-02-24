#!/usr/bin/env python3
"""
Merge LLM-translated strings (JSON) into an existing Android strings.xml.

Reads the existing values-<lang>/strings.xml (from translate.py) and the
claude/<lang>.json (from translate-llm.sh), merges them, and writes a sorted
strings.xml. Idempotent — running multiple times produces the same output.

Usage:
    python translate-merge.py de                # merge and write
    python translate-merge.py de --dry-run      # preview without writing
    python translate-merge.py --all             # merge all languages with claude/*.json
"""

import argparse
import json
import sys
from pathlib import Path

from translate_common import (
    ANDROID_RES, JSTORRENT_STRINGS,
    parse_android, escape_for_android_xml, write_strings_xml,
)

SCRIPT_DIR = Path(__file__).parent
CLAUDE_DIR = SCRIPT_DIR / "claude"


def get_en_names():
    """Get the set of valid string names from English strings.xml."""
    return set(parse_android(JSTORRENT_STRINGS).keys())


def merge_lang(lang, dry_run=False):
    """Merge existing XML + LLM JSON for a single language."""
    xml_path = ANDROID_RES / f"values-{lang}" / "strings.xml"
    json_path = CLAUDE_DIR / f"{lang}.json"

    existing = parse_android(xml_path, lenient=True)
    en_names = get_en_names()

    if not json_path.exists():
        print(f"  No claude/{lang}.json found — skipping LLM merge")
        llm = {}
    else:
        with open(json_path) as f:
            llm = json.load(f)

    # Validate LLM keys against English
    unknown = set(llm.keys()) - en_names
    if unknown:
        print(f"  WARNING: {len(unknown)} unknown keys in LLM output: {', '.join(sorted(unknown)[:5])}...")

    # Merge: existing XML wins for keys present in both (open-source translations
    # are human-reviewed). LLM fills in the gaps.
    merged = {}
    from_xml = 0
    from_llm = 0
    updated = 0

    for name in en_names:
        if name in existing:
            merged[name] = existing[name]
            from_xml += 1
            if name in llm and llm[name] != existing[name]:
                updated += 1  # LLM has a different translation (not used)
        elif name in llm:
            merged[name] = llm[name]
            from_llm += 1

    missing = len(en_names) - len(merged)

    print(f"  Existing XML: {from_xml} strings")
    print(f"  LLM additions: {from_llm} strings")
    if updated:
        print(f"  LLM differs on {updated} existing strings (kept existing)")
    if missing:
        print(f"  Still missing: {missing} strings")
    print(f"  Total: {len(merged)}/{len(en_names)} strings")

    write_strings_xml(merged, xml_path, dry_run=dry_run)
    if not dry_run:
        print(f"  Written: {xml_path}")

    return len(merged), len(en_names)


def main():
    parser = argparse.ArgumentParser(
        description="Merge LLM translations into Android strings.xml")
    parser.add_argument("lang", nargs="?", help="Language code (e.g. de)")
    parser.add_argument("--all", action="store_true",
                        help="Merge all languages that have claude/*.json")
    parser.add_argument("--dry-run", action="store_true",
                        help="Preview without writing")
    args = parser.parse_args()

    if args.all:
        langs = sorted(p.stem for p in CLAUDE_DIR.glob("*.json"))
        if not langs:
            print("No claude/*.json files found")
            sys.exit(1)
    elif args.lang:
        langs = [args.lang]
    else:
        parser.print_help()
        sys.exit(1)

    print(f"Merging {len(langs)} language(s): {', '.join(langs)}")
    if args.dry_run:
        print("(dry run)\n")
    else:
        print()

    for lang in langs:
        print(f"=== {lang} ===")
        merge_lang(lang, dry_run=args.dry_run)
        print()

    print("Done.")


if __name__ == "__main__":
    main()
