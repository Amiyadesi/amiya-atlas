import { build } from 'esbuild';
await build({ entryPoints: ['src/app.ts', 'src/selfhost.ts', 'src/ledger.ts', 'src/billing.ts', 'src/model.ts', 'src/provision.ts', 'src/backup.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node24', outdir: 'dist', sourcemap: false });
