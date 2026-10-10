import esbuild from 'esbuild';
import { GasPlugin } from 'esbuild-gas-plugin';
import { copyFileSync, rmSync, mkdirSync } from 'fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  outfile: 'dist/index.js',
  plugins: [GasPlugin as unknown as esbuild.Plugin],
});

copyFileSync('appsscript.json', 'dist/appsscript.json');
console.log('Build successful: dist/index.js & dist/appsscript.json generated.');
