import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';

const jiti = createJiti(import.meta.url, {
  alias: {
    '~': fileURLToPath(new URL('../', import.meta.url)),
    '~~': fileURLToPath(new URL('../', import.meta.url))
  }
});

await jiti.import('./verify');
