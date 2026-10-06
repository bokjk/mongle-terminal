import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/** Keep PDF.js font/CMap and JS image decoders local in dev and packaged builds. */
export function pdfAssets(): Plugin {
  const assets = new Map<string, Buffer>();
  for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
    const directory = resolve('node_modules/pdfjs-dist', folder);
    for (const name of readdirSync(directory)) {
      if (!(/\.(bcmap|pfb|ttf)$/.test(name) || /^(openjpeg|jbig2)_nowasm_fallback\.js$/.test(name))) continue;
      assets.set(`pdf-assets/${folder}/${name}`, readFileSync(resolve(directory, name)));
    }
  }
  return {
    name: 'local-pdf-assets',
    buildStart() { for (const [fileName, source] of assets) this.emitFile({ type: 'asset', fileName, source }); },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = new URL(req.url || '/', 'http://localhost').pathname.slice(1), bytes = assets.get(name);
        if (!bytes) return next();
        res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'); res.end(bytes);
      });
    },
  };
}
