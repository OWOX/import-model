import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ command }) => {
  return {
    plugins: [react()],
    root: 'ui',
    base: command === 'build' ? '/import-model/' : '/',
    resolve:
      command === 'serve'
        ? { alias: { '@owox/plugin-sdk': fileURLToPath(new URL('./ui/sdk-mock.ts', import.meta.url)) } }
        : undefined,
    build: {
      outDir: '../dist',
      emptyOutDir: true,
    },
  };
});
