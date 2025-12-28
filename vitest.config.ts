import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Avoid implicitly loading repo-root `.env` during tests (keeps tests hermetic and prevents sandbox EPERM on ignored files).
  envDir: 'src',
  test: {
    globals: false,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});


