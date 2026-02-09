#!/bin/bash
# Uninstall script for JSTorrent Desktop
# Run: bash /Applications/JSTorrent.app/Contents/Resources/uninstall.sh

APP_PATH="/Applications/JSTorrent.app"

echo "Uninstalling JSTorrent..."

# Kill any running processes
echo "Stopping running processes..."
pkill -x "JSTorrent" 2>/dev/null && echo "Stopped JSTorrent" || true
pkill -x "jstorrent-host" 2>/dev/null && echo "Stopped jstorrent-host" || true
pkill -x "jstorrent-io-daemon" 2>/dev/null && echo "Stopped jstorrent-io-daemon" || true
sleep 0.5

# Remove native messaging manifests from all browsers
APP_SUPPORT="$HOME/Library/Application Support"
MANIFEST_NAME="com.jstorrent.native.json"
BROWSERS=(
    "Google/Chrome"
    "Google/Chrome Canary"
    "Chromium"
    "BraveSoftware/Brave-Browser"
    "Microsoft Edge"
    "Vivaldi"
    "Arc/User Data"
)

for browser in "${BROWSERS[@]}"; do
    MANIFEST="$APP_SUPPORT/$browser/NativeMessagingHosts/$MANIFEST_NAME"
    if [ -f "$MANIFEST" ]; then
        rm "$MANIFEST"
        echo "Removed manifest: $MANIFEST"
    fi
done

# Remove the app
if [ -d "$APP_PATH" ]; then
    rm -rf "$APP_PATH"
    echo "Removed: $APP_PATH"
fi

# Forget the package receipt
pkgutil --forget com.jstorrent.desktop 2>/dev/null || true

echo "Uninstallation complete."
