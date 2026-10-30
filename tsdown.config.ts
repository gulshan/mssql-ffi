import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/worker.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node26',
  dts: true,
  sourcemap: true,
  clean: true,
  publint: true,
  attw: { profile: 'esm-only' },
});
