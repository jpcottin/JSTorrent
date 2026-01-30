"""
Chrome extension control via CDP.

Similar interface to JSTEngine but communicates via Chrome DevTools Protocol
instead of HTTP RPC. Used for testing/benchmarking the real extension on ChromeOS.

Requires:
- SSH tunnel to chromebook: ssh -L 9222:127.0.0.1:9222 chromebook
- Extension loaded in Chrome
- Android companion app running
"""

import asyncio
import json
import subprocess
import time
from dataclasses import dataclass, field
from typing import Any

import aiohttp
import websockets


@dataclass
class ExtensionConfig:
    """Configuration for connecting to Chrome extension."""
    cdp_host: str = "localhost"
    cdp_port: int = 9222
    extension_id: str = "dbokmlpefliilbjldladbimlcfgbolhk"
    # SSH host for adb commands (None = local adb)
    adb_host: str | None = "chromebook"
    adb_path: str = "/home/graehlarts/android-sdk/platform-tools/adb"
    companion_package: str = "com.jstorrent.app"
    companion_activity: str = ".MainActivity"


@dataclass
class LogEntry:
    """A captured console log entry."""
    timestamp: float
    level: str  # log, warn, error, info, debug
    text: str


class JSTExtension:
    """
    Control Chrome extension via CDP.

    Usage:
        async with JSTExtension(config) as ext:
            ext.start_log_collection()
            tid = await ext.add_magnet(magnet)
            await ext.wait_for_download(tid)
            logs = ext.get_logs()
    """

    def __init__(self, config: ExtensionConfig | None = None, reload_extension: bool = False):
        self.config = config or ExtensionConfig()
        self._reload_extension = reload_extension
        self._sw_ws_url: str | None = None
        self._page_ws_url: str | None = None
        self._msg_id = 0
        # Persistent connection for log collection
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._log_task: asyncio.Task | None = None
        self._logs: list[LogEntry] = []
        self._pending_responses: dict[int, asyncio.Future] = {}

    async def __aenter__(self):
        await self.setup(reload_extension=self._reload_extension)
        return self

    async def __aexit__(self, *args):
        await self.stop_log_collection()

    # =========================================================================
    # Setup
    # =========================================================================

    async def setup(self, reload_extension: bool = False):
        """Ensure companion app running and extension ready.

        Args:
            reload_extension: If True, reload extension to get fresh code.
                             Note: After code changes, manually reload via chrome://extensions
                             or use --reload flag.
        """
        await self.ensure_companion_running()
        if reload_extension:
            await self.reload_extension()
            await self.ensure_extension_page_open()
            await self.wait_for_engine_ready(timeout=60)  # Fresh pages need more time
        else:
            await self.ensure_extension_page_open()
            await self.wait_for_engine_ready(timeout=30)

    async def reload_extension(self):
        """Reload entire extension via chrome.runtime.reload().

        This closes all extension pages, so ensure_extension_page_open will open a fresh one.
        """
        sw = await self._find_service_worker()
        if not sw:
            print("No service worker found, cannot reload extension")
            return

        ws_url = sw.get("webSocketDebuggerUrl")
        if not ws_url:
            print("Service worker has no debugger URL")
            return

        # Trigger chrome.runtime.reload()
        print("Reloading extension via chrome.runtime.reload()...")
        try:
            await self._cdp_evaluate_oneshot(ws_url, "chrome.runtime.reload()", await_promise=False)
        except Exception:
            pass  # Connection closes when extension reloads

        # Wait for extension to restart
        await asyncio.sleep(3)
        self._page_ws_url = None  # Force re-finding page
        print("Extension reloaded")

    def _adb_cmd(self, *args) -> list[str]:
        """Build adb command, optionally via SSH."""
        if self.config.adb_host:
            adb_args = " ".join(args)
            return ["ssh", self.config.adb_host, f"{self.config.adb_path} {adb_args}"]
        else:
            return ["adb", *args]

    async def ensure_companion_running(self):
        """Start Android companion app if not running."""
        # Check if already running
        cmd = self._adb_cmd("shell", "pidof", self.config.companion_package)
        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode == 0 and result.stdout.strip():
            print(f"Companion app already running (pid {result.stdout.strip()})")
            return

        # Start the app
        component = f"{self.config.companion_package}/{self.config.companion_activity}"
        cmd = self._adb_cmd("shell", "am", "start", "-n", component)
        subprocess.run(cmd, check=True)
        print("Started companion app")

        # Wait for it to be ready
        await asyncio.sleep(2)

    async def ensure_extension_page_open(self):
        """Ensure extension page is open (where engine lives)."""
        # First check if there's already an extension page
        page = await self._find_extension_page()
        if page:
            self._page_ws_url = page.get("webSocketDebuggerUrl")
            print(f"Found existing extension page")
            return

        # Need to open one - use service worker to create tab
        sw = await self._find_service_worker()
        if not sw:
            raise RuntimeError("Extension service worker not found")

        ws_url = sw.get("webSocketDebuggerUrl")
        if not ws_url:
            raise RuntimeError("Service worker has no debugger URL")

        # Create a new tab with extension page
        ext_url = f"chrome-extension://{self.config.extension_id}/src/ui/app.html"
        result = await self._cdp_evaluate_oneshot(
            ws_url,
            f'chrome.tabs.create({{ url: "{ext_url}" }})'
        )
        print(f"Opened extension page")

        # Wait for page to load and find it
        await asyncio.sleep(1)
        page = await self._find_extension_page()
        if page:
            self._page_ws_url = page.get("webSocketDebuggerUrl")

    async def wait_for_engine_ready(self, timeout: float = 30):
        """Wait for engine to be initialized."""
        if not self._page_ws_url:
            raise RuntimeError("No extension page available")

        start = time.time()
        while time.time() - start < timeout:
            result = await self._cdp_evaluate_oneshot(
                self._page_ws_url,
                "typeof globalThis.engine !== 'undefined' && globalThis.engine !== null"
            )
            if result.get("result", {}).get("result", {}).get("value") is True:
                print("Engine ready")
                return
            await asyncio.sleep(0.5)

        raise TimeoutError("Engine not ready within timeout")

    # =========================================================================
    # CDP Helpers
    # =========================================================================

    async def _cdp_get_targets(self) -> list[dict]:
        """Get all CDP targets."""
        url = f"http://{self.config.cdp_host}:{self.config.cdp_port}/json"
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as resp:
                return await resp.json()

    async def _find_service_worker(self) -> dict | None:
        """Find extension's service worker target."""
        targets = await self._cdp_get_targets()
        for t in targets:
            if t.get("type") == "service_worker":
                url = t.get("url", "")
                if self.config.extension_id in url:
                    return t
        return None

    async def _find_extension_page(self) -> dict | None:
        """Find extension page target."""
        targets = await self._cdp_get_targets()
        for t in targets:
            if t.get("type") == "page":
                url = t.get("url", "")
                if f"chrome-extension://{self.config.extension_id}" in url:
                    return t
        return None

    async def _cdp_evaluate_oneshot(self, ws_url: str, expression: str, await_promise: bool = True) -> dict:
        """Evaluate JavaScript using a one-shot websocket connection."""
        self._msg_id += 1
        msg_id = self._msg_id

        async with websockets.connect(ws_url) as ws:
            request = {
                "id": msg_id,
                "method": "Runtime.evaluate",
                "params": {
                    "expression": expression,
                    "returnByValue": True,
                    "awaitPromise": await_promise,
                }
            }
            await ws.send(json.dumps(request))

            async def wait_for_response():
                while True:
                    response = json.loads(await ws.recv())
                    if response.get("id") == msg_id:
                        return response

            return await asyncio.wait_for(wait_for_response(), timeout=30)

    async def _ensure_persistent_connection(self):
        """Ensure we have a persistent websocket connection for log collection."""
        if self._ws is not None:
            return

        if not self._page_ws_url:
            raise RuntimeError("No extension page available")

        self._ws = await websockets.connect(self._page_ws_url)

        # Start background task to receive messages
        self._log_task = asyncio.create_task(self._receive_loop())

    async def _receive_loop(self):
        """Background task to receive CDP messages and dispatch them."""
        try:
            async for message in self._ws:
                data = json.loads(message)

                # Check if this is a response to a request
                if "id" in data:
                    msg_id = data["id"]
                    if msg_id in self._pending_responses:
                        self._pending_responses[msg_id].set_result(data)
                        del self._pending_responses[msg_id]

                # Check for console events
                elif data.get("method") == "Runtime.consoleAPICalled":
                    self._handle_console_event(data)

        except websockets.exceptions.ConnectionClosed:
            pass
        except asyncio.CancelledError:
            pass

    def _handle_console_event(self, data: dict):
        """Handle a Runtime.consoleAPICalled event."""
        params = data.get("params", {})
        level = params.get("type", "log")  # log, warn, error, info, debug
        args = params.get("args", [])
        timestamp = params.get("timestamp", time.time() * 1000) / 1000

        # Convert args to text
        parts = []
        for arg in args:
            if arg.get("type") == "string":
                parts.append(arg.get("value", ""))
            elif "description" in arg:
                parts.append(arg["description"])
            elif "value" in arg:
                parts.append(str(arg["value"]))
            else:
                parts.append(str(arg))

        text = " ".join(parts)
        self._logs.append(LogEntry(timestamp=timestamp, level=level, text=text))

    async def _cdp_send(self, method: str, params: dict = None) -> dict:
        """Send a CDP command over the persistent connection."""
        await self._ensure_persistent_connection()

        self._msg_id += 1
        msg_id = self._msg_id

        request = {
            "id": msg_id,
            "method": method,
            "params": params or {},
        }

        # Create future for response
        future = asyncio.get_event_loop().create_future()
        self._pending_responses[msg_id] = future

        await self._ws.send(json.dumps(request))

        return await asyncio.wait_for(future, timeout=30)

    async def evaluate(self, expression: str) -> Any:
        """Evaluate JS in extension page and return result value."""
        if self._ws:
            # Use persistent connection if available
            response = await self._cdp_send("Runtime.evaluate", {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
            })
        else:
            # Fall back to one-shot connection
            if not self._page_ws_url:
                raise RuntimeError("No extension page available")
            response = await self._cdp_evaluate_oneshot(self._page_ws_url, expression)

        # Check for errors
        if "error" in response:
            raise RuntimeError(f"CDP error: {response['error']}")

        # CDP response structure: { "result": { "result": { "value": ... }, "exceptionDetails": ... } }
        outer_result = response.get("result", {})
        if outer_result.get("exceptionDetails"):
            exc = outer_result["exceptionDetails"]
            raise RuntimeError(f"JS exception: {exc}")

        return outer_result.get("result", {}).get("value")

    # =========================================================================
    # Log Collection
    # =========================================================================

    async def start_log_collection(self):
        """Start collecting console logs from the extension page."""
        await self._ensure_persistent_connection()

        # Enable Runtime domain to receive console events
        await self._cdp_send("Runtime.enable")

        # Clear any existing logs
        self._logs.clear()

    async def stop_log_collection(self):
        """Stop log collection and close persistent connection."""
        if self._log_task:
            self._log_task.cancel()
            try:
                await self._log_task
            except asyncio.CancelledError:
                pass
            self._log_task = None

        if self._ws:
            await self._ws.close()
            self._ws = None

    def get_logs(self, level: str | None = None) -> list[LogEntry]:
        """Get collected logs, optionally filtered by level."""
        if level:
            return [log for log in self._logs if log.level == level]
        return list(self._logs)

    def clear_logs(self):
        """Clear collected logs."""
        self._logs.clear()

    # =========================================================================
    # Engine Control (similar to JSTEngine interface)
    # =========================================================================

    async def add_magnet(self, magnet: str) -> str:
        """Add torrent by magnet link, return info hash."""
        # engine.addTorrent returns { torrent, isDuplicate }
        # We return the hex info hash as the ID
        result = await self.evaluate(f'''
            (async () => {{
                const {{ torrent }} = await window.engine.addTorrent({json.dumps(magnet)});
                // Convert Uint8Array infoHash to hex string
                return Array.from(torrent.infoHash).map(b => b.toString(16).padStart(2, '0')).join('');
            }})()
        ''')
        return result

    async def get_torrent_status(self, info_hash: str) -> dict:
        """Get torrent status by info hash."""
        result = await self.evaluate(f'''
            (() => {{
                const torrent = window.engine.torrents.find(t => {{
                    const hex = Array.from(t.infoHash).map(b => b.toString(16).padStart(2, '0')).join('');
                    return hex === {json.dumps(info_hash)};
                }});
                if (!torrent) return null;
                return {{
                    progress: torrent.progress,
                    downloadSpeed: torrent.downloadSpeed || 0,
                    uploadSpeed: torrent.uploadSpeed || 0,
                    connectedPeers: torrent.connectedPeers?.length || 0,
                    isComplete: torrent.isComplete,
                    state: torrent.state,
                    errorMessage: torrent.errorMessage,
                    name: torrent.name,
                }};
            }})()
        ''')
        return result

    async def remove_torrent(self, info_hash: str, delete_data: bool = False):
        """Remove torrent by info hash."""
        method = "removeTorrentWithData" if delete_data else "removeTorrent"
        await self.evaluate(f'''
            (async () => {{
                const torrent = window.engine.torrents.find(t => {{
                    const hex = Array.from(t.infoHash).map(b => b.toString(16).padStart(2, '0')).join('');
                    return hex === {json.dumps(info_hash)};
                }});
                if (torrent) {{
                    await window.engine.{method}(torrent);
                }}
            }})()
        ''')

    async def get_all_torrents(self) -> list[dict]:
        """Get list of all torrents (returns info hashes)."""
        result = await self.evaluate('''
            window.engine.torrents.map(t => ({
                infoHash: Array.from(t.infoHash).map(b => b.toString(16).padStart(2, '0')).join(''),
                name: t.name,
                progress: t.progress,
                isComplete: t.isComplete,
            }))
        ''')
        return result or []

    async def remove_all_torrents(self, delete_data: bool = False):
        """Remove all torrents."""
        torrents = await self.get_all_torrents()
        for t in torrents:
            await self.remove_torrent(t["infoHash"], delete_data)

    # =========================================================================
    # Test Helpers
    # =========================================================================

    async def wait_for_download(self, info_hash: str, timeout: float = 300, poll: float = 1.0) -> float:
        """
        Wait for download to complete.

        Returns elapsed time in seconds.
        """
        start = time.time()
        while True:
            status = await self.get_torrent_status(info_hash)
            if not status:
                raise RuntimeError(f"Torrent {info_hash} not found")

            progress = status.get("progress", 0)
            speed = status.get("downloadSpeed", 0) / 1024 / 1024  # MB/s
            peers = status.get("connectedPeers", 0)

            print(f"\rProgress: {progress*100:5.1f}% | Speed: {speed:5.1f} MB/s | Peers: {peers}", end="", flush=True)

            if status.get("isComplete") or progress >= 1.0:
                print()  # newline
                return time.time() - start

            if time.time() - start > timeout:
                print()
                raise TimeoutError(f"Download did not complete within {timeout}s")

            await asyncio.sleep(poll)

    # =========================================================================
    # Engine Stats
    # =========================================================================

    async def get_engine_stats(self) -> dict:
        """Get engine-wide stats including IO bridge state."""
        return await self.evaluate('''
            (() => {
                const stats = {};

                // IO Bridge stats (if available)
                if (typeof ioBridge !== 'undefined') {
                    const state = ioBridge.getState?.() || {};
                    stats.ioBridge = {
                        pendingWrites: state.pendingWrites || 0,
                        pendingReads: state.pendingReads || 0,
                        batchQueue: state.batchQueue || 0,
                    };
                }

                // Daemon connection stats
                if (window.engine?.daemonConnection) {
                    const dc = window.engine.daemonConnection;
                    stats.daemonConnection = {
                        ready: dc.ready,
                        reconnecting: dc.reconnecting,
                    };
                }

                return stats;
            })()
        ''')

    async def get_batch_write_histogram(self) -> dict | None:
        """Get histogram of HTTP upload sizes for verified batch writes."""
        return await self.evaluate('''
            (() => {
                if (typeof window.getBatchWriteHistogram === 'function') {
                    return window.getBatchWriteHistogram();
                }
                return null;
            })()
        ''')
