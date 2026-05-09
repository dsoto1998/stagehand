import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['renderer/js/**/*.js'],
      exclude: ['renderer/js/rubberband-processor.js', 'renderer/js/soundtouch-processor.js'],
    },
  },
});
