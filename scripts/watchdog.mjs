// Run on a different host/account from Luigi, with its own notification channel.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const target = process.env.LUIGI_READINESS_URL;
const webhook = process.env.WITNESS_DISCORD_WEBHOOK_URL;
const stateFile = process.env.WITNESS_STATE_FILE ?? '/var/lib/luigi-witness/state.json';
if (!target || !webhook) throw new Error('Configure LUIGI_READINESS_URL and WITNESS_DISCORD_WEBHOOK_URL');
let healthy = false;
try {
  const response = await fetch(target, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
  healthy = response.ok && (await response.json()).ready === true;
} catch { /* Connectivity failure is itself a monitoring failure. */ }
let previous;
try { previous = JSON.parse(await readFile(stateFile, 'utf8')); } catch { previous = undefined; }
if ((!previous && !healthy) || (previous && previous.healthy !== healthy)) {
  const response = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowed_mentions: { parse: [] }, content: healthy
      ? 'Témoin externe : Luigi est de nouveau prêt.'
      : 'Témoin externe : Luigi est inaccessible ou sa supervision ne fonctionne plus. Vérifier PostgreSQL et le worker.' }),
    signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Witness notification failed: ${response.status}`);
}
await mkdir(path.dirname(stateFile), { recursive: true });
await writeFile(stateFile, JSON.stringify({ healthy, checkedAt: new Date().toISOString() }));
if (!healthy) process.exitCode = 1;
