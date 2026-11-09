import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发时 Vite 跑在 5173，接口转发给 `yuchao serve` 的 4317
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:4317' } },
});
