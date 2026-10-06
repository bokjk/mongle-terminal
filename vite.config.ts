import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { pdfAssets } from './scripts/pdf-assets.ts';
export default defineConfig({root:resolve('apps/web'),plugins:[react(),pdfAssets()],base:'./',
  // The browser variant uses document.createElement; workers need its published DOM-free decoder.
  resolve:{alias:[{find:/^decode-named-character-reference$/,replacement:resolve('node_modules/decode-named-character-reference/index.js')}]},
  build:{outDir:resolve('dist/web'),emptyOutDir:true},server:{host:'127.0.0.1',strictPort:true,port:5173}});
