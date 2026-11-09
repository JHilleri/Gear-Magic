// Dev-only config for the world renderer harness (port 5191).
// WORLD_STUB_LAYERS=1 swaps the entity layers (units/buildings/overlays/fx) for no-op stubs so
// terrain work can continue while those modules are mid-edit.
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const stubFile = fileURLToPath(new URL('../src/dev/layer-stubs.ts', import.meta.url));
const stub = process.env.WORLD_STUB_LAYERS === '1';

const stubLayers: Plugin = {
  name: 'world-dev-stub-layers',
  enforce: 'pre',
  resolveId(source, importer) {
    if (importer && /[\\/]render[\\/]world\.ts$/.test(importer) && /^\.\/(units|buildings|overlays|fx)$/.test(source)) return stubFile;
    return null;
  },
};

export default defineConfig({
  root,
  plugins: [preact(), ...(stub ? [stubLayers] : [])],
  server: { host: '127.0.0.1', port: 5191, strictPort: true },
});
