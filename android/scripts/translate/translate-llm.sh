#!/usr/bin/env bash
#
# Generate LLM translations for JSTorrent Android strings.
#
# Uses `claude -p` (Claude Code CLI) to translate. Must be run outside of
# an active Claude Code session (or with CLAUDECODE unset).
#
# Usage:
#   ./translate-llm.sh de                  # translate German
#   ./translate-llm.sh --all               # translate all tier 1 languages
#   ./translate-llm.sh de --compare        # translate and diff against existing
#   ./translate-llm.sh --all --dry-run     # show what would be done
#   ./translate-llm.sh --model opus de     # use a specific model
#
# Output:
#   claude/<lang>.json   — translated strings
#   prompts/<lang>.txt   — the prompt that was sent

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TIER1_FILE="$SCRIPT_DIR/tier1-languages.txt"
OUTPUT_DIR="$SCRIPT_DIR/claude"
PROMPT_DIR="$SCRIPT_DIR/prompts"

# Parse args
LANGS=()
COMPARE=false
DRY_RUN=false
FORCE=false
MAX_NEW=0
MODEL="sonnet"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --all)
            while IFS= read -r lang; do
                [[ -z "$lang" ]] && continue
                LANGS+=("$lang")
            done < "$TIER1_FILE"
            shift
            ;;
        --compare)
            COMPARE=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        --max)
            MAX_NEW="$2"
            shift 2
            ;;
        --model)
            MODEL="$2"
            shift 2
            ;;
        -*)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
        *)
            LANGS+=("$1")
            shift
            ;;
    esac
done

if [[ ${#LANGS[@]} -eq 0 ]]; then
    echo "Usage: $0 <lang|--all> [--compare] [--dry-run] [--force] [--max N] [--model sonnet|opus|haiku]"
    echo ""
    echo "Languages in tier1:"
    cat "$TIER1_FILE"
    exit 1
fi

mkdir -p "$OUTPUT_DIR" "$PROMPT_DIR"

# Allow running from inside Claude Code session by clearing env vars that
# prevent nested invocation of the claude CLI.
unset CLAUDECODE CLAUDE_AGENT_SDK_VERSION CLAUDE_CODE_ENTRYPOINT 2>/dev/null || true

translate_lang() {
    local lang="$1"
    local prompt_file="$PROMPT_DIR/$lang.txt"
    local output_file="$OUTPUT_DIR/$lang.json"

    echo "=== $lang ==="

    # Generate prompt
    python3 "$SCRIPT_DIR/translate-prompt.py" "$lang" --reference > "$prompt_file"
    echo "  Prompt: $prompt_file"

    # Skip if output already has the expected number of strings
    if ! $FORCE && [[ -f "$output_file" ]]; then
        local expected actual
        expected=$(sed -n 's/.*(\([0-9]*\) total).*/\1/p' "$prompt_file" 2>/dev/null | head -1)
        expected=${expected:-0}
        actual=$(python3 -c "import json; print(len(json.load(open('$output_file'))))" 2>/dev/null || echo 0)
        if [[ "$actual" -gt 0 ]] && [[ "$expected" -gt 0 ]] && [[ "$actual" -ge "$expected" ]]; then
            echo "  Already complete ($actual strings) — skipping (use --force to redo)"
            echo ""
            return 2
        fi
    fi

    if $DRY_RUN; then
        echo "  [DRY RUN] Would translate and save to $output_file"
        return
    fi

    # Run through Claude CLI
    # Pass prompt as argument (not stdin) to avoid known empty-output bug with
    # large stdin input (https://github.com/anthropics/claude-code/issues/7263).
    echo "  Translating with claude ($MODEL)..."
    local raw_file="$OUTPUT_DIR/$lang.raw"
    local err_file="$OUTPUT_DIR/$lang.err"
    local prompt_text
    prompt_text="$(cat "$prompt_file")"
    if ! claude -p --model "$MODEL" "$prompt_text" > "$raw_file" 2>"$err_file"; then
        echo "  ERROR: claude -p exited with non-zero status" >&2
        if [[ -s "$err_file" ]]; then
            echo "  stderr:" >&2
            sed 's/^/    /' "$err_file" >&2
        fi
        echo "  Raw output saved to $raw_file"
        return 1
    fi
    # Check for empty output (common failure mode)
    if [[ ! -s "$raw_file" ]]; then
        echo "  ERROR: claude -p produced empty output" >&2
        if [[ -s "$err_file" ]]; then
            echo "  stderr:" >&2
            sed 's/^/    /' "$err_file" >&2
        fi
        return 1
    fi
    # Extract and validate JSON using Python (avoids sed portability issues)
    python3 << PYEOF
import json, re, sys
from pathlib import Path
import os

raw = Path("$raw_file").read_text()

# Strip markdown fences if present
lines = raw.strip().splitlines()
if lines and lines[0].startswith("\`\`\`"):
    lines = lines[1:]
if lines and lines[-1].startswith("\`\`\`"):
    lines = lines[:-1]
text = "\n".join(lines).strip()

# Find the JSON object
start = text.find("{")
end = text.rfind("}")
if start == -1 or end == -1:
    print("  ERROR: No JSON object found in response", file=sys.stderr)
    sys.exit(1)

json_text = text[start:end+1]

try:
    data = json.loads(json_text)
except json.JSONDecodeError as e:
    print(f"  ERROR: Invalid JSON: {e}", file=sys.stderr)
    sys.exit(1)

# Save pretty-printed JSON
with open("$output_file", "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")

print(f"  Output: $output_file ({len(data)} strings)")

# Validate format specifiers
en_path = Path(os.path.expanduser("~/code/jstorrent/android/app/src/main/res/values/strings.xml"))
import xml.etree.ElementTree as ET
tree = ET.parse(en_path)
en = {}
for elem in tree.getroot().findall("string"):
    name = elem.get("name")
    t = elem.text or ""
    for child in elem:
        t += ET.tostring(child, encoding="unicode")
    en[name] = t

errors = 0
for key, val in data.items():
    if key not in en:
        print(f"  UNKNOWN KEY: {key}")
        errors += 1
        continue
    en_specs = sorted(re.findall(r'%\d+\\\$[sd]', en[key]))
    tr_specs = sorted(re.findall(r'%\d+\\\$[sd]', val))
    if en_specs != tr_specs:
        print(f"  SPEC ERROR {key}: expected {en_specs}, got {tr_specs}")
        errors += 1

if errors == 0:
    print("  Validation: OK")
else:
    print(f"  Validation: {errors} error(s)")

# Check completeness
expected = 185  # known unmatched count
if len(data) < expected:
    print(f"  WARNING: Only {len(data)}/{expected} strings (missing {expected - len(data)})")
elif len(data) == expected:
    print(f"  Completeness: {len(data)}/{expected} (100%)")
PYEOF

    local py_exit=$?
    if [[ $py_exit -ne 0 ]]; then
        echo "  Raw output saved to $raw_file"
        return 1
    fi

    echo "  Raw: $raw_file"

    # Compare with existing if requested
    if $COMPARE; then
        local existing="$SCRIPT_DIR/claude/$lang.txt"
        if [[ -f "$existing" ]]; then
            echo "  Comparing with existing $existing..."
            python3 << PYEOF
import json

old = json.load(open("$existing"))
new = json.load(open("$output_file"))
all_keys = sorted(set(old.keys()) | set(new.keys()))
diffs = 0
for k in all_keys:
    o = old.get(k, "MISSING")
    n = new.get(k, "MISSING")
    if o != n:
        diffs += 1
        print(f"    {k}:")
        print(f"      old: {o}")
        print(f"      new: {n}")
print(f"  {diffs} differences out of {len(all_keys)} strings")
PYEOF
        else
            echo "  No existing file to compare against"
        fi
    fi

    echo ""
}

# Track overall progress
# translate_lang returns: 0=success, 1=failure, 2=skipped
total=${#LANGS[@]}
current=0
failed=0
translated=0
skipped=0

for lang in "${LANGS[@]}"; do
    current=$((current + 1))
    echo "[$current/$total]"
    if [[ "$MAX_NEW" -gt 0 ]] && [[ "$translated" -ge "$MAX_NEW" ]]; then
        echo "  Reached --max $MAX_NEW, stopping."
        break
    fi
    translate_lang "$lang" && rc=$? || rc=$?
    if [[ $rc -eq 2 ]]; then
        skipped=$((skipped + 1))
    elif [[ $rc -ne 0 ]]; then
        failed=$((failed + 1))
        translated=$((translated + 1))
    else
        translated=$((translated + 1))
    fi
done

echo "Done: translated=$translated skipped=$skipped failed=$failed"
if [[ $failed -gt 0 ]]; then
    exit 1
fi
