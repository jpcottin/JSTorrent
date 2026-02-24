"""
Shared constants, parsing, and utilities for the JSTorrent translation pipeline.

All translation scripts import from here to avoid duplication.
"""

import re
import xml.etree.ElementTree as ET
import os
from pathlib import Path

# --- Paths ---

SCRIPT_DIR = Path(__file__).parent
ANDROID_DIR = SCRIPT_DIR.parent.parent
ANDROID_RES = ANDROID_DIR / "app" / "src" / "main" / "res"
JSTORRENT_STRINGS = ANDROID_RES / "values" / "strings.xml"
TIER1_FILE = SCRIPT_DIR / "tier1-languages.txt"

LIBRETORRENT_DIR = Path(os.path.expanduser("~/code/reference/libretorrent/app/src/main/res"))
LIBRETORRENT_EN = LIBRETORRENT_DIR / "values/strings.xml"
TRANSMISSION_DIR = Path(os.path.expanduser("~/code/reference/transmission/qt/translations"))
TRANSMISSION_EN = TRANSMISSION_DIR / "transmission_en.ts"
QBITTORRENT_DESKTOP_DIR = Path(os.path.expanduser("~/code/reference/qbittorrent/src/lang"))
QBITTORRENT_WEBUI_DIR = Path(os.path.expanduser("~/code/reference/qbittorrent/src/webui/www/translations"))

# --- Constants ---

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

LT_SKIP_DIRS = {
    "large-land", "large-port", "night", "night-v31", "v30", "v31",
    "sw360dp-v13", "sw600dp-land", "w1024dp", "w600dp", "w720dp",
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


# --- Parsing ---

def parse_android(path, lenient=False):
    """Parse an Android strings.xml file, return dict of name -> text.

    If lenient=True, returns {} on parse errors instead of raising.
    """
    if not path.exists():
        return {}
    try:
        tree = ET.parse(path)
    except ET.ParseError as e:
        if lenient:
            print(f"  WARNING: Could not parse {path}: {e}")
            print(f"  Will rebuild from LLM JSON only")
            return {}
        raise
    strings = {}
    for elem in tree.getroot().findall("string"):
        name = elem.get("name")
        text = elem.text or ""
        for child in elem:
            text += ET.tostring(child, encoding="unicode")
            if child.tail:
                text += child.tail
        strings[name] = text
    return strings


def build_reverse(strings):
    """Build lowercase text -> list of IDs lookup."""
    lookup = {}
    for name, text in strings.items():
        lookup.setdefault(text.strip().lower(), []).append(name)
    return lookup


def parse_qt_sources(ts_path):
    """Extract English source strings from a Qt .ts file. Returns lowercase -> [original text]."""
    if not ts_path.exists():
        return {}
    tree = ET.parse(ts_path)
    sources = {}
    for msg in tree.getroot().iter("message"):
        src = msg.find("source")
        if src is not None and src.text:
            sources.setdefault(src.text.strip().lower(), []).append(src.text.strip())
    return sources


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
        if tr.get("type") == "unfinished":
            continue
        key = src.text.strip().lower()
        if key not in translations:
            translations[key] = tr.text
    return translations


# --- Escaping ---

def escape_for_android_xml(text):
    """Escape text for Android strings.xml.

    Handles two concerns:
    1. XML entities: & < > must be escaped as &amp; &lt; &gt;
    2. Android convention: apostrophes must be backslash-escaped as \\'

    Sources that feed into this:
    - ET.parse decodes XML entities AND strips backslashes (\\' -> ')
    - LLM JSON has raw text with no escaping at all
    So we must re-apply both escaping layers on every write.
    """
    text = text.replace("&", "&amp;")
    text = text.replace("<", "&lt;")
    text = text.replace(">", "&gt;")
    text = text.replace("\\'", "'")   # normalize any already-escaped
    text = text.replace("'", "\\'")   # then escape all
    return text


# --- Language helpers ---

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
    """Get language codes from Transmission (converted to Android format)."""
    langs = set()
    for f in TRANSMISSION_DIR.glob("transmission_*.ts"):
        code = f.stem.replace("transmission_", "")
        if code != "en":
            langs.add(qt_to_android(code))
    return langs


def get_qb_languages():
    """Get language codes from qBittorrent (converted to Android format)."""
    langs = set()
    for f in QBITTORRENT_DESKTOP_DIR.glob("qbittorrent_*.ts"):
        code = f.stem.replace("qbittorrent_", "")
        if code != "en":
            langs.add(qt_to_android(code))
    return langs


# Matches valid Android resource qualifier language codes:
# "de", "pt-rBR", "zh-rCN", "en-rAU", etc.
# Rejects Qt-style codes like "az@latin", "uz@Latn"
_VALID_ANDROID_LANG = re.compile(r'^[a-z]{2,3}(-r[A-Z]{2,4})?$')


def is_valid_android_lang(code):
    """Check if a language code is valid for Android resource directories."""
    return bool(_VALID_ANDROID_LANG.match(code))


def get_tier1_languages():
    """Get the tier 1 language codes from tier1-languages.txt."""
    langs = []
    with open(TIER1_FILE) as f:
        for line in f:
            line = line.strip()
            if line:
                langs.append(line)
    return langs


def get_all_languages():
    """Get union of all available languages (Android format).

    Filters out codes that aren't valid Android resource qualifiers.
    """
    all_langs = get_lt_languages() | get_tx_languages() | get_qb_languages()
    return sorted(lang for lang in all_langs if is_valid_android_lang(lang))


# --- Translation loaders ---

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
    for k, v in parse_qt_translations(webui_path).items():
        combined.setdefault(k, v)
    return combined


def get_qb_sources():
    """Get combined English sources from qBittorrent desktop + webui."""
    sources = {}
    desktop_files = sorted(QBITTORRENT_DESKTOP_DIR.glob("qbittorrent_*.ts"))
    if desktop_files:
        sources.update(parse_qt_sources(desktop_files[0]))
    webui_files = sorted(QBITTORRENT_WEBUI_DIR.glob("webui_*.ts"))
    if webui_files:
        for k, v in parse_qt_sources(webui_files[0]).items():
            sources.setdefault(k, []).extend(v)
    return sources


# --- XML writing ---

def write_strings_xml(strings, output_path, dry_run=False):
    """Write a sorted strings.xml with proper Android escaping.

    Args:
        strings: dict of name -> text (raw/unescaped)
        output_path: Path to write to
        dry_run: if True, return content without writing

    Returns:
        The XML content as a string.
    """
    lines = ['<?xml version="1.0" encoding="utf-8"?>', "<resources>"]
    for name in sorted(strings.keys()):
        value = escape_for_android_xml(strings[name])
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
