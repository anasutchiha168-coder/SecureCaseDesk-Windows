const esbuild = require('esbuild');
const path = require('path');
require('fs').mkdirSync('out',{recursive:true});require('fs').copyFileSync('index.template.html','out/index.html');
esbuild.build({
  entryPoints: ['entry.tsx'], bundle: true, outfile: 'out/bundle.js', format: 'iife', jsx: 'transform', logLevel: 'info',
  nodePaths: (process.env.NODE_PATH || '').split(require('path').delimiter).filter(Boolean),
  alias: { 'react-native': path.resolve('mocks/rn.tsx'), 'lucide-react-native': path.resolve('mocks/lucide.tsx'), 'expo-router': path.resolve('mocks/expo-router-real.tsx') },
  define: { 'process.env.NODE_ENV': '"development"' },
}).catch(() => process.exit(1));
