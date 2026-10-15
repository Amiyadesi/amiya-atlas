import { copyFileSync } from 'node:fs';

// Include Pages routing configuration alongside the generated assets.
for (const name of ['_worker.js', '_routes.json', '_headers']) {
  copyFileSync(new URL(`static/${name}`, import.meta.url), new URL(`build/${name}`, import.meta.url));
}
