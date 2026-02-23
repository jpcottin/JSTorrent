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
import xml.etree.ElementTree as ET
import os
import json
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
ANDROID_DIR = SCRIPT_DIR.parent.parent
JSTORRENT_STRINGS = ANDROID_DIR / "app/src/main/res/values/strings.xml"
TIER1_FILE = SCRIPT_DIR / "tier1-languages.txt"

LIBRETORRENT_DIR = Path(os.path.expanduser("~/code/reference/libretorrent/app/src/main/res"))
LIBRETORRENT_EN = LIBRETORRENT_DIR / "values/strings.xml"
TRANSMISSION_DIR = Path(os.path.expanduser("~/code/reference/transmission/qt/translations"))
TRANSMISSION_EN = TRANSMISSION_DIR / "transmission_en.ts"
QBITTORRENT_DESKTOP_DIR = Path(os.path.expanduser("~/code/reference/qbittorrent/src/lang"))
QBITTORRENT_WEBUI_DIR = Path(os.path.expanduser("~/code/reference/qbittorrent/src/webui/www/translations"))

SKIP_IDS = {
    "app_name", "debug_add_test_100mb", "debug_add_test_1gb", "debug_add_ubuntu",
    "debug_add_bunny", "debug_add_webtorrent", "debug_show_review_dialog", "debug_reset_state",
    "dialog_add_torrent_magnet_hint", "settings_network_proxy_host_placeholder",
    "settings_network_proxy_port_placeholder",
}

MANUAL_ID_MAP = {
    "dialog_remove_confirm_button": "delete",
    "dialog_bulk_remove_confirm_button": "delete",
    "settings_storage_remove_folder_confirm": "delete",
}

LANG_NAMES = {
    "de": "German", "es": "Spanish", "fr": "French", "it": "Italian",
    "pt-rBR": "Brazilian Portuguese", "ja": "Japanese", "ko": "Korean",
    "zh-rCN": "Simplified Chinese", "zh-rTW": "Traditional Chinese",
    "ru": "Russian", "nl": "Dutch", "pl": "Polish", "tr": "Turkish",
    "sv": "Swedish", "cs": "Czech", "da": "Danish", "uk": "Ukrainian",
    "ro": "Romanian", "ar": "Arabic", "fi": "Finnish", "hu": "Hungarian",
    "vi": "Vietnamese", "id": "Indonesian", "th": "Thai", "el": "Greek",
}


def parse_android(path):
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
    lookup = {}
    for name, text in strings.items():
        lookup.setdefault(text.strip().lower(), []).append(name)
    return lookup


def parse_qt_sources(ts_path):
    if not ts_path.exists():
        return {}
    tree = ET.parse(ts_path)
    sources = {}
    for msg in tree.getroot().iter("message"):
        src = msg.find("source")
        if src is not None and src.text:
            sources.setdefault(src.text.strip().lower(), []).append(src.text.strip())
    return sources


def get_qb_sources():
    sources = {}
    desktop_files = sorted(QBITTORRENT_DESKTOP_DIR.glob("qbittorrent_*.ts"))
    if desktop_files:
        sources.update(parse_qt_sources(desktop_files[0]))
    webui_files = sorted(QBITTORRENT_WEBUI_DIR.glob("webui_*.ts"))
    if webui_files:
        for k, v in parse_qt_sources(webui_files[0]).items():
            sources.setdefault(k, []).extend(v)
    return sources


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
    """Return dict of name -> translation for strings that ARE auto-matched."""
    # Import the generate function logic inline to avoid circular deps
    lt_en = parse_android(LIBRETORRENT_EN)
    lt_reverse = build_reverse(lt_en)
    tx_sources = parse_qt_sources(TRANSMISSION_EN)
    qb_sources = get_qb_sources()

    lt_translated = parse_android(LIBRETORRENT_DIR / f"values-{lang_code}" / "strings.xml")

    # Load TX/qBT translations for this lang
    from translate import load_tx_translations, load_qb_translations
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
    lines.append("- Preserve escaped characters: \\n (newline), \\' (apostrophe), \\u2022 (bullet)")
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


def cmd_prompt(args):
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


def cmd_parse(args):
    """Parse a JSON response file and convert to Android strings.xml format."""
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"File not found: {input_path}")
        return

    with open(input_path) as f:
        content = f.read().strip()
        # Strip markdown fences if present
        if content.startswith("```"):
            content = "\n".join(content.split("\n")[1:])
        if content.endswith("```"):
            content = "\n".join(content.split("\n")[:-1])
        translations = json.loads(content)

    lines = ['<?xml version="1.0" encoding="utf-8"?>', "<resources>"]
    for name, text in sorted(translations.items()):
        lines.append(f'    <string name="{name}">{text}</string>')
    lines.append("</resources>")
    lines.append("")

    print("\n".join(lines))


def main():
    parser = argparse.ArgumentParser(description="Generate LLM translation prompts")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("prompt", help="Generate translation prompt")
    p.add_argument("lang", help="Language code (e.g. de)")
    p.add_argument("--group", help="Comma-separated groups to include (e.g. settings,dialog)")
    p.add_argument("--list-groups", action="store_true", help="List available string groups")
    p.add_argument("--reference", action="store_true", help="Include already-translated strings as context")

    p = sub.add_parser("parse", help="Parse JSON response into strings.xml format")
    p.add_argument("input", help="Path to JSON response file")

    # Default to 'prompt' when first arg doesn't match a subcommand
    import sys
    if len(sys.argv) > 1 and sys.argv[1] not in ("prompt", "parse", "-h", "--help"):
        sys.argv.insert(1, "prompt")

    args = parser.parse_args()
    if args.command is None:
        parser.print_help()
        return

    cmds = {"prompt": cmd_prompt, "parse": cmd_parse}
    cmds[args.command](args)


if __name__ == "__main__":
    main()
