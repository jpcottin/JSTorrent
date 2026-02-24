import * as fs from 'node:fs'
import * as path from 'node:path'

export interface UpdateCheckEvent {
  ts: string
  ip: string
  target: string
  arch: string
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  userAgent: string
  cfuId: string
  checkReason: string
}

export class AnalyticsLogger {
  private currentDate = ''
  private stream: fs.WriteStream | null = null

  constructor(private logDir: string) {
    fs.mkdirSync(logDir, { recursive: true })
  }

  log(entry: UpdateCheckEvent): void {
    const date = new Date().toISOString().slice(0, 10)
    if (date !== this.currentDate) {
      this.stream?.end()
      this.currentDate = date
      const filePath = path.join(this.logDir, `${date}.ndjson`)
      this.stream = fs.createWriteStream(filePath, { flags: 'a' })
    }
    this.stream!.write(JSON.stringify(entry) + '\n')
  }

  close(): void {
    this.stream?.end()
    this.stream = null
  }
}
