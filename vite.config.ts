import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({root:resolve('apps/web'),plugins:[react()],base:'./',build:{outDir:resolve('dist/web'),emptyOutDir:true},server:{host:'127.0.0.1',strictPort:true,port:5173}});
