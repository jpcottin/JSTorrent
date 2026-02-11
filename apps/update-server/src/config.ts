export const config = {
  port: parseInt(process.env.PORT || '3100', 10),
  githubRepo: 'kzahel/JSTorrent',
  tagPrefix: 'tauri-app-v',
  cacheTtlMs: 5 * 60 * 1000, // 5 minutes
  logDir: process.env.LOG_DIR || './logs',
  githubToken: process.env.GITHUB_TOKEN || '',
}
