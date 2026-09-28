// NODE_OPTIONS reaches descendants too; instrument only the real source launcher.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(join(process.env.SP_INCIDENT_PROJECT, 'scripts/superpi.mjs'))) {
  await import('./shell-incident-preload.mjs');
}
