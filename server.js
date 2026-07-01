const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.PORT || 3097);
const WEB_FETCH_URL = process.env.WEB_FETCH_URL || 'http://127.0.0.1:20128/v1/web/fetch';
const WEB_FETCH_MODEL = process.env.WEB_FETCH_MODEL || 'fetch-combo';
const WEB_FETCH_API_KEY = process.env.WEB_FETCH_API_KEY || process.env.FETCH_API_KEY || process.env.AI_API_KEY;
const MET_NORWAY_USER_AGENT = process.env.MET_NORWAY_USER_AGENT || 'weather-openmeteo/1.0 contact=ubuntu@localhost';
const VISUAL_CROSSING_API_KEY = process.env.VISUAL_CROSSING_API_KEY || '';
const WEATHERAPI_KEY = process.env.WEATHERAPI_KEY || '';
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || '';
const TOMORROW_API_KEY = process.env.TOMORROW_API_KEY || '';
const AEMET_API_KEY = process.env.AEMET_API_KEY || '';
const TOMORROW_ENABLED = process.env.TOMORROW_ENABLED !== '0';
const TOMORROW_CACHE_TTL_MS = Number(process.env.TOMORROW_CACHE_TTL_MS || 20 * 60 * 1000);
const TOMORROW_REQUEST_DELAY_MS = Number(process.env.TOMORROW_REQUEST_DELAY_MS || 450);
const WUNDERGROUND_API_KEY = process.env.WUNDERGROUND_API_KEY || 'e1f10a1e78da46f5b10a1e78da96f525';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 20 * 60 * 1000);
const CACHE_DIR = path.join(__dirname, '.cache');
const OPEN_METEO_CACHE_FILE = path.join(CACHE_DIR, 'open-meteo.json');
const WUNDERGROUND_CACHE_FILE = path.join(CACHE_DIR, 'wunderground.json');
const EXTERNAL_CACHE_FILE = path.join(CACHE_DIR, 'external-forecasts.json');
const TOMORROW_CACHE_FILE = path.join(CACHE_DIR, 'tomorrow-forecasts.json');
const PROBABILITIES_CACHE_FILE = path.join(CACHE_DIR, 'probabilities.json');
// Sigma mặc định của kernel làm mượt phân phối member khi chưa đủ lịch sử để calibrate
const PROB_KERNEL_SIGMA_C = Number(process.env.PROB_KERNEL_SIGMA_C || 0.8);
// Số mẫu (ngày x sân bay) tối thiểu trước khi dùng bias/RMSE lịch sử của ensemble
const PROB_CALIBRATION_MIN_SAMPLES = Number(process.env.PROB_CALIBRATION_MIN_SAMPLES || 5);
const SNAPSHOT_DIR = path.join(__dirname, 'snapshots');
const ACTUALS_FILE = path.join(SNAPSHOT_DIR, 'actuals.json');

const OPEN_METEO_MODELS = [
  'best_match',
  'icon_seamless',
  'meteofrance_seamless',
  'icon_eu',
  'meteofrance_arpege_europe',
  'icon_d2',
  'meteofrance_arome_france',
  'meteofrance_arome_france_hd',
];
const OPEN_METEO_MODEL_AIRPORT_FILTER = {
  ukmo_uk_deterministic_2km: ['EGLC'],
};
const ENSEMBLE_MODELS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'];
const OPEN_METEO_OPTIONAL_MODELS = Object.keys(OPEN_METEO_MODEL_AIRPORT_FILTER);

function getOpenMeteoModelsForAirport(airport) {
  const extras = OPEN_METEO_OPTIONAL_MODELS.filter((model) => (
    OPEN_METEO_MODEL_AIRPORT_FILTER[model].includes(airport.code)
  ));
  return [...OPEN_METEO_MODELS, ...extras];
}

const AIRPORTS = [
  { code: 'EDDM', name: 'Munich Airport', latitude: 48.3538, longitude: 11.7861, timeZone: 'Europe/Berlin' },
  { code: 'LFPB', name: 'Paris–Le Bourget Airport', latitude: 48.9694, longitude: 2.4414, timeZone: 'Europe/Paris' },
  { code: 'LIMC', name: 'Milan Malpensa Airport', latitude: 45.63, longitude: 8.7281, timeZone: 'Europe/Rome' },
  { code: 'EHAM', name: 'Amsterdam Schiphol Airport', latitude: 52.3105, longitude: 4.7683, timeZone: 'Europe/Amsterdam' },
  { code: 'LEMD', name: 'Adolfo Suárez Madrid–Barajas Airport', latitude: 40.4983, longitude: -3.5676, timeZone: 'Europe/Madrid' },
  { code: 'EGLC', name: 'London City Airport', latitude: 51.5053, longitude: 0.0553, timeZone: 'Europe/London' },
];

const DWD_MOSMIX_STATIONS = {
  EDDM: { id: '10870', name: 'MUENCHEN-FL.' },
  LFPB: { id: '07150', name: 'PARIS-LE BOURGET' },
  LIMC: { id: '16066', name: 'MILANO/MALPENSA' },
  EHAM: { id: '06240', name: 'AMSTERDAM' },
  LEMD: { id: '08221', name: 'MADRID/BARAJAS' },
};

const OPTIONAL_SOURCE_CONFIG = {
  visualCrossing: {
    source: 'Visual Crossing',
    label: 'Visual Crossing',
    envName: 'VISUAL_CROSSING_API_KEY',
  },
  weatherApi: {
    source: 'WeatherAPI.com',
    label: 'WeatherAPI.com',
    envName: 'WEATHERAPI_KEY',
  },
  openWeather: {
    source: 'OpenWeather',
    label: 'OpenWeather',
    envName: 'OPENWEATHER_API_KEY',
  },
  tomorrow: {
    source: 'Tomorrow.io',
    label: 'Tomorrow.io',
    envName: 'TOMORROW_API_KEY',
  },
  aemet: {
    source: 'AEMET',
    label: 'AEMET OpenData',
    envName: 'AEMET_API_KEY',
  },
};

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readCache(cacheFile) {
  try {
    if (!fs.existsSync(cacheFile)) return null;

    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (Date.now() - cached.createdAt > CACHE_TTL_MS) return null;

    return cached;
  } catch (error) {
    console.warn('Forecast cache read failed:', error.message);
    return null;
  }
}

function writeCache(cacheFile, payload) {
  fs.writeFile(cacheFile, JSON.stringify(payload, null, 2), (error) => {
    if (error) console.warn('Forecast cache write failed:', error.message);
  });
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.warn(`Read JSON failed for ${filePath}:`, error.message);
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tempPath, filePath);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body is too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error('JSON body không hợp lệ'));
      }
    });

    req.on('error', reject);
  });
}

function fahrenheitToCelsius(value) {
  return (value - 32) * 5 / 9;
}

function roundOne(value) {
  return Math.round(value * 10) / 10;
}

function normalizeTemperature(value, unit) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;

  const normalizedUnit = String(unit || '').toUpperCase();
  if (normalizedUnit === 'F') {
    return {
      temperatureMaxC: roundOne(fahrenheitToCelsius(numericValue)),
      temperatureMaxF: roundOne(numericValue),
      sourceUnit: 'F',
    };
  }

  return {
    temperatureMaxC: roundOne(numericValue),
    temperatureMaxF: roundOne((numericValue * 9 / 5) + 32),
    sourceUnit: 'C',
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeSecret(text) {
  let sanitized = String(text || '');
  for (const secret of [WEB_FETCH_API_KEY, VISUAL_CROSSING_API_KEY, WEATHERAPI_KEY, OPENWEATHER_API_KEY, TOMORROW_API_KEY, AEMET_API_KEY]) {
    if (secret) {
      sanitized = sanitized.replaceAll(secret, '[REDACTED]');
    }
  }
  return sanitized;
}

function sanitizeUrl(value) {
  try {
    const url = new URL(String(value));
    for (const key of ['key', 'apikey', 'api_key']) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString();
  } catch (error) {
    return sanitizeSecret(value);
  }
}

function buildForecastResult(airport, source, label, sourceUrl, details) {
  return {
    code: airport.code,
    source,
    label,
    sourceUrl,
    configured: true,
    fetchedAt: new Date().toISOString(),
    ...details,
  };
}

function buildErrorResult(airport, source, label, sourceUrl, error, options = {}) {
  return {
    code: airport.code,
    source,
    label,
    sourceUrl,
    configured: options.configured !== false,
    authError: Boolean(options.authError),
    requiredEnv: options.requiredEnv,
    error: sanitizeSecret(error.message || String(error)),
    fetchedAt: new Date().toISOString(),
  };
}

function extractHighTemperature(markdown) {
  const text = String(markdown || '').replace(/\u00a0/g, ' ');
  const patterns = [
    /\bHigh\s+(?:around|near|about)\s+(-?\d+(?:\.\d+)?)\s*°?\s*([FC])\b/i,
    /Today[^\n\r]*?\bHigh\s+(-?\d+(?:\.\d+)?)\s*°?\s*([FC])\b/i,
    /\bHigh\s+(?:near|around)?\s*(-?\d+(?:\.\d+)?)\s*°?\s*([FC])\b/i,
    /\bHigh\s+(-?\d+(?:\.\d+)?)\s*°?\s*([FC])\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return {
        ...normalizeTemperature(match[1], match[2]),
        raw: match[0].replace(/\s+/g, ' ').trim(),
      };
    }
  }

  return null;
}

function getLocalDateKey(dateInput, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(dateInput));

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getSourceUrl(source, airport) {
  if (source === 'Wunderground') return `https://www.wunderground.com/hourly/${encodeURIComponent(airport.code)}`;
  if (source === 'MET Norway') return `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${airport.latitude}&lon=${airport.longitude}`;
  if (source === 'Visual Crossing') return `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${airport.latitude},${airport.longitude}/today`;
  if (source === 'WeatherAPI.com') return `https://api.weatherapi.com/v1/forecast.json?q=${airport.latitude},${airport.longitude}&days=1`;
  if (source === 'ECMWF IFS') return `https://api.open-meteo.com/v1/forecast?latitude=${airport.latitude}&longitude=${airport.longitude}&daily=temperature_2m_max&models=ecmwf_ifs025&timezone=auto&forecast_days=1`;
  if (source === 'OpenWeather') return `https://api.openweathermap.org/data/4.0/onecall/timeline/1day?lat=${airport.latitude}&lon=${airport.longitude}&units=metric`;
  if (source === 'Tomorrow.io') return `https://api.tomorrow.io/v4/weather/forecast?location=${airport.latitude},${airport.longitude}&timesteps=1d&units=metric&timezone=${encodeURIComponent(airport.timeZone || 'UTC')}`;
  if (source === 'DWD MOSMIX') {
    const station = DWD_MOSMIX_STATIONS[airport.code];
    return station ? `https://opendata.dwd.de/weather/local_forecasts/mos/MOSMIX_L/single_stations/${station.id}/kml/MOSMIX_L_LATEST_${station.id}.kmz` : '';
  }
  if (source === 'AEMET') return 'https://opendata.aemet.es/opendata/api/prediccion/especifica/municipio/diaria/28079';
  if (source === 'Open-Meteo Ensemble') return buildEnsembleUrl(airport, ENSEMBLE_MODELS.join(','));
  return '';
}

async function fetchBuffer(url, options = {}) {
  const response = await fetch(url, options);
  const arrayBuffer = await response.arrayBuffer();
  const body = Buffer.from(arrayBuffer);

  if (!response.ok) {
    const rawText = body.toString('utf8');
    let data = {};
    try {
      data = JSON.parse(rawText);
    } catch (error) {
      data = { message: rawText.slice(0, 160) };
    }
    throw new Error(sanitizeSecret(data.error?.message || data.message || data.reason || `HTTP ${response.status} from ${sanitizeUrl(url)}`));
  }

  return body;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const rawText = await response.text();
  let data;

  try {
    data = JSON.parse(rawText);
  } catch (error) {
    const snippet = sanitizeSecret(rawText.slice(0, 160).replace(/\s+/g, ' ').trim());
    throw new Error(`Non-JSON response from ${sanitizeUrl(url)}${snippet ? `: ${snippet}` : ''}`);
  }

  if (!response.ok) {
    throw new Error(sanitizeSecret(data.error?.message || data.message || data.reason || `HTTP ${response.status} from ${sanitizeUrl(url)}`));
  }

  return data;
}

async function fetchJsonWithRetry(url, options = {}, attempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJson(url, options);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await sleep(700 * attempt);
    }
  }

  throw lastError;
}

function buildOpenMeteoUrl(airport) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', airport.latitude);
  url.searchParams.set('longitude', airport.longitude);
  url.searchParams.set('daily', 'temperature_2m_max');
  url.searchParams.set('models', getOpenMeteoModelsForAirport(airport).join(','));
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '1');
  return url.toString();
}

async function fetchOpenMeteoAirport(airport) {
  const sourceUrl = buildOpenMeteoUrl(airport);
  const data = await fetchJson(sourceUrl);
  const date = data.daily?.time?.[0] || getLocalDateKey(new Date(), airport.timeZone);

  return getOpenMeteoModelsForAirport(airport).map((model) => {
    const fieldName = `temperature_2m_max_${model}`;
    const tempMax = data.daily?.[fieldName]?.[0] ?? data.daily?.temperature_2m_max?.[0];
    const normalized = normalizeTemperature(tempMax, 'C');

    if (!normalized) {
      return {
        source: 'Open-Meteo',
        label: `Open-Meteo ${model}`,
        model,
        sourceUrl,
        configured: true,
        error: `Không có ${fieldName}`,
      };
    }

    return {
      source: 'Open-Meteo',
      label: `Open-Meteo ${model}`,
      model,
      sourceUrl,
      configured: true,
      ...normalized,
      raw: `${fieldName}=${tempMax}°C; date=${date}`,
    };
  });
}

async function fetchOpenMeteoForecasts() {
  const tasks = AIRPORTS.map(async (airport) => ({
    airport,
    sourceUrl: buildOpenMeteoUrl(airport),
    forecast: await fetchJson(buildOpenMeteoUrl(airport)),
  }));

  const settled = await Promise.allSettled(tasks);

  return settled.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;

    const airport = AIRPORTS[index];
    return {
      airport,
      sourceUrl: buildOpenMeteoUrl(airport),
      error: sanitizeSecret(result.reason?.message || 'Open-Meteo forecast failed'),
    };
  });
}

async function fetchWundergroundAirport(airport) {
  const source = 'Wunderground';
  const sourceUrl = getSourceUrl(source, airport);
  const apiUrl = `https://api.weather.com/v3/wx/forecast/daily/15day?apiKey=${WUNDERGROUND_API_KEY}&geocode=${airport.latitude},${airport.longitude}&format=json&units=m&language=en-US`;

  const data = await fetchJson(apiUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; weather-openmeteo/1.0)',
      Referer: `https://www.wunderground.com/hourly/${airport.code}`,
    },
  });

  const validTimeLocal = data.validTimeLocal || [];
  const calendarDayMax = data.calendarDayTemperatureMax || [];
  const temperatureMax = data.temperatureMax || [];

  if (validTimeLocal.length === 0) {
    throw new Error(`Wunderground API thiếu dữ liệu daily cho ${airport.code}`);
  }

  let pickedIndex = temperatureMax.findIndex((value) => typeof value === 'number');
  let tempC = pickedIndex >= 0 ? temperatureMax[pickedIndex] : null;
  let field = 'temperatureMax';

  if (typeof tempC !== 'number') {
    pickedIndex = calendarDayMax.findIndex((value) => typeof value === 'number');
    tempC = pickedIndex >= 0 ? calendarDayMax[pickedIndex] : null;
    field = 'calendarDayTemperatureMax';
  }

  if (typeof tempC !== 'number') {
    throw new Error(`Wunderground API không có nhiệt độ tối đa cho ${airport.code}`);
  }

  const pickedDate = String(validTimeLocal[pickedIndex] || '').slice(0, 10);
  const normalized = normalizeTemperature(tempC, 'C');
  return buildForecastResult(airport, source, source, sourceUrl, {
    ...normalized,
    raw: `${field}[${pickedIndex}]=${tempC}°C; date=${pickedDate}; api.weather.com daily/15day`,
  });
}

async function fetchMetNorwayAirport(airport) {
  const source = 'MET Norway';
  const sourceUrl = getSourceUrl(source, airport);
  const data = await fetchJson(sourceUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': MET_NORWAY_USER_AGENT,
    },
  });

  const targetDate = getLocalDateKey(new Date(), airport.timeZone);
  const samples = (data.properties?.timeseries || [])
    .map((item) => ({
      time: item.time,
      localDate: getLocalDateKey(item.time, airport.timeZone),
      value: item.data?.instant?.details?.air_temperature,
    }))
    .filter((item) => item.localDate === targetDate && typeof item.value === 'number');

  if (!samples.length) {
    throw new Error(`Không có air_temperature hôm nay từ MET Norway cho ${airport.code}`);
  }

  const maxSample = samples.reduce((best, item) => (item.value > best.value ? item : best), samples[0]);
  return buildForecastResult(airport, source, 'MET Norway / Yr.no', sourceUrl, {
    ...normalizeTemperature(maxSample.value, 'C'),
    raw: `${samples.length} điểm forecast cho ngày ${targetDate}; max tại ${maxSample.time}`,
  });
}

function extractFirstZipFile(buffer) {
  const tempPath = path.join(CACHE_DIR, `dwd-mosmix-${process.pid}-${Date.now()}.kmz`);

  fs.writeFileSync(tempPath, buffer);
  try {
    return execFileSync('unzip', ['-p', tempPath], { maxBuffer: 8 * 1024 * 1024 });
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function extractMosmixValues(kml, elementName) {
  const pattern = new RegExp(`<dwd:Forecast\\s+dwd:elementName="${elementName}">[\\s\\S]*?<dwd:value>([\\s\\S]*?)<\\/dwd:value>`, 'i');
  const match = kml.match(pattern);
  if (!match) return [];

  return match[1].trim().split(/\s+/).map((value) => (value === '-' ? null : Number(value)));
}

function extractMosmixTimes(kml) {
  return [...kml.matchAll(/<dwd:TimeStep>(.*?)<\/dwd:TimeStep>/g)].map((match) => match[1]);
}

function kelvinToCelsius(value) {
  return value - 273.15;
}

async function fetchDwdMosmixAirport(airport) {
  const source = 'DWD MOSMIX';
  const station = DWD_MOSMIX_STATIONS[airport.code];
  const label = station ? `DWD MOSMIX (${station.name})` : 'DWD MOSMIX (official)';
  if (!station) {
    throw new Error(`Không có station DWD MOSMIX cho ${airport.code}`);
  }
  const sourceUrl = getSourceUrl(source, airport);
  const kmz = await fetchBuffer(sourceUrl);
  const kml = extractFirstZipFile(kmz).toString('latin1');
  const times = extractMosmixTimes(kml);
  const targetDate = getLocalDateKey(new Date(), airport.timeZone);

  const txValues = extractMosmixValues(kml, 'TX');
  const txSamples = times
    .map((time, index) => ({
      time,
      localDate: getLocalDateKey(time, airport.timeZone),
      value: txValues[index],
    }))
    .filter((item) => item.localDate === targetDate && Number.isFinite(item.value));

  if (txSamples.length) {
    const maxSample = txSamples.reduce((best, item) => (item.value > best.value ? item : best), txSamples[0]);
    const tempMax = kelvinToCelsius(maxSample.value);
    return buildForecastResult(airport, source, label, sourceUrl, {
      ...normalizeTemperature(tempMax, 'C'),
      raw: `station=${station.id} ${station.name}; TX=${maxSample.value}K; date=${targetDate}; time=${maxSample.time}`,
    });
  }

  const tttValues = extractMosmixValues(kml, 'TTT');
  const hourlySamples = times
    .map((time, index) => ({
      time,
      localDate: getLocalDateKey(time, airport.timeZone),
      value: tttValues[index],
    }))
    .filter((item) => item.localDate === targetDate && Number.isFinite(item.value));

  if (!hourlySamples.length) {
    throw new Error(`Không có TX/TTT hôm nay từ DWD MOSMIX cho ${airport.code}`);
  }

  const maxSample = hourlySamples.reduce((best, item) => (item.value > best.value ? item : best), hourlySamples[0]);
  const tempMax = kelvinToCelsius(maxSample.value);
  return buildForecastResult(airport, source, label, sourceUrl, {
    ...normalizeTemperature(tempMax, 'C'),
    raw: `station=${station.id} ${station.name}; fallback hourly TTT=${maxSample.value}K; date=${targetDate}; time=${maxSample.time}`,
  });
}

async function fetchEcmwfAirport(airport) {
  const source = 'ECMWF IFS';
  const label = 'ECMWF IFS (Open-Meteo)';
  const sourceUrl = getSourceUrl(source, airport);
  const data = await fetchJson(sourceUrl);
  const tempMax = data.daily?.temperature_2m_max?.[0];
  const normalized = normalizeTemperature(tempMax, 'C');

  if (!normalized) {
    throw new Error(`Không có temperature_2m_max từ ECMWF IFS cho ${airport.code}`);
  }

  return buildForecastResult(airport, source, label, sourceUrl, {
    ...normalized,
    raw: `temperature_2m_max=${tempMax}°C; date=${data.daily?.time?.[0] || 'today'}; model=ecmwf_ifs025`,
  });
}

function buildEnsembleUrl(airport, models) {
  const url = new URL('https://ensemble-api.open-meteo.com/v1/ensemble');
  url.searchParams.set('latitude', airport.latitude);
  url.searchParams.set('longitude', airport.longitude);
  url.searchParams.set('hourly', 'temperature_2m');
  url.searchParams.set('models', models);
  url.searchParams.set('forecast_days', '3');
  url.searchParams.set('timezone', 'auto');
  return url.toString();
}

function extractEnsembleDailyMax(data, targetDate) {
  // timezone=auto nên hourly.time là giờ địa phương; mỗi key temperature_2m* là một member
  const times = data.hourly?.time || [];
  const indexes = times
    .map((time, index) => ({ time, index }))
    .filter((item) => String(item.time).slice(0, 10) === targetDate)
    .map((item) => item.index);

  if (!indexes.length) return [];

  const members = [];
  for (const [key, series] of Object.entries(data.hourly || {})) {
    if (!key.startsWith('temperature_2m') || !Array.isArray(series)) continue;

    let max = null;
    for (const index of indexes) {
      const value = series[index];
      if (typeof value === 'number' && (max === null || value > max)) max = value;
    }
    if (max !== null) members.push(max);
  }

  return members;
}

async function fetchEnsembleMembersForAirport(airport, targetDate) {
  const results = await Promise.allSettled(ENSEMBLE_MODELS.map(async (model) => {
    const data = await fetchJsonWithRetry(buildEnsembleUrl(airport, model));
    return { model, members: extractEnsembleDailyMax(data, targetDate) };
  }));

  const members = [];
  const modelCounts = {};
  const errors = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      modelCounts[result.value.model] = result.value.members.length;
      members.push(...result.value.members);
    } else {
      errors.push(`${ENSEMBLE_MODELS[index]}: ${sanitizeSecret(result.reason?.message || 'ensemble fetch failed')}`);
    }
  });

  return { members, modelCounts, errors };
}

function quantile(sortedValues, q) {
  if (!sortedValues.length) return null;
  const position = (sortedValues.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function erf(x) {
  // Xấp xỉ Abramowitz & Stegun 7.1.26, sai số < 1.5e-7
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absX);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-absX * absX));
}

function normCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function getEnsembleCalibration(airportCode) {
  const evaluation = buildEvaluation();
  const rows = evaluation.summaryByAirport[airportCode] || [];
  const historical = rows.find((row) => row.source === 'Open-Meteo Ensemble');

  if (!historical || historical.count < PROB_CALIBRATION_MIN_SAMPLES) {
    return { bias: 0, rmse: null, samples: historical?.count || 0, calibrated: false };
  }

  return { bias: historical.biasC, rmse: historical.rmseC, samples: historical.count, calibrated: true };
}

function computeProbabilityBins(members, sigma) {
  const min = Math.min(...members);
  const max = Math.max(...members);
  const start = Math.floor(min - 2 * sigma);
  const end = Math.ceil(max + 2 * sigma);
  const bins = [];

  for (let t = start; t <= end; t += 1) {
    // METAR/Polymarket ghi nhận độ nguyên nên bucket t°C tương ứng khoảng [t-0.5, t+0.5)
    let pEqual = 0;
    let pAtLeast = 0;
    for (const member of members) {
      pEqual += normCdf((t + 0.5 - member) / sigma) - normCdf((t - 0.5 - member) / sigma);
      pAtLeast += 1 - normCdf((t - 0.5 - member) / sigma);
    }
    bins.push({
      temperatureC: t,
      pEqual: pEqual / members.length,
      pAtLeast: pAtLeast / members.length,
    });
  }

  return bins.filter((bin, index) => bin.pEqual >= 0.001 || (index > 0 && bins[index - 1].pEqual >= 0.001 && bin.pAtLeast >= 0.001));
}

async function buildAirportProbabilities(airport, targetDate) {
  const { members, modelCounts, errors } = await fetchEnsembleMembersForAirport(airport, targetDate);

  if (!members.length) {
    return {
      code: airport.code,
      name: airport.name,
      date: targetDate,
      memberCount: 0,
      errors: errors.length ? errors : [`Không có member ensemble nào cho ${airport.code} ngày ${targetDate}`],
    };
  }

  const calibration = getEnsembleCalibration(airport.code);
  const corrected = members.map((value) => value - calibration.bias).sort((left, right) => left - right);
  const mean = corrected.reduce((sum, value) => sum + value, 0) / corrected.length;
  const variance = corrected.reduce((sum, value) => sum + (value - mean) ** 2, 0) / corrected.length;

  // RMSE lịch sử là tổng sai số; trừ đi phần spread member đã thể hiện để tránh đếm đôi
  let sigma = PROB_KERNEL_SIGMA_C;
  if (calibration.calibrated && calibration.rmse) {
    sigma = Math.sqrt(Math.max(calibration.rmse ** 2 - variance, 0.16));
  }
  sigma = Math.min(Math.max(sigma, 0.4), 3);

  return {
    code: airport.code,
    name: airport.name,
    date: targetDate,
    memberCount: corrected.length,
    modelCounts,
    errors,
    calibration: {
      biasC: roundOne(calibration.bias),
      historicalRmseC: calibration.rmse,
      samples: calibration.samples,
      calibrated: calibration.calibrated,
      kernelSigmaC: roundOne(sigma),
    },
    stats: {
      meanC: roundOne(mean),
      medianC: roundOne(quantile(corrected, 0.5)),
      p10C: roundOne(quantile(corrected, 0.1)),
      p90C: roundOne(quantile(corrected, 0.9)),
      minC: roundOne(corrected[0]),
      maxC: roundOne(corrected[corrected.length - 1]),
    },
    members: corrected.map(roundOne),
    bins: computeProbabilityBins(corrected, sigma).map((bin) => ({
      temperatureC: bin.temperatureC,
      pEqual: Math.round(bin.pEqual * 1000) / 1000,
      pAtLeast: Math.round(bin.pAtLeast * 1000) / 1000,
    })),
  };
}

async function buildProbabilities(targetDate) {
  const results = [];

  for (const airport of AIRPORTS) {
    const date = targetDate || getLocalDateKey(new Date(), airport.timeZone);
    try {
      results.push(await buildAirportProbabilities(airport, date));
    } catch (error) {
      results.push({
        code: airport.code,
        name: airport.name,
        date,
        memberCount: 0,
        errors: [sanitizeSecret(error.message || 'Ensemble probabilities failed')],
      });
    }
  }

  return results;
}

async function fetchEnsembleMedianAirport(airport) {
  const source = 'Open-Meteo Ensemble';
  const label = 'Ensemble median (EC+GFS+ICON)';
  const sourceUrl = getSourceUrl(source, airport);
  const targetDate = getLocalDateKey(new Date(), airport.timeZone);
  const { members, modelCounts, errors } = await fetchEnsembleMembersForAirport(airport, targetDate);

  if (!members.length) {
    throw new Error(`Không có member ensemble cho ${airport.code}: ${errors.join(' | ') || 'no data'}`);
  }

  const sorted = [...members].sort((left, right) => left - right);
  const median = quantile(sorted, 0.5);
  const modelSummary = Object.entries(modelCounts).map(([model, count]) => `${model}=${count}`).join(', ');

  return buildForecastResult(airport, source, label, sourceUrl, {
    ...normalizeTemperature(median, 'C'),
    raw: `median của ${sorted.length} members (${modelSummary}); p10=${roundOne(quantile(sorted, 0.1))}°C; p90=${roundOne(quantile(sorted, 0.9))}°C; date=${targetDate}`,
  });
}

async function fetchVisualCrossingAirport(airport) {
  const { source, label, envName } = OPTIONAL_SOURCE_CONFIG.visualCrossing;
  const sourceUrl = getSourceUrl(source, airport);

  if (!VISUAL_CROSSING_API_KEY) {
    return buildErrorResult(airport, source, label, sourceUrl, `Thiếu ${envName}`, {
      configured: false,
      requiredEnv: envName,
    });
  }

  const url = new URL(sourceUrl);
  url.searchParams.set('unitGroup', 'metric');
  url.searchParams.set('include', 'days');
  url.searchParams.set('key', VISUAL_CROSSING_API_KEY);
  url.searchParams.set('contentType', 'json');

  const data = await fetchJsonWithRetry(url);
  const tempMax = data.days?.[0]?.tempmax;
  const normalized = normalizeTemperature(tempMax, 'C');
  if (!normalized) {
    throw new Error(`Không có tempmax từ Visual Crossing cho ${airport.code}`);
  }

  return buildForecastResult(airport, source, label, sourceUrl, {
    ...normalized,
    raw: `tempmax=${tempMax}°C; date=${data.days?.[0]?.datetime || 'today'}`,
  });
}

async function fetchWeatherApiAirport(airport) {
  const { source, label, envName } = OPTIONAL_SOURCE_CONFIG.weatherApi;
  const sourceUrl = getSourceUrl(source, airport);

  if (!WEATHERAPI_KEY) {
    return buildErrorResult(airport, source, label, sourceUrl, `Thiếu ${envName}`, {
      configured: false,
      requiredEnv: envName,
    });
  }

  const url = new URL('https://api.weatherapi.com/v1/forecast.json');
  url.searchParams.set('key', WEATHERAPI_KEY);
  url.searchParams.set('q', `${airport.latitude},${airport.longitude}`);
  url.searchParams.set('days', '1');
  url.searchParams.set('aqi', 'no');
  url.searchParams.set('alerts', 'no');

  const data = await fetchJson(url);
  const tempMax = data.forecast?.forecastday?.[0]?.day?.maxtemp_c;
  const normalized = normalizeTemperature(tempMax, 'C');
  if (!normalized) {
    throw new Error(`Không có maxtemp_c từ WeatherAPI.com cho ${airport.code}`);
  }

  return buildForecastResult(airport, source, label, sourceUrl, {
    ...normalized,
    raw: `maxtemp_c=${tempMax}; date=${data.forecast?.forecastday?.[0]?.date || 'today'}`,
  });
}

function getOpenWeatherDailyMax(data) {
  return data.data?.[0]?.temp?.max ?? data.daily?.[0]?.temp?.max;
}

async function fetchOpenWeatherAirport(airport) {
  const { source, label, envName } = OPTIONAL_SOURCE_CONFIG.openWeather;
  const sourceUrl = getSourceUrl(source, airport);

  if (!OPENWEATHER_API_KEY) {
    return buildErrorResult(airport, source, label, sourceUrl, `Thiếu ${envName}`, {
      configured: false,
      requiredEnv: envName,
    });
  }

  const oneCall4Url = new URL(sourceUrl);
  oneCall4Url.searchParams.set('appid', OPENWEATHER_API_KEY);

  let oneCallError;
  try {
    const data = await fetchJson(oneCall4Url);
    const tempMax = getOpenWeatherDailyMax(data);
    const normalized = normalizeTemperature(tempMax, 'C');

    if (!normalized) {
      throw new Error(`Không có data[0].temp.max từ OpenWeather One Call 4.0 cho ${airport.code}`);
    }

    return buildForecastResult(airport, source, label, sourceUrl, {
      ...normalized,
      raw: `onecall 4.0 data[0].temp.max=${tempMax}°C; dt=${data.data?.[0]?.dt || 'today'}`,
    });
  } catch (error) {
    oneCallError = error;
  }

  const oneCall3Url = new URL('https://api.openweathermap.org/data/3.0/onecall');
  oneCall3Url.searchParams.set('lat', airport.latitude);
  oneCall3Url.searchParams.set('lon', airport.longitude);
  oneCall3Url.searchParams.set('exclude', 'current,minutely,hourly,alerts');
  oneCall3Url.searchParams.set('units', 'metric');
  oneCall3Url.searchParams.set('appid', OPENWEATHER_API_KEY);

  try {
    const data = await fetchJson(oneCall3Url);
    const tempMax = getOpenWeatherDailyMax(data);
    const normalized = normalizeTemperature(tempMax, 'C');

    if (!normalized) {
      throw new Error(`Không có daily[0].temp.max từ OpenWeather One Call 3.0 cho ${airport.code}`);
    }

    return buildForecastResult(airport, source, label, 'https://api.openweathermap.org/data/3.0/onecall', {
      ...normalized,
      raw: `onecall 3.0 daily[0].temp.max=${tempMax}°C; dt=${data.daily?.[0]?.dt || 'today'}`,
    });
  } catch (oneCall3Error) {
    const forecastUrl = new URL('https://api.openweathermap.org/data/2.5/forecast');
    forecastUrl.searchParams.set('lat', airport.latitude);
    forecastUrl.searchParams.set('lon', airport.longitude);
    forecastUrl.searchParams.set('units', 'metric');
    forecastUrl.searchParams.set('appid', OPENWEATHER_API_KEY);

    let data;
    try {
      data = await fetchJson(forecastUrl);
    } catch (fallbackError) {
      if (/invalid api key|401/i.test(fallbackError.message)) {
        return buildErrorResult(airport, source, label, sourceUrl, 'OPENWEATHER_API_KEY chưa active hoặc chưa bật One Call 4.0', {
          configured: false,
          requiredEnv: envName,
          authError: true,
        });
      }

      throw fallbackError;
    }
    const targetDate = getLocalDateKey(new Date(), airport.timeZone);
    const samples = (data.list || [])
      .map((item) => ({
        time: item.dt_txt || new Date(item.dt * 1000).toISOString(),
        localDate: getLocalDateKey((item.dt || 0) * 1000, airport.timeZone),
        value: item.main?.temp_max,
      }))
      .filter((item) => item.localDate === targetDate && typeof item.value === 'number');

    if (!samples.length) {
      throw new Error(`OpenWeather One Call 4.0 lỗi: ${oneCallError.message}; One Call 3.0 lỗi: ${oneCall3Error.message}; không có forecast temp_max hôm nay cho ${airport.code}`);
    }

    const maxSample = samples.reduce((best, item) => (item.value > best.value ? item : best), samples[0]);
    return buildForecastResult(airport, source, label, 'https://api.openweathermap.org/data/2.5/forecast', {
      ...normalizeTemperature(maxSample.value, 'C'),
      raw: `forecast 3h fallback; ${samples.length} điểm ngày ${targetDate}; max tại ${maxSample.time}; onecall unavailable`,
    });
  }
}

async function fetchTomorrowAirport(airport) {
  const { source, label, envName } = OPTIONAL_SOURCE_CONFIG.tomorrow;
  const sourceUrl = getSourceUrl(source, airport);

  if (!TOMORROW_ENABLED) {
    return buildErrorResult(airport, source, label, sourceUrl, 'Tạm tắt để tránh rate-limit Tomorrow.io; bật TOMORROW_ENABLED=1 nếu muốn thử lại', {
      configured: false,
      requiredEnv: 'TOMORROW_ENABLED=1',
    });
  }

  if (!TOMORROW_API_KEY) {
    return buildErrorResult(airport, source, label, sourceUrl, `Thiếu ${envName}`, {
      configured: false,
      requiredEnv: envName,
    });
  }

  const cache = readJsonFile(TOMORROW_CACHE_FILE, { airports: {} });
  const cached = cache.airports?.[airport.code];
  if (cached && Date.now() - cached.createdAt < TOMORROW_CACHE_TTL_MS) {
    return {
      ...cached.result,
      cached: true,
      raw: `${cached.result.raw}; cached Tomorrow.io ${Math.round((Date.now() - cached.createdAt) / 60000)} phút`,
    };
  }

  const url = new URL(sourceUrl);
  url.searchParams.set('apikey', TOMORROW_API_KEY);
  let data;
  try {
    data = await fetchJson(url);
  } catch (error) {
    if (cached && cached.result) {
      return {
        ...cached.result,
        cached: true,
        stale: true,
        raw: `${cached.result.raw}; stale cache do Tomorrow.io lỗi: ${error.message}`,
      };
    }

    if (/request limit|too many calls|429/i.test(error.message)) {
      return buildErrorResult(airport, source, label, sourceUrl, 'Tomorrow.io đang rate-limit; sẽ tự dùng cache sau lần gọi thành công kế tiếp', {
        configured: false,
        requiredEnv: `TOMORROW_CACHE_TTL_MS=${TOMORROW_CACHE_TTL_MS}`,
      });
    }

    throw error;
  }

  const dailyList = data.timelines?.daily || data.data?.timelines?.[0]?.intervals || [];
  const targetDate = getLocalDateKey(new Date(), airport.timeZone);
  const candidates = dailyList
    .map((item) => ({
      time: item.time || item.startTime,
      localDate: getLocalDateKey(item.time || item.startTime, airport.timeZone),
      values: item.values || {},
    }))
    .filter((item) => item.localDate >= targetDate && (typeof item.values.temperatureMax === 'number' || typeof item.values.temperature_max === 'number'));

  const picked = candidates.find((item) => item.localDate === targetDate) || candidates[0];
  const tempMax = picked?.values.temperatureMax ?? picked?.values.temperature_max;
  const normalized = normalizeTemperature(tempMax, 'C');

  if (!normalized) {
    throw new Error(`Không có temperatureMax từ Tomorrow.io cho ${airport.code}`);
  }

  const result = buildForecastResult(airport, source, label, sourceUrl, {
    ...normalized,
    raw: `temperatureMax=${tempMax}°C; localDate=${picked.localDate}; time=${picked.time || 'today'}`,
  });

  cache.airports = cache.airports || {};
  cache.airports[airport.code] = {
    createdAt: Date.now(),
    ttlMs: TOMORROW_CACHE_TTL_MS,
    result,
  };
  writeJsonFile(TOMORROW_CACHE_FILE, cache);

  return result;
}

async function fetchAemetAirport(airport) {
  const { source, label, envName } = OPTIONAL_SOURCE_CONFIG.aemet;
  const sourceUrl = getSourceUrl(source, airport);

  if (!AEMET_API_KEY) {
    return buildErrorResult(airport, source, label, sourceUrl, `Thiếu ${envName}`, {
      configured: false,
      requiredEnv: envName,
    });
  }

  const indexUrl = new URL(sourceUrl);
  indexUrl.searchParams.set('api_key', AEMET_API_KEY);
  const index = await fetchJson(indexUrl);

  if (!index.datos) {
    throw new Error(`AEMET không trả URL datos cho ${airport.code}`);
  }

  const data = await fetchJson(index.datos);
  const targetDate = getLocalDateKey(new Date(), airport.timeZone);
  const days = data?.[0]?.prediccion?.dia || [];
  const day = days.find((item) => String(item.fecha || '').startsWith(targetDate)) || days[0];
  const tempMax = day?.temperatura?.maxima;
  const normalized = normalizeTemperature(tempMax, 'C');

  if (!normalized) {
    throw new Error(`Không có temperatura.maxima từ AEMET cho ${airport.code}`);
  }

  return buildForecastResult(airport, source, label, sourceUrl, {
    ...normalized,
    raw: `municipio=28079 Madrid; temperatura.maxima=${tempMax}°C; fecha=${day?.fecha || targetDate}`,
  });
}

function getOfficialSourceTasks(airport) {
  const tasks = [];

  if (DWD_MOSMIX_STATIONS[airport.code]) {
    const station = DWD_MOSMIX_STATIONS[airport.code];
    tasks.push(settleSource(airport, 'DWD MOSMIX', `DWD MOSMIX (${station.name})`, getSourceUrl('DWD MOSMIX', airport), fetchDwdMosmixAirport));
  }

  if (airport.code === 'LEMD') {
    tasks.push(settleSource(airport, 'AEMET', 'AEMET OpenData', getSourceUrl('AEMET', airport), fetchAemetAirport));
  }

  return tasks;
}

async function settleSource(airport, source, label, sourceUrl, fetcher) {
  try {
    return await fetcher(airport);
  } catch (error) {
    return buildErrorResult(airport, source, label, sourceUrl, error);
  }
}

async function fetchAirportExternalSources(airport) {
  const sourcePromises = [
    settleSource(airport, 'Wunderground', 'Wunderground', getSourceUrl('Wunderground', airport), fetchWundergroundAirport),
    settleSource(airport, 'MET Norway', 'MET Norway / Yr.no', getSourceUrl('MET Norway', airport), fetchMetNorwayAirport),
    settleSource(airport, 'ECMWF IFS', 'ECMWF IFS (Open-Meteo)', getSourceUrl('ECMWF IFS', airport), fetchEcmwfAirport),
    settleSource(airport, 'Open-Meteo Ensemble', 'Ensemble median (EC+GFS+ICON)', getSourceUrl('Open-Meteo Ensemble', airport), fetchEnsembleMedianAirport),
    settleSource(airport, 'Visual Crossing', 'Visual Crossing', getSourceUrl('Visual Crossing', airport), fetchVisualCrossingAirport),
    settleSource(airport, 'WeatherAPI.com', 'WeatherAPI.com', getSourceUrl('WeatherAPI.com', airport), fetchWeatherApiAirport),
    settleSource(airport, 'OpenWeather', 'OpenWeather', getSourceUrl('OpenWeather', airport), fetchOpenWeatherAirport),
    ...getOfficialSourceTasks(airport),
  ];

  const sources = await Promise.all(sourcePromises);

  return {
    code: airport.code,
    name: airport.name,
    sources,
  };
}

async function fetchExternalForecasts() {
  const results = await Promise.all(AIRPORTS.map(fetchAirportExternalSources));

  for (const result of results) {
    const airport = AIRPORTS.find((item) => item.code === result.code);
    if (!airport) continue;

    if (TOMORROW_REQUEST_DELAY_MS > 0) {
      await sleep(TOMORROW_REQUEST_DELAY_MS);
    }

    const tomorrow = await settleSource(airport, 'Tomorrow.io', 'Tomorrow.io', getSourceUrl('Tomorrow.io', airport), fetchTomorrowAirport);
    result.sources.push(tomorrow);
  }

  return results;
}

function getSnapshotDateKey(date = new Date()) {
  return getLocalDateKey(date, 'Europe/Berlin');
}

function getSnapshotPath(dateKey) {
  return path.join(SNAPSHOT_DIR, `${dateKey}.json`);
}

function compactForecastResult(item) {
  return {
    source: item.source,
    label: item.label || item.source,
    model: item.model,
    sourceUrl: item.sourceUrl,
    configured: item.configured !== false,
    requiredEnv: item.requiredEnv,
    temperatureMaxC: item.temperatureMaxC,
    temperatureMaxF: item.temperatureMaxF,
    sourceUnit: item.sourceUnit,
    error: item.error,
    raw: item.raw,
    fetchedAt: item.fetchedAt,
  };
}

function getExpectedSnapshotSources(airport) {
  const sources = [
    'Wunderground',
    'MET Norway',
    'ECMWF IFS',
    'Open-Meteo Ensemble',
    'Visual Crossing',
    'WeatherAPI.com',
    'OpenWeather',
    'Tomorrow.io',
  ];

  if (DWD_MOSMIX_STATIONS[airport.code]) sources.push('DWD MOSMIX');
  if (airport.code === 'LEMD') sources.push('AEMET');
  return sources;
}

function validateForecastSnapshot(snapshot) {
  const issues = [];
  const warnings = [];

  if (!snapshot || !Array.isArray(snapshot.airports)) {
    return {
      ok: false,
      issues: ['Snapshot không có danh sách sân bay'],
      warnings,
      checkedAt: new Date().toISOString(),
    };
  }

  for (const expectedAirport of AIRPORTS) {
    const airport = snapshot.airports.find((item) => item.code === expectedAirport.code);
    if (!airport) {
      issues.push(`${expectedAirport.code}: thiếu airport trong snapshot`);
      continue;
    }

    const forecasts = airport.forecasts || [];
    const openMeteoByModel = new Map(
      forecasts
        .filter((item) => item.source === 'Open-Meteo' && item.model)
        .map((item) => [item.model, item]),
    );

    for (const model of getOpenMeteoModelsForAirport(expectedAirport)) {
      const forecast = openMeteoByModel.get(model);
      if (!forecast) {
        issues.push(`${expectedAirport.code}: thiếu Open-Meteo model ${model}`);
        continue;
      }

      if (forecast.error || typeof forecast.temperatureMaxC !== 'number') {
        warnings.push(`${expectedAirport.code}: Open-Meteo ${model} không có nhiệt độ (${forecast.error || 'no temperatureMaxC'})`);
      }
    }

    const sourceByName = new Map(
      forecasts
        .filter((item) => item.source !== 'Open-Meteo')
        .map((item) => [item.source, item]),
    );

    for (const source of getExpectedSnapshotSources(expectedAirport)) {
      const forecast = sourceByName.get(source);
      if (!forecast) {
        issues.push(`${expectedAirport.code}: thiếu source ${source}`);
        continue;
      }

      if (forecast.configured === false) {
        warnings.push(`${expectedAirport.code}: ${source} chưa configured (${forecast.error || forecast.requiredEnv || 'not configured'})`);
        continue;
      }

      if (forecast.error || typeof forecast.temperatureMaxC !== 'number') {
        issues.push(`${expectedAirport.code}: ${source} lỗi dữ liệu (${forecast.error || 'no temperatureMaxC'})`);
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}

async function createForecastSnapshot(options = {}) {
  const { force = false } = options;
  const snapshotDate = getSnapshotDateKey();
  const snapshotPath = getSnapshotPath(snapshotDate);

  if (!force && fs.existsSync(snapshotPath)) {
    const snapshot = readJsonFile(snapshotPath, null);
    return { created: false, snapshot, validation: validateForecastSnapshot(snapshot) };
  }

  const airports = [];

  for (const airport of AIRPORTS) {
    let openMeteoForecasts = [];
    let externalSources = [];

    try {
      openMeteoForecasts = await fetchOpenMeteoAirport(airport);
    } catch (error) {
      openMeteoForecasts = [{
        source: 'Open-Meteo',
        label: 'Open-Meteo',
        sourceUrl: buildOpenMeteoUrl(airport),
        configured: true,
        error: error.message || 'Open-Meteo snapshot failed',
      }];
    }

    try {
      const externalResult = await fetchAirportExternalSources(airport);
      externalSources = externalResult.sources || [];
    } catch (error) {
      externalSources = [{
        source: 'External sources',
        label: 'External sources',
        configured: true,
        error: error.message || 'External sources snapshot failed',
      }];
    }

    if (TOMORROW_REQUEST_DELAY_MS > 0) {
      await sleep(TOMORROW_REQUEST_DELAY_MS);
    }

    const tomorrow = await settleSource(
      airport,
      'Tomorrow.io',
      'Tomorrow.io',
      getSourceUrl('Tomorrow.io', airport),
      fetchTomorrowAirport,
    );
    externalSources.push(tomorrow);

    airports.push({
      code: airport.code,
      name: airport.name,
      latitude: airport.latitude,
      longitude: airport.longitude,
      timeZone: airport.timeZone,
      forecasts: [...openMeteoForecasts, ...externalSources].map(compactForecastResult),
    });

    await sleep(250);
  }

  const snapshot = {
    date: snapshotDate,
    createdAt: new Date().toISOString(),
    schedule: {
      time: '09:30',
      timeZone: 'Europe/Berlin',
    },
    airports,
  };

  writeJsonFile(snapshotPath, snapshot);
  return { created: true, snapshot, validation: validateForecastSnapshot(snapshot) };
}

function listSnapshots() {
  return fs.readdirSync(SNAPSHOT_DIR)
    .filter((fileName) => /^\d{4}-\d{2}-\d{2}\.json$/.test(fileName))
    .sort()
    .map((fileName) => {
      const snapshot = readJsonFile(path.join(SNAPSHOT_DIR, fileName), {});
      return {
        date: snapshot.date || fileName.replace('.json', ''),
        createdAt: snapshot.createdAt,
        airportCount: snapshot.airports?.length || 0,
      };
    });
}

function readActuals() {
  const actuals = readJsonFile(ACTUALS_FILE, { dates: {} });
  if (!actuals.dates || typeof actuals.dates !== 'object') {
    actuals.dates = {};
  }
  return actuals;
}

function saveActuals(actuals) {
  writeJsonFile(ACTUALS_FILE, actuals);
}

function normalizeActualsPayload(payload) {
  const date = payload.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error('date phải có dạng YYYY-MM-DD');
  }

  const actualsByAirport = payload.actuals || {};
  const normalized = {};

  for (const airport of AIRPORTS) {
    const raw = actualsByAirport[airport.code];
    if (raw === undefined || raw === null || raw === '') continue;

    const value = typeof raw === 'object' ? raw.temperatureMaxC : raw;
    const temperatureMaxC = Number(value);
    if (!Number.isFinite(temperatureMaxC)) {
      throw new Error(`${airport.code}: temperatureMaxC không hợp lệ`);
    }

    normalized[airport.code] = {
      temperatureMaxC: roundOne(temperatureMaxC),
      note: typeof raw === 'object' ? raw.note : undefined,
      enteredAt: new Date().toISOString(),
    };
  }

  return { date, actuals: normalized };
}

function upsertActuals(payload) {
  const { date, actuals: normalized } = normalizeActualsPayload(payload);
  const actuals = readActuals();
  actuals.dates[date] = {
    ...(actuals.dates[date] || {}),
    ...normalized,
  };
  saveActuals(actuals);
  return { date, actuals: actuals.dates[date] };
}

function getForecastKey(forecast) {
  return `${forecast.source || 'unknown'}:${forecast.model || forecast.label || 'default'}`;
}

function buildEvaluation() {
  const actuals = readActuals();
  const rows = [];
  const summary = new Map();
  const summaryByAirport = new Map();

  for (const snapshotInfo of listSnapshots()) {
    const snapshot = readJsonFile(getSnapshotPath(snapshotInfo.date), null);
    const actualsForDate = actuals.dates[snapshotInfo.date] || {};
    if (!snapshot?.airports) continue;

    for (const airport of snapshot.airports) {
      const actual = actualsForDate[airport.code];
      if (!actual || typeof actual.temperatureMaxC !== 'number') continue;

      for (const forecast of airport.forecasts || []) {
        if (forecast.configured === false || forecast.error || typeof forecast.temperatureMaxC !== 'number') continue;

        const error = roundOne(forecast.temperatureMaxC - actual.temperatureMaxC);
        const absError = roundOne(Math.abs(error));
        const key = getForecastKey(forecast);

        rows.push({
          date: snapshotInfo.date,
          airportCode: airport.code,
          source: forecast.source,
          label: forecast.label,
          model: forecast.model,
          forecastC: forecast.temperatureMaxC,
          actualC: actual.temperatureMaxC,
          errorC: error,
          absErrorC: absError,
        });

        const aggregate = summary.get(key) || {
          key,
          source: forecast.source,
          label: forecast.label,
          model: forecast.model,
          count: 0,
          sumError: 0,
          sumAbsError: 0,
          sumSquaredError: 0,
        };

        aggregate.count += 1;
        aggregate.sumError += error;
        aggregate.sumAbsError += Math.abs(error);
        aggregate.sumSquaredError += error * error;
        summary.set(key, aggregate);

        const airportKey = `${airport.code}::${key}`;
        const airportAggregate = summaryByAirport.get(airportKey) || {
          airportCode: airport.code,
          key,
          source: forecast.source,
          label: forecast.label,
          model: forecast.model,
          count: 0,
          sumError: 0,
          sumAbsError: 0,
          sumSquaredError: 0,
        };

        airportAggregate.count += 1;
        airportAggregate.sumError += error;
        airportAggregate.sumAbsError += Math.abs(error);
        airportAggregate.sumSquaredError += error * error;
        summaryByAirport.set(airportKey, airportAggregate);
      }
    }
  }

  const summaryRows = [...summary.values()]
    .map((item) => ({
      key: item.key,
      source: item.source,
      label: item.label,
      model: item.model,
      count: item.count,
      maeC: roundOne(item.sumAbsError / item.count),
      biasC: roundOne(item.sumError / item.count),
      rmseC: roundOne(Math.sqrt(item.sumSquaredError / item.count)),
    }))
    .sort((left, right) => left.maeC - right.maeC || left.rmseC - right.rmseC);

  const summaryByAirportRows = {};
  for (const item of summaryByAirport.values()) {
    const row = {
      key: item.key,
      source: item.source,
      label: item.label,
      model: item.model,
      count: item.count,
      maeC: roundOne(item.sumAbsError / item.count),
      biasC: roundOne(item.sumError / item.count),
      rmseC: roundOne(Math.sqrt(item.sumSquaredError / item.count)),
    };
    summaryByAirportRows[item.airportCode] = summaryByAirportRows[item.airportCode] || [];
    summaryByAirportRows[item.airportCode].push(row);
  }
  for (const code of Object.keys(summaryByAirportRows)) {
    summaryByAirportRows[code].sort((left, right) => left.maeC - right.maeC || left.rmseC - right.rmseC);
  }

  return {
    generatedAt: new Date().toISOString(),
    snapshots: listSnapshots(),
    actualDates: Object.keys(actuals.dates).sort(),
    summary: summaryRows,
    summaryByAirport: summaryByAirportRows,
    rows,
  };
}

async function fetchAllWunderground() {
  const results = await Promise.all(AIRPORTS.map((airport) => (
    settleSource(airport, 'Wunderground', 'Wunderground', getSourceUrl('Wunderground', airport), fetchWundergroundAirport)
  )));

  return results;
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && requestUrl.pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/open-meteo') {
    try {
      const forceRefresh = requestUrl.searchParams.get('refresh') === '1';
      const cached = forceRefresh ? null : readCache(OPEN_METEO_CACHE_FILE);

      if (cached) {
        sendJson(res, 200, { cached: true, ...cached });
        return;
      }

      const results = await fetchOpenMeteoForecasts();
      const payload = {
        createdAt: Date.now(),
        ttlMs: CACHE_TTL_MS,
        models: OPEN_METEO_MODELS,
        modelsByAirport: Object.fromEntries(AIRPORTS.map((airport) => [airport.code, getOpenMeteoModelsForAirport(airport)])),
        results,
      };
      writeCache(OPEN_METEO_CACHE_FILE, payload);
      sendJson(res, 200, { cached: false, ...payload });
    } catch (error) {
      console.error('Open-Meteo API failed:', sanitizeSecret(error.message));
      sendJson(res, 500, { error: sanitizeSecret(error.message || 'Open-Meteo API failed') });
    }
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/snapshots') {
    sendJson(res, 200, { snapshots: listSnapshots() });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/snapshots') {
    try {
      const force = requestUrl.searchParams.get('force') === '1' || requestUrl.searchParams.get('refresh') === '1';
      const result = await createForecastSnapshot({ force });
      sendJson(res, result.created ? 201 : 200, result);
    } catch (error) {
      console.error('Snapshot creation failed:', sanitizeSecret(error.message));
      sendJson(res, 500, { error: sanitizeSecret(error.message || 'Snapshot creation failed') });
    }
    return;
  }

  if (req.method === 'GET' && /^\/api\/snapshots\/\d{4}-\d{2}-\d{2}$/.test(requestUrl.pathname)) {
    const date = requestUrl.pathname.split('/').pop();
    const snapshotPath = getSnapshotPath(date);

    if (!fs.existsSync(snapshotPath)) {
      sendJson(res, 404, { error: `Không tìm thấy snapshot ${date}` });
      return;
    }

    sendJson(res, 200, readJsonFile(snapshotPath, {}));
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/actuals') {
    sendJson(res, 200, readActuals());
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/actuals') {
    try {
      const payload = await readJsonBody(req);
      sendJson(res, 200, upsertActuals(payload));
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Không lưu được actuals' });
    }
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/evaluation') {
    sendJson(res, 200, buildEvaluation());
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/probabilities') {
    try {
      const forceRefresh = requestUrl.searchParams.get('refresh') === '1';
      const dateParam = requestUrl.searchParams.get('date');

      if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        sendJson(res, 400, { error: 'date phải có dạng YYYY-MM-DD' });
        return;
      }

      // Chỉ cache cho request mặc định (hôm nay); date tùy chọn luôn tính mới
      if (!dateParam) {
        const cached = forceRefresh ? null : readCache(PROBABILITIES_CACHE_FILE);
        if (cached) {
          sendJson(res, 200, { cached: true, ...cached });
          return;
        }
      }

      const results = await buildProbabilities(dateParam || null);
      const payload = {
        createdAt: Date.now(),
        ttlMs: CACHE_TTL_MS,
        ensembleModels: ENSEMBLE_MODELS,
        results,
      };

      if (!dateParam) {
        writeCache(PROBABILITIES_CACHE_FILE, payload);
      }

      sendJson(res, 200, { cached: false, ...payload });
    } catch (error) {
      console.error('Probabilities API failed:', sanitizeSecret(error.message));
      sendJson(res, 500, { error: sanitizeSecret(error.message || 'Probabilities API failed') });
    }
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/wunderground') {
    try {
      const forceRefresh = requestUrl.searchParams.get('refresh') === '1';
      const cached = forceRefresh ? null : readCache(WUNDERGROUND_CACHE_FILE);

      if (cached) {
        sendJson(res, 200, { cached: true, ...cached });
        return;
      }

      const results = await fetchAllWunderground();
      const payload = { createdAt: Date.now(), ttlMs: CACHE_TTL_MS, results };
      writeCache(WUNDERGROUND_CACHE_FILE, payload);
      sendJson(res, 200, { cached: false, ...payload });
    } catch (error) {
      console.error('Wunderground API failed:', error.message);
      sendJson(res, 500, { error: error.message || 'Wunderground API failed' });
    }
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/external-forecasts') {
    try {
      const forceRefresh = requestUrl.searchParams.get('refresh') === '1';
      const cached = forceRefresh ? null : readCache(EXTERNAL_CACHE_FILE);

      if (cached) {
        sendJson(res, 200, { cached: true, ...cached });
        return;
      }

      const results = await fetchExternalForecasts();
      const payload = {
        createdAt: Date.now(),
        ttlMs: CACHE_TTL_MS,
        sources: ['Wunderground', 'MET Norway', 'ECMWF IFS', 'Open-Meteo Ensemble', 'Visual Crossing', 'WeatherAPI.com', 'OpenWeather', 'Tomorrow.io', 'DWD MOSMIX', 'AEMET'],
        results,
      };
      writeCache(EXTERNAL_CACHE_FILE, payload);
      sendJson(res, 200, { cached: false, ...payload });
    } catch (error) {
      console.error('External forecasts API failed:', error.message);
      sendJson(res, 500, { error: error.message || 'External forecasts API failed' });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Weather proxy listening on http://127.0.0.1:${PORT}`);
});
