import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env')) { console.log('.env already exists; it was not changed.'); }
else {
  const text = readFileSync('.env.example', 'utf8').replace('replace-with-a-random-token-at-least-32-characters', randomBytes(32).toString('hex'));
  writeFileSync('.env', text, { mode: 0o600, flag: 'wx' });
  console.log('Created .env with a random dashboard token. MODE=demo generates synthetic data. For real prices and simulated-money orders, add paper-account keys, set MODE=paper, then recreate the container.');
}
