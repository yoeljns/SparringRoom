/**
 * Generates, from the TypeScript sources of truth:
 *   /contracts/v1/<type>.json        Logo CSV contract v1
 *   /contracts/samples/<file>.csv    one realistic sample per file type
 *   src/labels/templates.generated.ts  copy of /labels/*.zpl
 * Run: pnpm --filter domain gen
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOGO_FILE_TYPES, buildLogoFile, logoContractJson } from '../src/logo-contract';
import { SAMPLE_DATE, SAMPLE_ROWS } from './samples';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');

export function generatedTemplatesSource(): string {
  const names = ['pallet', 'location', 'carton'];
  const entries = names
    .map((n) => `  ${n}: ${JSON.stringify(readFileSync(join(root, 'labels', `${n}.zpl`), 'utf8'))},`)
    .join('\n');
  return (
    '// GENERATED from /labels/*.zpl by `pnpm --filter domain gen`. Do not edit.\n' +
    `export const LABEL_TEMPLATES = {\n${entries}\n} as const;\n`
  );
}

function main() {
  mkdirSync(join(root, 'contracts', 'v1'), { recursive: true });
  mkdirSync(join(root, 'contracts', 'samples'), { recursive: true });
  for (const type of LOGO_FILE_TYPES) {
    writeFileSync(join(root, 'contracts', 'v1', `${type}.json`), JSON.stringify(logoContractJson(type), null, 2) + '\n');
    const file = buildLogoFile(type, SAMPLE_DATE, 1, SAMPLE_ROWS[type]);
    writeFileSync(join(root, 'contracts', 'samples', file.name), file.text);
  }
  writeFileSync(join(here, '..', 'src', 'labels', 'templates.generated.ts'), generatedTemplatesSource());
  console.log('generated contracts, samples and label templates');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
