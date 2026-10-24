import { readFileSync } from 'node:fs';

export const seed = JSON.parse(readFileSync(new URL('../data/seed.json', import.meta.url), 'utf8'));
