#!/usr/bin/env python3
"""
Analyse JSTorrent string translation coverage against LibreTorrent.

Usage:
    python translate-analyse.py unmatched       # our strings with no LT match
    python translate-analyse.py matched         # our strings that do match LT
    python translate-analyse.py lt-unmatched    # LT strings we don't use
    python translate-analyse.py coverage        # per-language coverage summary
    python translate-analyse.py stats           # quick stats overview
"""

import argparse
import xml.etree.ElementTree as ET
import os
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
ANDROID_DIR = SCRIPT_DIR.parent.parent
JSTORRENT_STRINGS = ANDROID_DIR / "app/src/main/res/values/strings.xml"
LIBRETORRENT_DIR = Path(os.path.expanduser("~/code/reference/libretorrent/app/src/main/res"))
LIBRETORRENT_EN = LIBRETORRENT_DIR / "values/strings.xml"

SKIP_IDS = {
    "app_name",
    "debug_add_test_100mb",
    "debug_add_test_1gb",
    "debug_add_ubuntu",
    "debug_add_bunny",
    "debug_add_webtorrent",
    "debug_show_review_dialog",
    "debug_reset_state",
    "dialog_add_torrent_magnet_hint",
    "settings_network_proxy_host_placeholder",
    "settings_network_proxy_port_placeholder",
}

MANUAL_ID_MAP = {
    "dialog_remove_confirm_button": "delete",
    "dialog_bulk_remove_confirm_button": "delete",
    "settings_storage_remove_folder_confirm": "delete",
}

LT_SKIP_DIRS = {
    "large-land", "large-port", "night", "night-v31", "v30", "v31",
    "sw360dp-v13", "sw600dp-land", "w1024dp", "w600dp", "w720dp",
}


def parse_strings(path):
    if not path.exists():
        return {}
    tree = ET.parse(path)
    strings = {}
    for elem in tree.getroot().findall("string"):
        name = elem.get("name")
        text = elem.text or ""
        for child in elem:
            text += ET.tostring(child, encoding="unicode")
        strings[name] = text
    return strings


def build_reverse_lookup(strings):
    lookup = {}
    for name, text in strings.items():
        key = text.strip().lower()
        lookup.setdefault(key, []).append(name)
    return lookup


def get_matches(jst, lt_reverse):
    """Return (matched, unmatched) dicts of name -> (en_text, source)."""
    matched = {}
    unmatched = {}
    for name, text in jst.items():
        if name in SKIP_IDS:
            continue
        if name in MANUAL_ID_MAP:
            matched[name] = (text, f"manual -> {MANUAL_ID_MAP[name]}")
            continue
        key = text.strip().lower()
        if key in lt_reverse:
            matched[name] = (text, f"auto -> {lt_reverse[key][0]}")
        else:
            unmatched[name] = text
    return matched, unmatched


def get_lt_languages():
    langs = []
    for d in sorted(LIBRETORRENT_DIR.iterdir()):
        if d.is_dir() and d.name.startswith("values-"):
            code = d.name[len("values-"):]
            if code in LT_SKIP_DIRS:
                continue
            if (d / "strings.xml").exists():
                langs.append(code)
    return langs


def cmd_unmatched(args):
    jst = parse_strings(JSTORRENT_STRINGS)
    lt_en = parse_strings(LIBRETORRENT_EN)
    lt_reverse = build_reverse_lookup(lt_en)
    _, unmatched = get_matches(jst, lt_reverse)

    # Group by prefix
    if args.group:
        groups = {}
        for name, text in sorted(unmatched.items()):
            prefix = name.split("_")[0] if "_" in name else "other"
            groups.setdefault(prefix, []).append((name, text))
        for prefix, items in sorted(groups.items()):
            print(f"\n--- {prefix} ({len(items)}) ---")
            for name, text in items:
                print(f"  {name}: {text}")
    else:
        for name, text in sorted(unmatched.items()):
            print(f"{name}: {text}")

    print(f"\n{len(unmatched)} unmatched strings")


def cmd_matched(args):
    jst = parse_strings(JSTORRENT_STRINGS)
    lt_en = parse_strings(LIBRETORRENT_EN)
    lt_reverse = build_reverse_lookup(lt_en)
    matched, _ = get_matches(jst, lt_reverse)

    for name, (text, source) in sorted(matched.items()):
        print(f"{name}: {text}  [{source}]")

    print(f"\n{len(matched)} matched strings")


def cmd_lt_unmatched(args):
    jst = parse_strings(JSTORRENT_STRINGS)
    lt_en = parse_strings(LIBRETORRENT_EN)
    jst_reverse = build_reverse_lookup(jst)

    unmatched = {}
    for name, text in lt_en.items():
        key = text.strip().lower()
        if key not in jst_reverse:
            unmatched[name] = text

    if args.group:
        groups = {}
        for name, text in sorted(unmatched.items()):
            prefix = name.split("_")[0] if "_" in name else "other"
            groups.setdefault(prefix, []).append((name, text))
        for prefix, items in sorted(groups.items()):
            print(f"\n--- {prefix} ({len(items)}) ---")
            for name, text in items:
                print(f"  {name}: {text}")
    else:
        for name, text in sorted(unmatched.items()):
            print(f"{name}: {text}")

    print(f"\n{len(unmatched)} LT strings we don't use")


def cmd_coverage(args):
    jst = parse_strings(JSTORRENT_STRINGS)
    lt_en = parse_strings(LIBRETORRENT_EN)
    lt_reverse = build_reverse_lookup(lt_en)
    matched, unmatched = get_matches(jst, lt_reverse)
    total = len(matched) + len(unmatched)
    langs = get_lt_languages()

    print(f"{'Lang':<8} {'Translated':>10} {'of':>3} {total:>4}  {'Coverage':>8}")
    print("-" * 38)

    for lang in langs:
        lt_translated = parse_strings(LIBRETORRENT_DIR / f"values-{lang}/strings.xml")
        count = 0
        for name, (text, source) in matched.items():
            if source.startswith("manual ->"):
                lt_id = MANUAL_ID_MAP[name]
            else:
                lt_id = source.split("-> ")[1]
            if lt_id in lt_translated:
                count += 1
        pct = count / total * 100 if total else 0
        print(f"{lang:<8} {count:>10} {'of':>3} {total:>4}  {pct:>7.1f}%")


def cmd_stats(args):
    jst = parse_strings(JSTORRENT_STRINGS)
    lt_en = parse_strings(LIBRETORRENT_EN)
    lt_reverse = build_reverse_lookup(lt_en)
    matched, unmatched = get_matches(jst, lt_reverse)
    skipped = sum(1 for name in jst if name in SKIP_IDS)

    print(f"JSTorrent:    {len(jst)} total, {skipped} skipped, {len(jst) - skipped} translatable")
    print(f"LibreTorrent: {len(lt_en)} total")
    print(f"Matched:      {len(matched)} ({len(matched)}/{len(matched)+len(unmatched)})")
    print(f"Unmatched:    {len(unmatched)} ({len(unmatched)}/{len(matched)+len(unmatched)})")
    print(f"Languages:    {len(get_lt_languages())} available from LT")


def main():
    parser = argparse.ArgumentParser(description="Analyse JSTorrent translation coverage")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("unmatched", help="Our strings with no LT match")
    p.add_argument("-g", "--group", action="store_true", help="Group by name prefix")

    p = sub.add_parser("matched", help="Our strings that match LT")

    p = sub.add_parser("lt-unmatched", help="LT strings we don't use")
    p.add_argument("-g", "--group", action="store_true", help="Group by name prefix")

    p = sub.add_parser("coverage", help="Per-language coverage summary")

    p = sub.add_parser("stats", help="Quick stats overview")

    args = parser.parse_args()
    cmds = {
        "unmatched": cmd_unmatched,
        "matched": cmd_matched,
        "lt-unmatched": cmd_lt_unmatched,
        "coverage": cmd_coverage,
        "stats": cmd_stats,
    }
    cmds[args.command](args)


if __name__ == "__main__":
    main()
