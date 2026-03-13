#!/usr/bin/env bash

set -euo pipefail

DEFAULT_SIM_DEVICE_NAME="${SIM_DEVICE_NAME:-iPhone 17}"

sim_list_devices() {
    xcrun simctl list devices available
}

sim_find_booted_udid() {
    sim_list_devices | sed -n 's/^    .* (\([A-F0-9-]\{36\}\)) (Booted)[[:space:]]*$/\1/p' | head -1
}

sim_find_udid_by_name() {
    local device_name="$1"

    sim_list_devices | sed -n "s/^    ${device_name//\//\\/} (\([A-F0-9-]\{36\}\)) (.*)[[:space:]]*$/\1/p" | head -1
}

sim_device_name_for_udid() {
    local udid="$1"

    sim_list_devices | sed -n "s/^    \(.*\) (${udid}) (.*)[[:space:]]*$/\1/p" | head -1
}

sim_device_state_for_udid() {
    local udid="$1"

    sim_list_devices | sed -n "s/^    .* (${udid}) (\(.*\))[[:space:]]*$/\1/p" | head -1
}

sim_resolve_udid() {
    local requested_name="${1:-$DEFAULT_SIM_DEVICE_NAME}"
    local udid=""

    udid="$(sim_find_udid_by_name "$requested_name")"
    if [[ -n "$udid" ]]; then
        printf '%s\n' "$udid"
        return 0
    fi

    udid="$(sim_list_devices | sed -n 's/^    \(iPhone.*\) (\([A-F0-9-]\{36\}\)) (.*)[[:space:]]*$/\2/p' | head -1)"
    if [[ -n "$udid" ]]; then
        printf '%s\n' "$udid"
        return 0
    fi

    udid="$(sim_list_devices | sed -n 's/^    .* (\([A-F0-9-]\{36\}\)) (.*)[[:space:]]*$/\1/p' | head -1)"
    if [[ -n "$udid" ]]; then
        printf '%s\n' "$udid"
        return 0
    fi

    echo "Error: no available simulators found." >&2
    return 1
}
