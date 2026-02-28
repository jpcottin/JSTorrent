import * as fs from 'node:fs'
import * as path from 'node:path'
import type { UpdateCheckEvent } from './analytics.js'

interface DayStats {
  /** version -> set of client IDs */
  clients: Record<string, string[]>
  /** version -> request count */
  requests: Record<string, number>
  /** platform-arch -> request count */
  platforms: Record<string, number>
}

interface StatsCache {
  /** Aggregated stats for completed days (won't change) */
  days: Record<string, DayStats>
  /** ISO date string of the last day we cached (today's data is always re-parsed) */
  lastCachedDate: string
}

const cache: StatsCache = { days: {}, lastCachedDate: '' }

function parseDayFile(filePath: string): UpdateCheckEvent[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const events: UpdateCheckEvent[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // skip malformed lines
      }
    }
    return events
  } catch {
    return []
  }
}

function aggregateDay(events: UpdateCheckEvent[]): DayStats {
  const clients: Record<string, Set<string>> = {}
  const requests: Record<string, number> = {}
  const platforms: Record<string, number> = {}

  for (const e of events) {
    const v = e.currentVersion || 'unknown'
    const clientId = e.cfuId || e.ip || 'unknown'

    if (!clients[v]) clients[v] = new Set()
    clients[v].add(clientId)

    requests[v] = (requests[v] || 0) + 1

    const plat = `${e.target || 'unknown'}-${e.arch || 'unknown'}`
    platforms[plat] = (platforms[plat] || 0) + 1
  }

  // Convert sets to arrays for JSON serialization
  const clientArrays: Record<string, string[]> = {}
  for (const [v, set] of Object.entries(clients)) {
    clientArrays[v] = [...set]
  }

  return { clients: clientArrays, requests, platforms }
}

function loadStats(logDir: string): Record<string, DayStats> {
  const today = new Date().toISOString().slice(0, 10)
  // Yesterday is the latest day we can safely cache
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

  // Find all log files
  let files: string[]
  try {
    files = fs.readdirSync(logDir).filter((f) => f.endsWith('.ndjson')).sort()
  } catch {
    return cache.days
  }

  const result: Record<string, DayStats> = {}

  for (const file of files) {
    const date = file.replace('.ndjson', '')

    // Use cached data for completed days
    if (date <= yesterday && cache.days[date]) {
      result[date] = cache.days[date]
      continue
    }

    // Parse the file
    const events = parseDayFile(path.join(logDir, file))
    if (events.length === 0) continue

    const stats = aggregateDay(events)
    result[date] = stats

    // Cache completed days
    if (date <= yesterday) {
      cache.days[date] = stats
    }
  }

  cache.lastCachedDate = today
  return result
}

const VERSION_COLORS = [
  '#9e9e9e', // grey (oldest)
  '#e91e63', // pink
  '#ff9800', // orange
  '#4caf50', // green
  '#2196f3', // blue
  '#9c27b0', // purple
  '#00bcd4', // cyan
  '#f44336', // red
  '#8bc34a', // light green
  '#ff5722', // deep orange
]

function verKey(v: string): number[] {
  return v.split('.').map((s) => parseInt(s, 10) || 0)
}

function sortVersions(versions: string[]): string[] {
  return [...versions].sort((a, b) => {
    const ka = verKey(a)
    const kb = verKey(b)
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const diff = (ka[i] || 0) - (kb[i] || 0)
      if (diff !== 0) return diff
    }
    return 0
  })
}

export function generateStatsHtml(logDir: string): string {
  const allDays = loadStats(logDir)
  const dates = Object.keys(allDays).sort()

  if (dates.length === 0) {
    return '<html><body><p>No data yet.</p></body></html>'
  }

  // Collect all versions seen
  const versionSet = new Set<string>()
  for (const day of Object.values(allDays)) {
    for (const v of Object.keys(day.clients)) {
      versionSet.add(v)
    }
  }
  const versions = sortVersions([...versionSet])

  // Check if any cfuId data exists
  let hasCfuId = false
  outer: for (const day of Object.values(allDays)) {
    for (const ids of Object.values(day.clients)) {
      for (const id of ids) {
        // cfuId is a UUID, IPs contain dots/colons
        if (id.length > 20 && !id.includes('.') && !id.includes(':')) {
          hasCfuId = true
          break outer
        }
      }
    }
  }

  // Build chart datasets
  const datasets: object[] = []
  for (let i = 0; i < versions.length; i++) {
    const v = versions[i]
    const color = VERSION_COLORS[i % VERSION_COLORS.length]
    const data = dates.map((d) => allDays[d]?.clients[v]?.length || 0)
    datasets.push({
      label: v,
      data,
      borderColor: color,
      backgroundColor: color + '18',
      borderWidth: 2,
      tension: 0.3,
      fill: false,
      pointRadius: 2,
    })
  }

  // "All versions" total line
  const totals = dates.map((d) => {
    const day = allDays[d]
    const allClients = new Set<string>()
    for (const ids of Object.values(day.clients)) {
      for (const id of ids) allClients.add(id)
    }
    return allClients.size
  })
  datasets.push({
    label: 'All versions',
    data: totals,
    borderColor: '#111827',
    backgroundColor: '#11182708',
    borderWidth: 2.5,
    tension: 0.3,
    fill: false,
    pointRadius: 2,
  })

  // Aggregate platform stats
  const platformTotals: Record<string, number> = {}
  for (const day of Object.values(allDays)) {
    for (const [plat, count] of Object.entries(day.platforms)) {
      platformTotals[plat] = (platformTotals[plat] || 0) + count
    }
  }
  const platformStr = Object.entries(platformTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([p, c]) => `${p}: ${c}`)
    .join(', ')

  // Latest version for subtitle
  const latestVersion = versions[versions.length - 1]
  const totalRequests = Object.values(allDays).reduce(
    (sum, d) => sum + Object.values(d.requests).reduce((s, c) => s + c, 0),
    0,
  )
  const idMethod = hasCfuId ? 'cfuId + IP fallback' : 'IP-based only (cfuId not yet available)'

  const labelsJson = JSON.stringify(dates)
  const datasetsJson = JSON.stringify(datasets)
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JSTorrent Tauri — Update Stats</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 1200px;
    margin: 40px auto;
    padding: 0 20px;
    background: #fafafa;
    color: #1a1a1a;
  }
  h1 { font-size: 20px; font-weight: 500; margin-bottom: 4px; }
  .subtitle { color: #666; font-size: 13px; margin-bottom: 24px; }
  .chart-container {
    background: white;
    border-radius: 8px;
    padding: 24px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }
  canvas { max-height: 500px; }
  .meta {
    display: flex;
    gap: 32px;
    margin-top: 16px;
    font-size: 12px;
    color: #888;
  }
  .meta span { white-space: nowrap; }
</style>
</head>
<body>
<h1>Installed audience — Tauri Desktop App</h1>
<div class="subtitle">
  Unique users, per day &middot; Latest: ${latestVersion} &middot; Client ID: ${idMethod}
</div>
<div class="chart-container">
  <canvas id="chart"></canvas>
</div>
<div class="meta">
  <span>Total update checks: ${totalRequests}</span>
  <span>Platforms: ${platformStr}</span>
  <span>Generated ${now} UTC</span>
</div>
<script>
new Chart(document.getElementById('chart'), {
  type: 'line',
  data: {
    labels: ${labelsJson},
    datasets: ${datasetsJson}
  },
  options: {
    responsive: true,
    maintainAspectRatio: true,
    interaction: {
      mode: 'index',
      intersect: false
    },
    plugins: {
      legend: {
        position: 'bottom',
        labels: { usePointStyle: true, padding: 16, font: { size: 12 } }
      }
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { maxTicksLimit: 15, font: { size: 11 } }
      },
      y: {
        beginAtZero: true,
        grid: { color: '#f0f0f0' },
        ticks: { stepSize: 1, font: { size: 11 } }
      }
    }
  }
});
</script>
</body>
</html>`
}
