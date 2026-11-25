import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageName = 'n8n-nodes-agentforge-guard';

async function observe(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'AgentForge-Guard-adoption-observer/0.1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return { url, status: response.status, value: null };
    return { url, status: response.status, value: await response.json() };
  } catch {
    return { url, status: null, value: null };
  }
}

export async function collect(fetchImpl = fetch, now = new Date()) {
  const urls = [
    `https://registry.npmjs.org/${packageName}/latest`,
    `https://api.npmjs.org/downloads/point/last-week/${packageName}`,
    `https://api.npmjs.org/downloads/point/last-month/${packageName}`,
    'https://crates.io/api/v1/crates/agentforge-guard',
  ];
  const sources = await Promise.all(urls.map(url => observe(url, fetchImpl)));
  const [npm, week, month, rust] = sources.map(s => s.value);
  const downloads = value => Number.isSafeInteger(value?.downloads) && value.downloads >= 0 ? value.downloads : null;
  return {
    observedAt: now.toISOString(),
    package: packageName,
    npmVersion: npm?.name === packageName && typeof npm.version === 'string' ? npm.version : null,
    weeklyDownloads: downloads(week),
    monthlyDownloads: downloads(month),
    downloadsAreNotUniqueUsers: true,
    cratesVersion: typeof rust?.crate?.max_version === 'string' ? rust.crate.max_version : null,
    thirdPartyUsageEvidence: [],
    sources: sources.map(({ url, status }) => ({ url, status })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = resolve(process.argv[2] ?? 'metrics/n8n-adoption.jsonl');
  const snapshot = await collect();
  await mkdir(dirname(destination), { recursive: true });
  await appendFile(destination, `${JSON.stringify(snapshot)}\n`);
  console.log(`Recorded registry metadata and aggregate counts in ${destination}`);
}
