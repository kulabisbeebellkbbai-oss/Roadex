import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    exclude: [...configDefaults.exclude, '**/.worktrees/**'],
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8780',
    },
  },
});
