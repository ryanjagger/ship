import { readFileSync } from 'node:fs';

function readInput() {
  const file = process.argv[2];
  if (file) {
    return readFileSync(file, 'utf8');
  }
  return readFileSync(0, 'utf8');
}

function endpointLabel(result) {
  return `${result.method} ${result.path}`;
}

function formatMs(value) {
  return Number.isFinite(value) ? `${value}ms` : 'n/a';
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(2) : 'n/a';
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (value < 1024) return `${value}B`;
  return `${(value / 1024).toFixed(1)}KB`;
}

const parsed = JSON.parse(readInput());
const results = Array.isArray(parsed) ? parsed : parsed.results;

if (!Array.isArray(results) || results.length === 0) {
  throw new Error('Expected a benchmark JSON object with a non-empty results array');
}

const maxConcurrency = Math.max(...results.map((result) => result.concurrency));
const deliverableRows = results
  .filter((result) => result.concurrency === maxConcurrency)
  .sort((a, b) => (b.p99 ?? -1) - (a.p99 ?? -1));
const hasResponseMetadata = results.some((result) => Number.isFinite(result.responseBytes) || Number.isFinite(result.itemCount));

console.log(`${maxConcurrency} simultaneous connections:\n`);
console.log(hasResponseMetadata
  ? '| Endpoint | Items | Response size | P50 | P95 | P99 |'
  : '| Endpoint | P50 | P95 | P99 |');
console.log(hasResponseMetadata
  ? '| --- | ---: | ---: | ---: | ---: | ---: |'
  : '| --- | ---: | ---: | ---: |');
deliverableRows.forEach((result, index) => {
  console.log(hasResponseMetadata
    ? `| ${index + 1}. \`${endpointLabel(result)}\` | ${result.itemCount ?? 'n/a'} | ${formatBytes(result.responseBytes)} | ${formatMs(result.p50)} | ${formatMs(result.p95)} | ${formatMs(result.p99)} |`
    : `| ${index + 1}. \`${endpointLabel(result)}\` | ${formatMs(result.p50)} | ${formatMs(result.p95)} | ${formatMs(result.p99)} |`);
});

console.log('\nDetailed results:\n');
console.log(hasResponseMetadata
  ? '| Endpoint | Concurrency | Requests | Items | Response size | P50 | P95 | P99 | Req/s | Failed |'
  : '| Endpoint | Concurrency | Requests | P50 | P95 | P99 | Req/s | Failed |');
console.log(hasResponseMetadata
  ? '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  : '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const result of results) {
  console.log(hasResponseMetadata
    ? `| \`${endpointLabel(result)}\` | ${result.concurrency} | ${result.requests ?? 'n/a'} | ${result.itemCount ?? 'n/a'} | ${formatBytes(result.responseBytes)} | ${formatMs(result.p50)} | ${formatMs(result.p95)} | ${formatMs(result.p99)} | ${formatNumber(result.requestsPerSecond)} | ${result.failed ?? 'n/a'} |`
    : `| \`${endpointLabel(result)}\` | ${result.concurrency} | ${result.requests ?? 'n/a'} | ${formatMs(result.p50)} | ${formatMs(result.p95)} | ${formatMs(result.p99)} | ${formatNumber(result.requestsPerSecond)} | ${result.failed ?? 'n/a'} |`);
}
