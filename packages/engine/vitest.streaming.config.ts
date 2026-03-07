import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['integration/streaming/**/*.test.ts'],
    testTimeout: 60000, // Streaming tests involve real downloads
  },
})
