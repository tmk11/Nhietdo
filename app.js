const MODELS = [
  "best_match",
  "icon_seamless",
  "meteofrance_seamless",
  "icon_eu",
  "meteofrance_arpege_europe",
  "icon_d2",
  "meteofrance_arome_france",
  "meteofrance_arome_france_hd",
];
const MODEL_AIRPORT_FILTER = {
  ukmo_uk_deterministic_2km: ["EGLC"],
};
const OPTIONAL_MODELS = Object.keys(MODEL_AIRPORT_FILTER);

function getModelsForAirport(airport) {
  const extras = OPTIONAL_MODELS.filter((model) => MODEL_AIRPORT_FILTER[model].includes(airport.code));
  return [...MODELS, ...extras];
}

const AIRPORTS = [
  { code: "EDDM", name: "Munich Airport", latitude: 48.3538, longitude: 11.7861 },
  { code: "LFPB", name: "Paris–Le Bourget Airport", latitude: 48.9694, longitude: 2.4414 },
  { code: "LIMC", name: "Milan Malpensa Airport", latitude: 45.63, longitude: 8.7281 },
  { code: "EHAM", name: "Amsterdam Schiphol Airport", latitude: 52.3105, longitude: 4.7683 },
  { code: "LEMD", name: "Adolfo Suárez Madrid–Barajas Airport", latitude: 40.4983, longitude: -3.5676 },
  { code: "EGLC", name: "London City Airport", latitude: 51.5053, longitude: 0.0553 },
];

const OPEN_METEO_API_URL = "/api/open-meteo";
const EXTERNAL_FORECASTS_API_URL = "/api/external-forecasts";

const grid = document.querySelector("#airportGrid");
const statusText = document.querySelector("#statusText");
const statusDot = document.querySelector("#statusDot");
const refreshButton = document.querySelector("#refreshButton");
const actualDateInput = document.querySelector("#actualDateInput");
const actualInputs = document.querySelector("#actualInputs");
const saveActualsButton = document.querySelector("#saveActualsButton");
const loadEvaluationButton = document.querySelector("#loadEvaluationButton");
const actualsStatus = document.querySelector("#actualsStatus");
const evaluationTable = document.querySelector("#evaluationTable");
const snapshotDateSelect = document.querySelector("#snapshotDateSelect");
const snapshotAirportSelect = document.querySelector("#snapshotAirportSelect");
const snapshotDateField = document.querySelector("#snapshotDateField");
const snapshotAirportField = document.querySelector("#snapshotAirportField");
const snapshotModeDateButton = document.querySelector("#snapshotModeDate");
const snapshotModeAirportButton = document.querySelector("#snapshotModeAirport");
const loadSnapshotButton = document.querySelector("#loadSnapshotButton");
const snapshotGrid = document.querySelector("#snapshotGrid");
const snapshotMeta = document.querySelector("#snapshotMeta");
const airportTemplate = document.querySelector("#airportCardTemplate");
const modelRowTemplate = document.querySelector("#modelRowTemplate");

function getTemperatureByModel(daily, model) {
  return daily?.[`temperature_2m_max_${model}`]?.[0] ?? daily?.temperature_2m_max?.[0];
}

function formatTemperature(value, unit) {
  if (typeof value !== "number") {
    return "Không có dữ liệu";
  }

  return `${value.toFixed(1)} ${unit || "°C"}`;
}

function formatExternalTemperature(sourceForecast) {
  if (!sourceForecast) {
    return "Đang cập nhật";
  }

  if (sourceForecast.configured === false) {
    return "Thiếu API key";
  }

  if (sourceForecast.error) {
    return "Không có dữ liệu";
  }

  if (typeof sourceForecast.temperatureMaxC !== "number") {
    return "Không có dữ liệu";
  }

  return `${sourceForecast.temperatureMaxC.toFixed(1)} °C`;
}

function setStatus(message, type = "loading") {
  statusText.textContent = message;
  statusDot.className = `status-dot ${type}`.trim();
}

function getBerlinDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function appendDeltaBadge(row, forecastC, actualC) {
  const badge = document.createElement("span");
  badge.className = "model-delta";

  if (typeof forecastC === "number" && typeof actualC === "number") {
    const delta = Math.round((forecastC - actualC) * 10) / 10;
    const sign = delta > 0 ? "+" : "";
    badge.textContent = `${sign}${delta.toFixed(1)}°`;
    const absError = Math.abs(delta);
    badge.classList.add(absError <= 1 ? "delta-good" : absError <= 2.5 ? "delta-mid" : "delta-bad");
    badge.title = `Sai số so với thực tế ${actualC.toFixed(1)} °C`;
  } else {
    badge.textContent = "—";
    badge.classList.add("delta-na");
  }

  row.append(badge);
}

function renderSourceRow(sourceForecast, actualC) {
  const row = modelRowTemplate.content.firstElementChild.cloneNode(true);
  row.classList.add("external-source-row");

  if (sourceForecast?.source === "Wunderground") {
    row.classList.add("wunderground-row");
  }

  if (sourceForecast?.configured === false) {
    row.classList.add("source-pending-row");
  } else if (sourceForecast?.error) {
    row.classList.add("source-error-row");
  }

  const label = document.createElement(sourceForecast?.sourceUrl ? "a" : "span");
  label.textContent = sourceForecast?.label || sourceForecast?.source || "Nguồn bổ sung";
  label.className = "model-name source-link";
  if (sourceForecast?.sourceUrl) {
    label.href = sourceForecast.sourceUrl;
    label.target = "_blank";
    label.rel = "noopener noreferrer";
  }

  row.querySelector(".model-name").replaceWith(label);
  row.querySelector(".model-value").textContent = formatExternalTemperature(sourceForecast);

  const detail = sourceForecast?.error || sourceForecast?.raw;
  if (detail) {
    row.title = detail;
  }

  if (typeof actualC === "number") {
    appendDeltaBadge(row, sourceForecast?.temperatureMaxC, actualC);
  }

  return row;
}

function appendSectionLabel(modelList, text) {
  const divider = document.createElement("p");
  divider.className = "model-section-label";
  divider.textContent = text;
  modelList.append(divider);
}

function renderAirportCard(airport, forecast, externalSources = []) {
  const card = airportTemplate.content.firstElementChild.cloneNode(true);
  const unit = forecast.daily_units?.temperature_2m_max_best_match || "°C";

  card.querySelector(".airport-code").textContent = airport.code;
  card.querySelector(".airport-name").textContent = airport.name;
  card.querySelector(".airport-date").textContent = forecast.daily?.time?.[0] || "Hôm nay";

  const modelList = card.querySelector(".model-list");
  appendSectionLabel(modelList, "Nguồn bổ sung");
  externalSources.forEach((sourceForecast) => modelList.append(renderSourceRow(sourceForecast)));
  appendSectionLabel(modelList, "Open-Meteo models");

  getModelsForAirport(airport).forEach((model) => {
    const row = modelRowTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector(".model-name").textContent = model;
    row.querySelector(".model-value").textContent = formatTemperature(getTemperatureByModel(forecast.daily, model), unit);
    modelList.append(row);
  });

  grid.append(card);
}

async function fetchExternalForecasts(forceRefresh = false) {
  const url = forceRefresh ? `${EXTERNAL_FORECASTS_API_URL}?refresh=1` : EXTERNAL_FORECASTS_API_URL;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`External forecast proxy trả về HTTP ${response.status}`);
  }

  const payload = await response.json();
  return new Map((payload.results || []).map((item) => [item.code, item.sources || []]));
}

async function fetchOpenMeteoForecasts(forceRefresh = false) {
  const url = forceRefresh ? `${OPEN_METEO_API_URL}?refresh=1` : OPEN_METEO_API_URL;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Open-Meteo proxy trả về HTTP ${response.status}`);
  }

  const payload = await response.json();
  return payload.results || [];
}

function renderError(message) {
  const error = document.createElement("div");
  error.className = "error-message";
  error.textContent = message;
  grid.append(error);
}

async function loadForecasts({ forceRefresh = false } = {}) {
  refreshButton.disabled = true;
  grid.replaceChildren();
  setStatus("Đang tải Open-Meteo và các nguồn bổ sung...", "loading");

  const [openMeteoResults, externalForecasts] = await Promise.all([
    fetchOpenMeteoForecasts(forceRefresh),
    fetchExternalForecasts(forceRefresh).catch((error) => {
      console.warn(error);
      return new Map();
    }),
  ]);

  let successCount = 0;
  let externalConfiguredCount = 0;
  let externalSuccessCount = 0;

  openMeteoResults.forEach((result) => {
    if (result.forecast && !result.error) {
      successCount += 1;
      const sources = externalForecasts.get(result.airport.code) || [];
      externalConfiguredCount += sources.filter((source) => source.configured !== false).length;
      externalSuccessCount += sources.filter((source) => source.configured !== false && !source.error).length;
      renderAirportCard(result.airport, result.forecast, sources);
      return;
    }

    renderError(`${result.airport?.code || "Open-Meteo"}: ${result.error || "Không tải được dữ liệu."}`);
  });

  const now = new Date().toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "medium" });
  const statusType = successCount === AIRPORTS.length && externalSuccessCount === externalConfiguredCount ? "" : "error";
  setStatus(`Open-Meteo ${successCount}/${AIRPORTS.length}, nguồn bổ sung ${externalSuccessCount}/${externalConfiguredCount} lúc ${now}`, statusType);
  refreshButton.disabled = false;
}

function initializeActualsForm() {
  actualDateInput.value = getBerlinDateKey();
  actualInputs.replaceChildren();

  AIRPORTS.forEach((airport) => {
    const label = document.createElement("label");
    label.className = "actual-field";
    label.textContent = `${airport.code} thực tế (°C)`;

    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.1";
    input.inputMode = "decimal";
    input.placeholder = "VD: 29.4";
    input.dataset.airportCode = airport.code;
    label.append(input);
    actualInputs.append(label);
  });
}

async function saveActuals() {
  const actuals = {};
  actualInputs.querySelectorAll("input[data-airport-code]").forEach((input) => {
    if (input.value === "") return;
    actuals[input.dataset.airportCode] = Number(input.value);
  });

  saveActualsButton.disabled = true;
  actualsStatus.textContent = "Đang lưu dữ liệu thực tế...";

  try {
    const response = await fetch("/api/actuals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: actualDateInput.value, actuals }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    actualsStatus.textContent = `Đã lưu actuals cho ${payload.date}.`;
    await loadEvaluation();
  } catch (error) {
    actualsStatus.textContent = `Lỗi lưu actuals: ${error.message}`;
  } finally {
    saveActualsButton.disabled = false;
  }
}

function renderEvaluation(payload) {
  const byAirport = payload.summaryByAirport || {};
  const overall = payload.summary || [];

  if (!overall.length && !Object.keys(byAirport).length) {
    evaluationTable.innerHTML = "<p>Chưa có đủ snapshot + dữ liệu thực tế để xếp hạng.</p>";
    return;
  }

  const sections = [];
  const airportOrder = AIRPORTS.map((airport) => airport.code).filter((code) => byAirport[code]?.length);

  for (const code of airportOrder) {
    const airport = AIRPORTS.find((item) => item.code === code);
    const rows = byAirport[code]
      .slice(0, 20)
      .map((item, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${item.label || item.source}</td>
          <td>${item.count}</td>
          <td>${item.maeC.toFixed(1)}</td>
          <td>${item.biasC.toFixed(1)}</td>
          <td>${item.rmseC.toFixed(1)}</td>
        </tr>
      `)
      .join("");

    sections.push(`
      <details class="airport-evaluation" open>
        <summary><strong>${code}</strong> · ${airport?.name || ""}</summary>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Nguồn / Model</th>
              <th>Mẫu</th>
              <th>MAE °C</th>
              <th>Bias °C</th>
              <th>RMSE °C</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </details>
    `);
  }

  if (overall.length) {
    const overallRows = overall.slice(0, 20).map((item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${item.label || item.source}</td>
        <td>${item.count}</td>
        <td>${item.maeC.toFixed(1)}</td>
        <td>${item.biasC.toFixed(1)}</td>
        <td>${item.rmseC.toFixed(1)}</td>
      </tr>
    `).join("");

    sections.push(`
      <details class="airport-evaluation">
        <summary><strong>Tổng hợp 6 sân bay</strong></summary>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Nguồn / Model</th>
              <th>Mẫu</th>
              <th>MAE °C</th>
              <th>Bias °C</th>
              <th>RMSE °C</th>
            </tr>
          </thead>
          <tbody>${overallRows}</tbody>
        </table>
      </details>
    `);
  }

  evaluationTable.innerHTML = sections.join("");
}

async function loadEvaluation() {
  loadEvaluationButton.disabled = true;

  try {
    const response = await fetch("/api/evaluation");
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    renderEvaluation(payload);
  } catch (error) {
    evaluationTable.innerHTML = `<p>Không tải được xếp hạng: ${error.message}</p>`;
  } finally {
    loadEvaluationButton.disabled = false;
  }
}

function renderSnapshotModelRow(forecast, actualC) {
  const row = modelRowTemplate.content.firstElementChild.cloneNode(true);

  if (forecast?.error) {
    row.classList.add("source-error-row");
  }

  row.querySelector(".model-name").textContent = forecast?.model || forecast?.label || forecast?.source || "Model";
  row.querySelector(".model-value").textContent = formatExternalTemperature(forecast);

  const detail = forecast?.error || forecast?.raw;
  if (detail) {
    row.title = detail;
  }

  if (typeof actualC === "number") {
    appendDeltaBadge(row, forecast?.temperatureMaxC, actualC);
  }

  return row;
}

function renderActualRow(actual) {
  const row = modelRowTemplate.content.firstElementChild.cloneNode(true);
  row.classList.add("external-source-row", "wunderground-row");
  row.querySelector(".model-name").textContent = "Thực tế (đo)";
  row.querySelector(".model-value").textContent = `${actual.temperatureMaxC.toFixed(1)} °C`;
  if (actual.note) {
    row.title = actual.note;
  }

  const badge = document.createElement("span");
  badge.className = "model-delta delta-na";
  badge.textContent = "mốc";
  row.append(badge);

  return row;
}

function renderSnapshotCard(airport, snapshotDate, actualForAirport) {
  const card = airportTemplate.content.firstElementChild.cloneNode(true);
  const forecasts = airport.forecasts || [];
  const externalSources = forecasts.filter((forecast) => forecast.source !== "Open-Meteo");
  const openMeteoModels = forecasts.filter((forecast) => forecast.source === "Open-Meteo");

  card.querySelector(".airport-code").textContent = airport.code;
  card.querySelector(".airport-name").textContent = airport.name;
  card.querySelector(".airport-date").textContent = snapshotDate || "";

  const modelList = card.querySelector(".model-list");
  const actualC = actualForAirport && typeof actualForAirport.temperatureMaxC === "number"
    ? actualForAirport.temperatureMaxC
    : undefined;

  if (actualC !== undefined) {
    appendSectionLabel(modelList, "Thực tế");
    modelList.append(renderActualRow(actualForAirport));
  }

  appendSectionLabel(modelList, "Nguồn bổ sung");
  externalSources.forEach((forecast) => modelList.append(renderSourceRow(forecast, actualC)));
  appendSectionLabel(modelList, "Open-Meteo models");
  openMeteoModels.forEach((forecast) => modelList.append(renderSnapshotModelRow(forecast, actualC)));

  return card;
}

function renderSnapshot(snapshot, actualsForDate = {}) {
  snapshotGrid.replaceChildren();
  const airports = snapshot.airports || [];

  AIRPORTS.forEach((meta) => {
    const airport = airports.find((item) => item.code === meta.code);
    if (!airport) return;
    const card = renderSnapshotCard(
      { ...airport, name: airport.name || meta.name },
      snapshot.date,
      actualsForDate[airport.code],
    );
    snapshotGrid.append(card);
  });
}

async function loadSnapshot(date) {
  if (!date) return;

  loadSnapshotButton.disabled = true;
  snapshotMeta.textContent = `Đang tải snapshot ${date}...`;

  try {
    const [snapshot, actuals] = await Promise.all([
      fetch(`/api/snapshots/${date}`).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
        return payload;
      }),
      fetch("/api/actuals").then((response) => response.json()).catch(() => ({ dates: {} })),
    ]);

    const actualsForDate = (actuals.dates && actuals.dates[date]) || {};
    renderSnapshot(snapshot, actualsForDate);

    const createdAt = snapshot.createdAt
      ? new Date(snapshot.createdAt).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" })
      : "—";
    snapshotMeta.textContent = `Snapshot ${snapshot.date} · tạo lúc ${createdAt} · ${snapshot.airports?.length || 0} sân bay`;
  } catch (error) {
    snapshotGrid.replaceChildren();
    snapshotMeta.textContent = `Không tải được snapshot: ${error.message}`;
  } finally {
    loadSnapshotButton.disabled = false;
  }
}

async function loadSnapshotList() {
  try {
    const response = await fetch("/api/snapshots");
    const payload = await response.json();
    const snapshots = (payload.snapshots || [])
      .slice()
      .sort((left, right) => (left.date < right.date ? 1 : -1));

    snapshotDateSelect.replaceChildren();

    if (!snapshots.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Chưa có snapshot";
      snapshotDateSelect.append(option);
      snapshotMeta.textContent = "Chưa có snapshot nào được lưu.";
      return;
    }

    snapshots.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.date;
      option.textContent = `${item.date} (${item.airportCount} sân bay)`;
      snapshotDateSelect.append(option);
    });

    snapshotDateSelect.value = snapshots[0].date;
    await loadSnapshot(snapshots[0].date);
  } catch (error) {
    snapshotMeta.textContent = `Không tải được danh sách snapshot: ${error.message}`;
  }
}

function formatWeekday(dateKey) {
  const date = new Date(`${dateKey}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("vi-VN", { weekday: "long", day: "2-digit", month: "2-digit" });
}

function appendForecastRows(modelList, forecasts, actualC) {
  const externalSources = forecasts.filter((forecast) => forecast.source !== "Open-Meteo");
  const openMeteoModels = forecasts.filter((forecast) => forecast.source === "Open-Meteo");

  appendSectionLabel(modelList, "Nguồn bổ sung");
  externalSources.forEach((forecast) => modelList.append(renderSourceRow(forecast, actualC)));
  appendSectionLabel(modelList, "Open-Meteo models");
  openMeteoModels.forEach((forecast) => modelList.append(renderSnapshotModelRow(forecast, actualC)));
}

function renderDayHistory(day, expanded) {
  const details = document.createElement("details");
  details.className = "day-history";
  details.open = Boolean(expanded);

  const actualC = day.actual && typeof day.actual.temperatureMaxC === "number"
    ? day.actual.temperatureMaxC
    : undefined;

  const summary = document.createElement("summary");
  const actualBadge = actualC !== undefined ? `${actualC.toFixed(1)}°C` : "—";
  const actualClass = actualC !== undefined ? "day-actual" : "day-actual day-actual-empty";
  summary.innerHTML = `
    <span class="day-date">${day.date}</span>
    <span class="day-weekday">${formatWeekday(day.date)}</span>
    <span class="${actualClass}">Thực tế ${actualBadge}</span>
  `;
  details.append(summary);

  const modelList = document.createElement("div");
  modelList.className = "model-list";
  appendForecastRows(modelList, day.forecasts || [], actualC);
  details.append(modelList);

  return details;
}

async function loadAirportHistory(code) {
  if (!code) return;

  loadSnapshotButton.disabled = true;
  snapshotMeta.textContent = `Đang tải lịch sử ${code}...`;

  try {
    const response = await fetch(`/api/airport-history/${code}`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    snapshotGrid.className = "day-history-list";
    snapshotGrid.replaceChildren();

    const days = payload.days || [];
    if (!days.length) {
      snapshotMeta.textContent = `Chưa có snapshot nào cho ${code}.`;
      return;
    }

    days.forEach((day, index) => snapshotGrid.append(renderDayHistory(day, index === 0)));

    const withActual = days.filter((day) => day.actual && typeof day.actual.temperatureMaxC === "number").length;
    snapshotMeta.textContent = `${payload.name || code} · ${days.length} ngày · ${withActual} ngày có thực tế`;
  } catch (error) {
    snapshotGrid.className = "airport-grid";
    snapshotGrid.replaceChildren();
    snapshotMeta.textContent = `Không tải được lịch sử: ${error.message}`;
  } finally {
    loadSnapshotButton.disabled = false;
  }
}

function initializeSnapshotAirportSelect() {
  snapshotAirportSelect.replaceChildren();
  AIRPORTS.forEach((airport) => {
    const option = document.createElement("option");
    option.value = airport.code;
    option.textContent = `${airport.code} · ${airport.name}`;
    snapshotAirportSelect.append(option);
  });
}

function reloadSnapshotView() {
  if (snapshotMode === "airport") {
    loadAirportHistory(snapshotAirportSelect.value);
  } else {
    loadSnapshot(snapshotDateSelect.value);
  }
}

function setSnapshotMode(mode) {
  snapshotMode = mode;
  const airportMode = mode === "airport";

  snapshotModeAirportButton.classList.toggle("is-active", airportMode);
  snapshotModeDateButton.classList.toggle("is-active", !airportMode);
  snapshotDateField.hidden = airportMode;
  snapshotAirportField.hidden = !airportMode;

  if (airportMode) {
    loadAirportHistory(snapshotAirportSelect.value);
  } else {
    snapshotGrid.className = "airport-grid";
    loadSnapshot(snapshotDateSelect.value);
  }
}

let snapshotMode = "date";

refreshButton.addEventListener("click", () => loadForecasts({ forceRefresh: true }));
saveActualsButton.addEventListener("click", saveActuals);
loadEvaluationButton.addEventListener("click", loadEvaluation);
snapshotDateSelect.addEventListener("change", () => loadSnapshot(snapshotDateSelect.value));
snapshotAirportSelect.addEventListener("change", () => loadAirportHistory(snapshotAirportSelect.value));
snapshotModeDateButton.addEventListener("click", () => setSnapshotMode("date"));
snapshotModeAirportButton.addEventListener("click", () => setSnapshotMode("airport"));
loadSnapshotButton.addEventListener("click", reloadSnapshotView);
initializeActualsForm();
initializeSnapshotAirportSelect();
loadForecasts();
loadEvaluation();
loadSnapshotList();
