import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { chamberApiPlugin } from './src/server/plugin';

export default defineConfig({
  plugins: [react(), chamberApiPlugin()],
  server: { host: '127.0.0.1', port: 5254, strictPort: true },
});
