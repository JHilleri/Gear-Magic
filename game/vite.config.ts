import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  build: {
    target: 'es2022', chunkSizeWarningLimit: 2000,
    rollupOptions: { input: { game: 'index.html', characters: 'characters.html' } },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as any);
