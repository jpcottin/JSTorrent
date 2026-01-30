#!/usr/bin/env python3
"""
Benchmark download speed using Chrome extension on ChromeOS.

Prerequisites:
1. SSH tunnel: ssh -L 9222:127.0.0.1:9222 chromebook
2. Extension deployed: ./scripts/deploy-chromebook.sh
3. 1GB seeder running: pnpm seed-for-test --size 1gb

Usage:
    uv run python benchmark_extension_download.py

Environment:
    SEEDER_IP - IP of the seeder (default: from ~/.jstorrent-devices)
    SEEDER_PORT - Port of the seeder (default: 6881)
"""

import argparse
import asyncio
import os
import sys
from pathlib import Path

# Add parent to path for jst module
sys.path.insert(0, str(Path(__file__).parent))

import time

from jst.extension import JSTExtension, ExtensionConfig


async def wait_for_download_verbose(ext: JSTExtension, info_hash: str, timeout: float = 300, poll: float = 1.0) -> float:
    """Wait for download with verbose engine stats."""
    start = time.time()
    last_stats_time = 0

    while True:
        status = await ext.get_torrent_status(info_hash)
        if not status:
            raise RuntimeError(f"Torrent {info_hash} not found")

        progress = status.get("progress", 0)
        speed = status.get("downloadSpeed", 0) / 1024 / 1024  # MB/s
        peers = status.get("connectedPeers", 0)

        # Get engine stats every 5 seconds
        now = time.time()
        stats_str = ""
        if now - last_stats_time >= 5:
            try:
                engine_stats = await ext.get_engine_stats()
                if engine_stats:
                    io = engine_stats.get("ioBridge", {})
                    pending = io.get("pendingWrites", 0)
                    batch_q = io.get("batchQueue", 0)
                    if pending or batch_q:
                        stats_str = f" | IO: writes={pending}, batch={batch_q}"
                last_stats_time = now
            except Exception:
                pass  # Ignore stats errors

        print(f"\rProgress: {progress*100:5.1f}% | Speed: {speed:5.1f} MB/s | Peers: {peers}{stats_str}    ", end="", flush=True)

        if status.get("isComplete") or progress >= 1.0:
            print()  # newline
            return time.time() - start

        if time.time() - start > timeout:
            print()
            raise TimeoutError(f"Download did not complete within {timeout}s")

        await asyncio.sleep(poll)


def load_devices_config() -> dict:
    """Load device config from ~/.jstorrent-devices."""
    config_path = Path.home() / ".jstorrent-devices"
    if not config_path.exists():
        return {}

    config = {}
    for line in config_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, value = line.split("=", 1)
            config[key.strip()] = value.strip()
    return config


def get_seeder_address() -> tuple[str, int]:
    """Get seeder IP:port from env or config."""
    # Check environment first
    seeder_ip = os.environ.get("SEEDER_IP")
    seeder_port = int(os.environ.get("SEEDER_PORT", "6881"))

    if seeder_ip:
        return seeder_ip, seeder_port

    # Fall back to devices config
    devices = load_devices_config()
    seeder = devices.get("seeder", "")
    if ":" in seeder:
        ip, port = seeder.rsplit(":", 1)
        return ip, int(port)
    elif seeder:
        return seeder, 6881

    raise RuntimeError(
        "No seeder configured. Set SEEDER_IP env var or add 'seeder=ip:port' to ~/.jstorrent-devices"
    )


async def run_benchmark(args):
    """Run the download benchmark."""
    seeder_ip, seeder_port = get_seeder_address()

    # Build magnet link for 1GB test file
    # This assumes the seeder is running with: pnpm seed-for-test --size 1gb
    # The info hash is deterministic for the test file
    # Info hash for 1GB test file from pnpm seed-for-test --size 1gb
    magnet = (
        f"magnet:?xt=urn:btih:18a7aacab6d2bc518e336921ccd4b6cc32a9624b"
        f"&dn=testdata_1gb.bin"
        f"&x.pe={seeder_ip}:{seeder_port}"
    )

    print("=" * 50)
    print("Extension Download Benchmark")
    print("=" * 50)
    print(f"Seeder: {seeder_ip}:{seeder_port}")
    print(f"Size: 1 GB")
    print()

    config = ExtensionConfig(
        cdp_host=args.cdp_host,
        cdp_port=args.cdp_port,
        extension_id=args.extension_id,
        adb_host=args.adb_host,
    )

    async with JSTExtension(config, reload_extension=args.reload) as ext:
        # Start log collection before downloading
        print("Starting log collection...")
        await ext.start_log_collection()

        # Clear any existing torrents
        print("Clearing existing torrents...")
        await ext.remove_all_torrents(delete_data=True)

        # Add the benchmark torrent
        print(f"Adding torrent...")
        info_hash = await ext.add_magnet(magnet)
        print(f"Info hash: {info_hash}")

        # Wait for download with verbose stats
        print("\nDownloading...")
        try:
            elapsed = await wait_for_download_verbose(ext, info_hash, timeout=args.timeout)
        except TimeoutError:
            print(f"\nDownload timed out after {args.timeout}s")
            status = await ext.get_torrent_status(info_hash)
            if status:
                print(f"Final progress: {status.get('progress', 0) * 100:.1f}%")
            return

        # Calculate results
        size_mb = 1024  # 1 GB
        speed = size_mb / elapsed

        print()
        print("=" * 50)
        print("Results")
        print("=" * 50)
        print(f"Time: {elapsed:.0f}s")
        print(f"Average: {speed:.1f} MB/s")

        # Get and display batch write histogram
        histogram = await ext.get_batch_write_histogram()
        if histogram:
            print()
            print("HTTP Upload Size Histogram:")
            print(f"  Total batches: {histogram.get('totalBatches', 0)}")
            total_bytes = histogram.get('totalBatchBytes', 0)
            print(f"  Total bytes: {total_bytes / 1024 / 1024:.1f} MB")
            print(f"  Avg batch size: {histogram.get('avgBatchBytes', 0) / 1024:.1f} KB")

            size_dist = histogram.get('sizeDistribution', {})
            if size_dist:
                print("  Size distribution:")
                for bucket, count in size_dist.items():
                    print(f"    {bucket}: {count}")

            count_dist = histogram.get('countDistribution', {})
            if count_dist:
                print("  Writes per batch:")
                for count, freq in sorted(count_dist.items(), key=lambda x: int(x[0].replace('+', ''))):
                    print(f"    {count}: {freq}")

        print()

        # Save and show collected logs
        logs = ext.get_logs()
        if logs:
            # Save full logs to disk
            timestamp = time.strftime("%Y%m%d-%H%M%S")
            log_file = Path(f"benchmark-logs-{timestamp}.txt")
            with open(log_file, "w") as f:
                f.write(f"Extension Download Benchmark Logs\n")
                f.write(f"Time: {elapsed:.0f}s, Average: {speed:.1f} MB/s\n")
                f.write(f"Seeder: {seeder_ip}:{seeder_port}\n")
                f.write(f"Total entries: {len(logs)}\n")
                f.write("=" * 60 + "\n\n")
                for log in logs:
                    level = log.level.upper()[:4]
                    f.write(f"[{level}] {log.text}\n")
            print(f"Logs saved to: {log_file} ({len(logs)} entries)")

            if args.show_logs:
                print()
                print("=" * 50)
                print(f"Logs (last 50 of {len(logs)} entries)")
                print("=" * 50)
                for log in logs[-50:]:
                    level = log.level.upper()[:4]
                    print(f"[{level}] {log.text}")
                print()

        # Cleanup
        print("Cleaning up...")
        await ext.remove_torrent(info_hash, delete_data=True)
        print("Done.")


def main():
    parser = argparse.ArgumentParser(description="Benchmark extension download speed")
    parser.add_argument(
        "--cdp-host",
        default="localhost",
        help="CDP host (default: localhost, assumes SSH tunnel)",
    )
    parser.add_argument(
        "--cdp-port",
        type=int,
        default=9222,
        help="CDP port (default: 9222)",
    )
    parser.add_argument(
        "--extension-id",
        default="dbokmlpefliilbjldladbimlcfgbolhk",
        help="Extension ID",
    )
    parser.add_argument(
        "--adb-host",
        default="chromebook",
        help="SSH host for adb commands (default: chromebook)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=300,
        help="Download timeout in seconds (default: 300)",
    )
    parser.add_argument(
        "--show-logs",
        action="store_true",
        help="Show collected console logs after download",
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Reload extension before benchmarking (use after code changes)",
    )
    args = parser.parse_args()

    asyncio.run(run_benchmark(args))


if __name__ == "__main__":
    main()
