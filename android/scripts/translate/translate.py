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
    python translate.py --all              # generate all available languages
    python translate.py --all --dry-run    # preview all languages
    python translate.py --summary          # coverage table across all languages

Reference repos expected at:
    ~/code/reference/libretorrent/
    ~/code/reference/transmission/
    ~/code/reference/qbittorrent/
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
TRANSMISSION_DIR = Path(os.path.expanduser("~/code/reference/transmission/qt/translations"))
TRANSMISSION_EN = TRANSMISSION_DIR / "transmission_en.ts"
QBITTORRENT_DESKTOP_DIR = Path(os.path.expanduser("~/code/reference/qbittorrent/src/lang"))
QBITTORRENT_WEBUI_DIR = Path(os.path.expanduser("~/code/reference/qbittorrent/src/webui/www/translations"))

# Skip these string IDs (debug-only or should not be translated)
SKIP_IDS = {
    "app_name",
    "debug_add_test_100mb",
    "debug_add_test_1gb",
    "debug_add_ubuntu",
    "debug_add_bunny",
    "debug_add_webtorrent",
    "debug_show_review_dialog",
    "debug_reset_state",
    "dialog_add_torrent_magnet_hint",  # placeholder example, keep as-is
    "settings_network_proxy_host_placeholder",  # example domain, keep as-is
    "settings_network_proxy_port_placeholder",  # number, keep as-is
}

# Manual mapping: JSTorrent string ID -> LibreTorrent string ID
# For cases where the English text differs but the meaning is the same.
MANUAL_ID_MAP = {
    # JST says "Remove" but we want LT's "Delete" translation
    "dialog_remove_confirm_button": "delete",
    "dialog_bulk_remove_confirm_button": "delete",
    "settings_storage_remove_folder_confirm": "delete",
}

# Per-language translations for strings that have no match in any source.
MANUAL_TRANSLATIONS = {
    "de": {},
}

# Language dirs in LT that aren't real translations
LT_SKIP_DIRS = {
    "large-land", "large-port", "night", "night-v31", "v30", "v31",
    "sw360dp-v13", "sw600dp-land", "w1024dp", "w600dp", "w720dp",
}


# --- Parsing ---

def parse_android(path):
    """Parse an Android strings.xml file, return dict of name -> text."""
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


def build_reverse(strings):
    """Build lowercase text -> list of IDs lookup."""
    lookup = {}
    for name, text in strings.items():
        key = text.strip().lower()
        lookup.setdefault(key, []).append(name)
    return lookup


def parse_qt_translations(ts_path):
    """Parse a Qt .ts file, return dict of lowercase_source -> translation."""
    if not ts_path.exists():
        return {}
    tree = ET.parse(ts_path)
    translations = {}
    for msg in tree.getroot().iter("message"):
        src = msg.find("source")
        tr = msg.find("translation")
        if src is None or src.text is None:
            continue
        if tr is None or tr.text is None:
            continue
        # Skip unfinished translations
        if tr.get("type") == "unfinished":
            continue
        key = src.text.strip().lower()
        # First match wins (some sources may have duplicates)
        if key not in translations:
            translations[key] = tr.text
    return translations


def parse_qt_sources(ts_path):
    """Extract English source strings from a Qt .ts file. Returns lowercase -> [original]."""
    if not ts_path.exists():
        return {}
    tree = ET.parse(ts_path)
    sources = {}
    for msg in tree.getroot().iter("message"):
        src = msg.find("source")
        if src is not None and src.text:
            key = src.text.strip().lower()
            sources.setdefault(key, []).append(src.text.strip())
    return sources


# --- Language discovery ---

def android_to_qt(android_code):
    """Convert Android language code to Qt style. e.g. pt-rBR -> pt_BR"""
    return android_code.replace("-r", "_")


def qt_to_android(qt_code):
    """Convert Qt language code to Android style. e.g. pt_BR -> pt-rBR"""
    if "_" in qt_code:
        parts = qt_code.split("_", 1)
        return f"{parts[0]}-r{parts[1]}"
    return qt_code


def get_lt_languages():
    """Get language codes from LibreTorrent (Android format)."""
    langs = set()
    for d in LIBRETORRENT_DIR.iterdir():
        if d.is_dir() and d.name.startswith("values-"):
            code = d.name[len("values-"):]
            if code not in LT_SKIP_DIRS and (d / "strings.xml").exists():
                langs.add(code)
    return langs


def get_tx_languages():
    """Get language codes from Transmission (Qt format, converted to Android)."""
    langs = set()
    for f in TRANSMISSION_DIR.glob("transmission_*.ts"):
        code = f.stem.replace("transmission_", "")
        if code != "en":
            langs.add(qt_to_android(code))
    return langs


def get_qb_languages():
    """Get language codes from qBittorrent (Qt format, converted to Android)."""
    langs = set()
    for f in QBITTORRENT_DESKTOP_DIR.glob("qbittorrent_*.ts"):
        code = f.stem.replace("qbittorrent_", "")
        if code != "en":
            langs.add(qt_to_android(code))
    return langs


def get_all_languages():
    """Get union of all available languages (Android format)."""
    return sorted(get_lt_languages() | get_tx_languages() | get_qb_languages())


# --- Translation loading ---

def load_lt_translations(lang_code):
    """Load LibreTorrent translations for a language. Returns name -> text."""
    path = LIBRETORRENT_DIR / f"values-{lang_code}" / "strings.xml"
    return parse_android(path)


def load_tx_translations(lang_code):
    """Load Transmission translations for a language. Returns lowercase_source -> translation."""
    qt_code = android_to_qt(lang_code)
    path = TRANSMISSION_DIR / f"transmission_{qt_code}.ts"
    return parse_qt_translations(path)


def load_qb_translations(lang_code):
    """Load qBittorrent translations (desktop + webui). Returns lowercase_source -> translation."""
    qt_code = android_to_qt(lang_code)
    combined = {}
    desktop_path = QBITTORRENT_DESKTOP_DIR / f"qbittorrent_{qt_code}.ts"
    combined.update(parse_qt_translations(desktop_path))
    webui_path = QBITTORRENT_WEBUI_DIR / f"webui_{qt_code}.ts"
    # Desktop takes priority; only add webui if not already present
    for k, v in parse_qt_translations(webui_path).items():
        combined.setdefault(k, v)
    return combined


# --- Core generation ---

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


# --- Output ---

def write_strings_xml(results, output_path):
    """Write a strings.xml with only translated strings."""
    lines = ['<?xml version="1.0" encoding="utf-8"?>', "<resources>"]

    for name, en_text, translated, source in results:
        if translated is not None:
            lines.append(f'    <string name="{name}">{translated}</string>')

    lines.append("</resources>")
    lines.append("")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


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


# --- Commands ---

def cmd_generate(args):
    jst_en = parse_android(JSTORRENT_STRINGS)
    lt_en = parse_android(LIBRETORRENT_EN)
    lt_en_reverse = build_reverse(lt_en)

    if args.all:
        langs = get_all_languages()
    else:
        langs = [args.lang]

    for lang in langs:
        results, stats = generate_translation(lang, jst_en=jst_en, lt_en_reverse=lt_en_reverse)
        output_path = ANDROID_DIR / f"app/src/main/res/values-{lang}/strings.xml"

        covered = stats["manual"] + stats["mapped"] + stats["lt"] + stats["tx"] + stats["qb"]
        if covered == 0:
            if not args.all:
                print(f"No translations found for '{lang}'")
            continue

        if args.dry_run:
            write_report(results, stats, lang)
            print(f"  [DRY RUN] Would write to: {output_path}")
        else:
            write_strings_xml(results, output_path)
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
    parser.add_argument("--all", action="store_true", help="Generate all available languages")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing files")
    parser.add_argument("--summary", action="store_true", help="Show coverage table")

    args = parser.parse_args()

    if args.summary:
        cmd_summary(args)
    elif args.all or args.lang:
        cmd_generate(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
