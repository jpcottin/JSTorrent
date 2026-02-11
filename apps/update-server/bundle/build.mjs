import esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/server.js',
  banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
})
