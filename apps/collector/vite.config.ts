import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    https: mode === 'local-https' ? {
      key: readFileSync(fileURLToPath(new URL('./.certs/localhost-key.pem', import.meta.url))),
      cert: readFileSync(fileURLToPath(new URL('./.certs/localhost.pem', import.meta.url))),
    } : undefined,
  },
}));
