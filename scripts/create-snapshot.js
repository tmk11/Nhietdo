#!/usr/bin/env node
const SNAPSHOT_URL = process.env.SNAPSHOT_URL || 'http://127.0.0.1:3097/api/snapshots?force=1';
const SNAPSHOT_MAX_ATTEMPTS = Number(process.env.SNAPSHOT_MAX_ATTEMPTS || 2);
const SNAPSHOT_RETRY_DELAY_MS = Number(process.env.SNAPSHOT_RETRY_DELAY_MS || 30_000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createSnapshot(attempt) {
  const response = await fetch(SNAPSHOT_URL, { method: 'POST' });
  const text = await response.text();
  let payload;

  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Snapshot API returned non-JSON: ${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(payload.error || `Snapshot API returned HTTP ${response.status}`);
  }

  const validation = payload.validation || { ok: true, issues: [], warnings: [] };
  const summary = {
    attempt,
    created: payload.created,
    date: payload.snapshot?.date,
    createdAt: payload.snapshot?.createdAt,
    airportCount: payload.snapshot?.airports?.length || 0,
    validationOk: validation.ok,
    issueCount: validation.issues?.length || 0,
    warningCount: validation.warnings?.length || 0,
    issues: validation.issues || [],
    warnings: validation.warnings || [],
  };
  console.log(JSON.stringify(summary));

  return { payload, validation, summary };
}

async function main() {
  let lastResult;

  for (let attempt = 1; attempt <= SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
    lastResult = await createSnapshot(attempt);

    if (lastResult.validation.ok) {
      return;
    }

    if (attempt < SNAPSHOT_MAX_ATTEMPTS) {
      console.warn(`Snapshot thiếu dữ liệu, đợi ${Math.round(SNAPSHOT_RETRY_DELAY_MS / 1000)}s rồi snapshot lại...`);
      await sleep(SNAPSHOT_RETRY_DELAY_MS);
    }
  }

  throw new Error(`Snapshot vẫn thiếu dữ liệu sau ${SNAPSHOT_MAX_ATTEMPTS} lần thử: ${(lastResult.validation.issues || []).join(' | ')}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
