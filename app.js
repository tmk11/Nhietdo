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

function renderSourceRow(sourceForecast) {
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

refreshButton.addEventListener("click", () => loadForecasts({ forceRefresh: true }));
saveActualsButton.addEventListener("click", saveActuals);
loadEvaluationButton.addEventListener("click", loadEvaluation);
initializeActualsForm();
loadForecasts();
loadEvaluation();
