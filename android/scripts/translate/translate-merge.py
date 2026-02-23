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
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
ANDROID_RES = SCRIPT_DIR.parent.parent / "app" / "src" / "main" / "res"
CLAUDE_DIR = SCRIPT_DIR / "claude"
EN_STRINGS = ANDROID_RES / "values" / "strings.xml"


def parse_strings_xml(path):
    """Parse a strings.xml into a dict of {name: text}."""
    if not path.exists():
        return {}
    tree = ET.parse(path)
    strings = {}
    for elem in tree.getroot().findall("string"):
        name = elem.get("name")
        # Reconstruct full text including any child elements (e.g. <xliff:g>)
        text = elem.text or ""
        for child in elem:
            text += ET.tostring(child, encoding="unicode")
            if child.tail:
                text += child.tail
        strings[name] = text
    return strings


def get_en_names():
    """Get the set of valid string names from English strings.xml."""
    return set(parse_strings_xml(EN_STRINGS).keys())


def escape_xml(text):
    """Escape text for Android strings.xml."""
    # Android strings.xml uses backslash-escaped apostrophes, not XML entities.
    # The XML header/footer are written as raw strings, so we only need to
    # handle the text content here.
    text = text.replace("&", "&amp;")
    text = text.replace("<", "&lt;")
    text = text.replace(">", "&gt;")
    # Don't escape quotes/apostrophes — they use Android's backslash convention
    # and come pre-escaped from both sources.
    return text


def write_merged_xml(strings, output_path, dry_run=False):
    """Write a sorted strings.xml."""
    lines = ['<?xml version="1.0" encoding="utf-8"?>', "<resources>"]
    for name in sorted(strings.keys()):
        value = strings[name]
        lines.append(f'    <string name="{name}">{value}</string>')
    lines.append("</resources>")
    lines.append("")

    content = "\n".join(lines)
    if dry_run:
        return content

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(content)
    return content


def merge_lang(lang, dry_run=False):
    """Merge existing XML + LLM JSON for a single language."""
    xml_path = ANDROID_RES / f"values-{lang}" / "strings.xml"
    json_path = CLAUDE_DIR / f"{lang}.json"

    existing = parse_strings_xml(xml_path)
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

    write_merged_xml(merged, xml_path, dry_run=dry_run)
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
