import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    setupFiles: ['tests/setup.ts'],
    hookTimeout: 40_000,
    testTimeout: 20_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://chat:chat@127.0.0.1:5432/chat_test?schema=public',
      REDIS_URL: 'redis://127.0.0.1:6379/3',
      FIREBASE_PROJECT_ID: 'demo-chat',
      LOG_LEVEL: 'error',
      RATE_LIMIT_MAX: '5000',
      EDIT_WINDOW_MS: '900000',
      WORKER_ENABLED: 'false',
    },
  },
})
