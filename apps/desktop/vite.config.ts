import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shiori/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@shiori/editor': fileURLToPath(new URL('../../packages/editor/src/index.tsx', import.meta.url)),
      '@shiori/schema': fileURLToPath(new URL('../../packages/schema/src/index.ts', import.meta.url)),
      '@shiori/ui': fileURLToPath(new URL('../../packages/ui/src/index.tsx', import.meta.url))
    }
  },
  server: {
    port: 5173,
    strictPort: false
  }
});

