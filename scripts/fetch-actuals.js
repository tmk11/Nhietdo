#!/usr/bin/env node
// Lấy nhiệt độ cao nhất quan trắc thực tế (METAR) cho từng sân bay và nhập vào
// app qua POST /api/actuals. Nguồn: IEM ASOS archive (mesonet.agron.iastate.edu).
//
//   node scripts/fetch-actuals.js                  # mặc định: hôm qua (Europe/Berlin)
//   node scripts/fetch-actuals.js 2026-06-10 2026-06-23   # backfill khoảng ngày
//   ACTUALS_FORCE=1 node scripts/fetch-actuals.js ...      # ghi đè actual đã có
//
// Mặc định KHÔNG ghi đè actual đã tồn tại (giữ dữ liệu nhập tay).

const ACTUALS_API = process.env.ACTUALS_API || 'http://127.0.0.1:3097/api/actuals';
const FORCE = process.env.ACTUALS_FORCE === '1';
const REQUEST_DELAY_MS = Number(process.env.ACTUALS_REQUEST_DELAY_MS || 3000);
const DATE_KEY_TIME_ZONE = process.env.ACTUALS_DATE_TZ || 'Europe/Berlin';

// Mirror AIRPORTS trong server.js (chỉ cần code + timeZone).
const AIRPORTS = [
  { code: 'EDDM', timeZone: 'Europe/Berlin' },
  { code: 'LFPB', timeZone: 'Europe/Paris' },
  { code: 'LIMC', timeZone: 'Europe/Rome' },
  { code: 'EHAM', timeZone: 'Europe/Amsterdam' },
  { code: 'LEMD', timeZone: 'Europe/Madrid' },
  { code: 'EGLC', timeZone: 'Europe/London' },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const base = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + days);
  return getDateKey(base, 'UTC');
}

function listDates(startKey, endKey) {
  const dates = [];
  let cursor = startKey;
  for (let guard = 0; guard < 400 && cursor <= endKey; guard += 1) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
        return text;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(1500 * attempt);
    }
  }
  throw lastError;
}

// Trả về { 'YYYY-MM-DD': maxTempC } cho một sân bay trong khoảng [startKey, endKey].
async function fetchAirportDailyMax(airport, startKey, endKey) {
  const endExclusive = addDays(endKey, 1);
  const [y1, m1, d1] = startKey.split('-');
  const [y2, m2, d2] = endExclusive.split('-');
  const url = 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py'
    + `?station=${encodeURIComponent(airport.code)}`
    + '&data=tmpc'
    + `&year1=${y1}&month1=${Number(m1)}&day1=${Number(d1)}`
    + `&year2=${y2}&month2=${Number(m2)}&day2=${Number(d2)}`
    + `&tz=${encodeURIComponent(airport.timeZone)}`
    + '&format=onlycomma&latlon=no&missing=M&trace=T';

  const text = await fetchText(url);
  const maxByDate = {};

  for (const line of text.split('\n')) {
    const [, valid, tmpc] = line.split(',');
    if (!valid || valid === 'valid') continue;
    const value = Number(tmpc);
    if (!Number.isFinite(value)) continue;
    const dateKey = valid.slice(0, 10);
    if (maxByDate[dateKey] === undefined || value > maxByDate[dateKey]) {
      maxByDate[dateKey] = value;
    }
  }

  return maxByDate;
}

async function readExistingActuals() {
  try {
    const text = await fetchText(ACTUALS_API, 2);
    const data = JSON.parse(text);
    return data.dates && typeof data.dates === 'object' ? data.dates : {};
  } catch (error) {
    console.warn('Không đọc được actuals hiện có, coi như rỗng:', error.message);
    return {};
  }
}

async function postActuals(date, actuals) {
  const response = await fetch(ACTUALS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, actuals }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`POST actuals trả về non-JSON: ${text.slice(0, 160)}`);
  }
  if (!response.ok) {
    throw new Error(payload.error || `POST actuals HTTP ${response.status}`);
  }
  return payload;
}

async function main() {
  const [, , startArg, endArg] = process.argv;
  const defaultDate = addDays(getDateKey(new Date(), DATE_KEY_TIME_ZONE), -1);
  const startKey = startArg || defaultDate;
  const endKey = endArg || startArg || defaultDate;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(startKey) || !/^\d{4}-\d{2}-\d{2}$/.test(endKey)) {
    throw new Error('Ngày phải có dạng YYYY-MM-DD');
  }
  if (startKey > endKey) {
    throw new Error(`START (${startKey}) phải <= END (${endKey})`);
  }

  const dates = listDates(startKey, endKey);
  const existing = FORCE ? {} : await readExistingActuals();

  // Gom max theo ngày cho từng sân bay (1 request/sân bay cho cả khoảng).
  const maxByAirport = {};
  for (const airport of AIRPORTS) {
    try {
      maxByAirport[airport.code] = await fetchAirportDailyMax(airport, startKey, endKey);
    } catch (error) {
      console.warn(`${airport.code}: lỗi lấy METAR (${error.message})`);
      maxByAirport[airport.code] = {};
    }
    await sleep(REQUEST_DELAY_MS);
  }

  let totalWritten = 0;
  for (const date of dates) {
    const actuals = {};
    const skipped = [];
    const missing = [];

    for (const airport of AIRPORTS) {
      if (!FORCE && existing[date] && existing[date][airport.code]) {
        skipped.push(airport.code);
        continue;
      }
      const value = maxByAirport[airport.code]?.[date];
      if (typeof value !== 'number') {
        missing.push(airport.code);
        continue;
      }
      actuals[airport.code] = Math.round(value * 10) / 10;
    }

    const written = Object.keys(actuals);
    if (written.length === 0) {
      console.log(JSON.stringify({ date, written: 0, skipped, missing }));
      continue;
    }

    await postActuals(date, actuals);
    totalWritten += written.length;
    console.log(JSON.stringify({
      date,
      written: written.length,
      values: actuals,
      skipped,
      missing,
    }));
  }

  console.log(`Hoàn tất: ghi ${totalWritten} giá trị actual cho ${dates.length} ngày (${startKey}..${endKey}).`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
