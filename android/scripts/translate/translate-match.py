#!/usr/bin/env python3
"""
Find translation matches for JSTorrent strings across open-source torrent clients.

Searches LibreTorrent, Transmission, and qBittorrent for exact English text matches,
showing which of our strings can get free translations from each source.

Usage:
    python translate-match.py                # show all matches
    python translate-match.py --unmatched    # show strings with no match anywhere
    python translate-match.py --languages    # show language overlap across all 3 projects
    python translate-match.py --summary      # counts only

Reference repos expected at:
    ~/code/reference/libretorrent/
    ~/code/reference/transmission/
    ~/code/reference/qbittorrent/
"""

import argparse

from translate_common import (
    JSTORRENT_STRINGS, LIBRETORRENT_EN, TRANSMISSION_EN,
    SKIP_IDS, MANUAL_ID_MAP,
    parse_android, build_reverse, parse_qt_sources, get_qb_sources,
    get_lt_languages, get_tx_languages, get_qb_languages,
)


def normalize_lang(code):
    """Normalize Android/Qt language codes for comparison. Android: pt-rBR -> pt_BR"""
    return code.replace("-r", "_")


def get_unmatched_from_lt(jst, lt_reverse):
    """Return dict of JST strings not matched by LibreTorrent."""
    unmatched = {}
    for name, text in jst.items():
        if name in SKIP_IDS:
            continue
        if name in MANUAL_ID_MAP:
            continue
        key = text.strip().lower()
        if key not in lt_reverse:
            unmatched[name] = text
    return unmatched


def cmd_default(args):
    jst = parse_android(JSTORRENT_STRINGS)
    lt_en = parse_android(LIBRETORRENT_EN)
    lt_reverse = build_reverse(lt_en)
    tx_sources = parse_qt_sources(TRANSMISSION_EN)
    qb_sources = get_qb_sources()

    unmatched = get_unmatched_from_lt(jst, lt_reverse)

    both, tx_only, qb_only, none = [], [], [], []
    for name, text in sorted(unmatched.items()):
        key = text.strip().lower()
        in_tx = key in tx_sources
        in_qb = key in qb_sources
        if in_tx and in_qb:
            both.append((name, text))
        elif in_tx:
            tx_only.append((name, text))
        elif in_qb:
            qb_only.append((name, text))
        else:
            none.append((name, text))

    # Count LT matches
    lt_matched = len(jst) - len(SKIP_IDS & set(jst.keys())) - len(MANUAL_ID_MAP) - len(unmatched) + len(MANUAL_ID_MAP)
    total_translatable = len(jst) - len(SKIP_IDS & set(jst.keys()))

    print(f"LibreTorrent matches: {lt_matched}")
    print(f"Additional from TX + qBT: {len(both) + len(tx_only) + len(qb_only)}")
    print(f"Still unmatched: {len(none)}")
    print(f"Total translatable: {total_translatable}")
    print()

    if both:
        print(f"=== In BOTH Transmission + qBittorrent ({len(both)}) ===")
        for name, text in both:
            print(f"  {name}: {text}")
        print()

    if tx_only:
        print(f"=== Transmission only ({len(tx_only)}) ===")
        for name, text in tx_only:
            print(f"  {name}: {text}")
        print()

    if qb_only:
        print(f"=== qBittorrent only ({len(qb_only)}) ===")
        for name, text in qb_only:
            print(f"  {name}: {text}")
        print()


def cmd_unmatched(args):
    jst = parse_android(JSTORRENT_STRINGS)
    lt_en = parse_android(LIBRETORRENT_EN)
    lt_reverse = build_reverse(lt_en)
    tx_sources = parse_qt_sources(TRANSMISSION_EN)
    qb_sources = get_qb_sources()

    unmatched = get_unmatched_from_lt(jst, lt_reverse)

    none = []
    for name, text in sorted(unmatched.items()):
        key = text.strip().lower()
        if key not in tx_sources and key not in qb_sources:
            none.append((name, text))

    if args.group:
        groups = {}
        for name, text in none:
            prefix = name.split("_")[0] if "_" in name else "other"
            groups.setdefault(prefix, []).append((name, text))
        for prefix, items in sorted(groups.items()):
            print(f"\n--- {prefix} ({len(items)}) ---")
            for name, text in items:
                print(f"  {name}: {text}")
    else:
        for name, text in none:
            print(f"{name}: {text}")

    print(f"\n{len(none)} strings with no match in any source")


def cmd_languages(args):
    lt_langs = {normalize_lang(c) for c in get_lt_languages()}
    tx_langs = {normalize_lang(c) for c in get_tx_languages()}
    qb_langs = {normalize_lang(c) for c in get_qb_languages()}
    all_langs = sorted(lt_langs | tx_langs | qb_langs)
    common = sorted(lt_langs & tx_langs & qb_langs)

    print(f"LibreTorrent: {len(lt_langs)} languages")
    print(f"Transmission: {len(tx_langs)} languages")
    print(f"qBittorrent:  {len(qb_langs)} languages")
    print(f"Common to all 3: {len(common)}")
    print()

    print(f"{'Lang':<12} {'LT':<6} {'TX':<6} {'qBT':<6}")
    print("-" * 32)
    for lang in all_langs:
        lt_ok = "yes" if lang in lt_langs else ""
        tx_ok = "yes" if lang in tx_langs else ""
        qb_ok = "yes" if lang in qb_langs else ""
        marker = " ***" if lt_ok and tx_ok and qb_ok else ""
        print(f"{lang:<12} {lt_ok:<6} {tx_ok:<6} {qb_ok:<6}{marker}")

    print()
    print(f"*** = common to all 3 ({len(common)}): {', '.join(common)}")


def cmd_summary(args):
    jst = parse_android(JSTORRENT_STRINGS)
    lt_en = parse_android(LIBRETORRENT_EN)
    lt_reverse = build_reverse(lt_en)
    tx_sources = parse_qt_sources(TRANSMISSION_EN)
    qb_sources = get_qb_sources()

    total_translatable = len(jst) - len(SKIP_IDS & set(jst.keys()))
    unmatched = get_unmatched_from_lt(jst, lt_reverse)
    lt_matched = total_translatable - len(unmatched)

    tx_new, qb_new = 0, 0
    for name, text in unmatched.items():
        key = text.strip().lower()
        in_tx = key in tx_sources
        in_qb = key in qb_sources
        if in_tx:
            tx_new += 1
        if in_qb:
            qb_new += 1

    combined_new = sum(1 for name, text in unmatched.items()
                       if text.strip().lower() in tx_sources or text.strip().lower() in qb_sources)
    still_unmatched = len(unmatched) - combined_new

    print(f"Total translatable:          {total_translatable}")
    print(f"Matched by LibreTorrent:     {lt_matched}")
    print(f"New from Transmission:       {tx_new}")
    print(f"New from qBittorrent:        {qb_new}")
    print(f"New combined (deduplicated): {combined_new}")
    print(f"Total with all sources:      {lt_matched + combined_new}")
    print(f"Still unmatched:             {still_unmatched}")
    print(f"Coverage:                    {(lt_matched + combined_new) / total_translatable * 100:.0f}%")


def main():
    parser = argparse.ArgumentParser(description="Find translation matches across torrent clients")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("matches", help="Show all new matches from TX/qBT (default)")

    p = sub.add_parser("unmatched", help="Strings with no match anywhere")
    p.add_argument("-g", "--group", action="store_true", help="Group by name prefix")

    sub.add_parser("languages", help="Language overlap across all 3 projects")
    sub.add_parser("summary", help="Counts only")

    args = parser.parse_args()
    cmd = args.command or "matches"
    cmds = {
        "matches": cmd_default,
        "unmatched": cmd_unmatched,
        "languages": cmd_languages,
        "summary": cmd_summary,
    }
    cmds[cmd](args)


if __name__ == "__main__":
    main()
