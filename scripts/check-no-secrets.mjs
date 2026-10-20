#!/usr/bin/env node
// Fails when a tracked file looks like it carries a credential.
//   node scripts/check-no-secrets.mjs            scan git-tracked files
//   node scripts/check-no-secrets.mjs --values   also scan for exact values in
//                                                 the .env named by GC_ENV_FILE
//                                                 (default ./.env); never printed
// Prints file and rule names only, never the matched text.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const RULES = [
  ['google-api-key', /AIza[0-9A-Za-z_-]{35}/],
  ['elevenlabs-key', /\bsk_[a-f0-9]{40,}\b/],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  [
    'jwt-like-token',
    /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/,
  ],
  [
    'named-key-with-value',
    /^\s*(?:[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|CLIENT_SECRET|MAP_KEY))\s*=\s*[A-Za-z0-9_\-./+=]{12,}\s*$/m,
  ],
];
const SKIP = /\.(png|jpe?g|gif|webp|ico|woff2?|mp3|wav|mp4|pdf|zip|gz|sqlite)$/i;
const MAX_BYTES = 2_000_000;

const files = execFileSync('git', ['ls-files', '-z'], {
  encoding: 'utf8',
  maxBuffer: 1 << 28,
})
  .split('\0')
  .filter(Boolean);

const findings = [];
for (const file of files) {
  if (/(^|\/)\.env(\.[^/]*)?$/.test(file) && !file.endsWith('.env.example'))
    findings.push([file, 'env-file-tracked']);
  if (SKIP.test(file) || !existsSync(file)) continue;
  if (statSync(file).size > MAX_BYTES) continue;
  const text = readFileSync(file, 'utf8');
  for (const [name, pattern] of RULES)
    if (pattern.test(text)) findings.push([file, name]);
}

const envFile = process.env.GC_ENV_FILE || '.env';
if (process.argv.includes('--values') && existsSync(envFile)) {
  const values = readFileSync(envFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    // Settings that are identifiers, not credentials.
    .filter((line) => !/^[A-Z0-9_]*(?:VOICE_ID|MODEL|URL|HOST|PORT)\s*=/.test(line))
    .map((line) =>
      line
        .slice(line.indexOf('=') + 1)
        .trim()
        .replace(/^["']|["']$/g, ''),
    )
    .filter((value) => value.length >= 12);
  for (const file of files) {
    if (SKIP.test(file) || !existsSync(file)) continue;
    if (statSync(file).size > MAX_BYTES) continue;
    const text = readFileSync(file, 'utf8');
    if (values.some((value) => text.includes(value)))
      findings.push([file, 'local-env-value']);
  }
}

if (findings.length) {
  console.error('Possible credentials found:');
  for (const [file, rule] of findings) console.error(`  ${file}  [${rule}]`);
  process.exit(1);
}
console.log(`No credentials found in ${files.length} tracked files.`);
