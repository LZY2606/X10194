import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createApiPlugin } from './src/server/api';

export default defineConfig({
  root: '.',
  plugins: [react(), createApiPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5254,
    strictPort: true,
  },
});
