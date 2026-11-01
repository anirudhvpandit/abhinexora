const state = {
  page: "dashboard",
  dashboard: null,
  analysis: null,
  scenario: null,
  initiatives: [],
  imports: [],
  events: [],
  eventsTotal: 0,
  eventsOffset: 0,
  eventsQuery: "",
  days: 90,
  upload: null,
  mapping: {},
  importResult: null,
  selectedEdge: null,
  activeFilters: new Set(),
};

const pageNames = {
  dashboard: "Command center",
  discovery: "Process discovery",
  data: "Event log",
  opportunities: "Opportunities",
  roadmap: "Transformation",
  reports: "Reports",
};

const content = document.querySelector("#content");
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const type = response.headers.get("content-type") || "";
  const result = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(result?.error || `Request failed (${response.status})`);
  return result;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function number(value, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function percent(value, digits = 0) {
  return value === null || value === undefined ? "—" : `${number(Number(value) * 100, digits)}%`;
}

function money(value, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency", currency: "USD", maximumFractionDigits: digits,
  }).format(value);
}

function formatUtc(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : `${date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}`;
}

function duration(hours, compact = false) {
  if (hours === null || hours === undefined || !Number.isFinite(Number(hours))) return "—";
  const value = Number(hours);
  if (value < 1) return `${number(value * 60, 0)} min`;
  if (value < 48) return `${number(value, 1)} hr`;
  const days = value / 24;
  return `${number(days, compact ? 0 : 1)} day${days >= 1.5 ? "s" : ""}`;
}

function toast(message, error = false) {
  const node = document.createElement("div");
  node.className = `toast${error ? " error" : ""}`;
  node.textContent = message;
  $("#toastRegion").append(node);
  window.setTimeout(() => node.remove(), 4200);
}

function setPage(page) {
  if (!pageNames[page]) return;
  state.page = page;
  state.selectedEdge = null;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === page));
  $("#breadcrumbCurrent").textContent = pageNames[page];
  $("#sidebar").classList.remove("is-open");
  $("#sidebarBackdrop").classList.remove("is-visible");
  renderPage();
}

async function refreshDashboard() {
  const [dashboard, scenario, initiatives, imports] = await Promise.all([
    api(`/api/v1/dashboard?days=${state.days}`),
    api("/api/v1/scenario"),
    api("/api/v1/initiatives"),
    api("/api/v1/imports"),
  ]);
  state.dashboard = dashboard;
  state.analysis = dashboard.analysis;
  state.scenario = scenario;
  state.initiatives = initiatives.items;
  state.imports = imports.items;
  $("#footerDataLabel").textContent = dashboard.dataset_label;
}

async function refreshCurrentPage() {
  if (state.page === "data") await refreshEvents();
  else if (state.page === "roadmap") {
    const result = await api("/api/v1/initiatives");
    state.initiatives = result.items;
  } else if (state.page === "opportunities") {
    state.scenario = await api("/api/v1/scenario");
  }
  renderPage();
}

async function refreshEvents() {
  const query = new URLSearchParams({
    limit: "12",
    offset: String(state.eventsOffset),
    q: state.eventsQuery,
    days: String(state.days),
  });
  const [events, imports] = await Promise.all([
    api(`/api/v1/events?${query}`),
    api("/api/v1/imports"),
  ]);
  state.events = events.items;
  state.eventsTotal = events.total;
  state.imports = imports.items;
}

function heading(kicker, title, subtitle, actions = "") {
  return `<div class="page-heading">
    <div><div class="eyebrow">${esc(kicker)}</div><h1>${esc(title)}</h1><p class="page-subtitle">${esc(subtitle)}</p></div>
    ${actions ? `<div class="heading-actions">${actions}</div>` : ""}
  </div>`;
}

function panelHeader(title, subtitle = "", actions = "") {
  return `<div class="panel-header"><div class="panel-title-wrap"><h2 class="panel-title">${esc(title)}</h2>${subtitle ? `<p class="panel-description">${esc(subtitle)}</p>` : ""}</div>${actions ? `<div class="panel-header-actions">${actions}</div>` : ""}</div>`;
}

function metricCard(label, value, note, icon, tone, tooltip, unit = "") {
  return `<article class="metric-card" title="${esc(tooltip)}">
    <div class="metric-top"><span class="metric-label">${esc(label)}</span><span class="metric-mini-icon ${tone}">${icon}</span></div>
    <div class="metric-value">${esc(value)}${unit ? `<span class="metric-unit">${esc(unit)}</span>` : ""}</div>
    <div class="metric-foot"><span>${esc(note)}</span><span class="metric-info" title="${esc(tooltip)}" aria-label="${esc(tooltip)}">i</span></div>
  </article>`;
}

function sampleBanner() {
  if (!state.dashboard) return "";
  const isSynthetic = state.dashboard.dataset_label.startsWith("Synthetic");
  return `<div class="sample-notice"><span class="notice-icon">i</span><span><strong>${isSynthetic ? "Synthetic demonstration data" : "Imported event log"}.</strong> ${isSynthetic ? "Deterministic sample invoices are stored and analyzed by the same pipeline as uploaded data." : "Metrics below are calculated from the selected workspace event log."}</span><span class="notice-trailing">${number(state.analysis.event_count)} events · ${number(state.analysis.case_count)} cases</span></div>`;
}

function dashboardPage() {
  const a = state.analysis;
  const compliance = a.sla.compliance;
  const complianceLabel = compliance === null ? "No completed cases" : `${percent(compliance)} within threshold`;
  const riskCount = a.sla.breached_cases;
  const mainActions = `<button class="button" data-action="open-upload">＋ Import event log</button><button class="button button-primary" data-page="discovery">Explore process <span aria-hidden="true">→</span></button>`;
  return `${heading("OVERVIEW / INVOICE-TO-PAY", "Process command center", "Operational performance, process behavior, and evidence-backed improvement signals.", mainActions)}
    ${sampleBanner()}
    <section class="metric-grid" aria-label="Process metrics">
      ${metricCard("Cases analyzed", number(a.case_count), `${number(a.event_count)} observed events`, "▤", "slate", "Distinct case IDs in the selected event log.")}
      ${metricCard("Median cycle time", duration(a.cycle_time.median_hours), `${duration(a.cycle_time.p90_hours)} at P90`, "◷", "blue", "Elapsed time between each eligible case's first and last observed event.")}
      ${metricCard("SLA compliance", compliance === null ? "—" : percent(compliance), complianceLabel, "⌁", compliance !== null && compliance < .8 ? "amber" : "teal", `Completed cases at or below the ${number(a.sla.threshold_hours)}-hour demonstration SLA threshold.`)}
      ${metricCard("Process variants", number(a.variant_count), `${percent(a.rework_rate)} cases repeat an activity`, "⤴", "amber", "Distinct observed activity sequences. Rework rate counts cases with a repeated activity.")}
    </section>
    <section class="dashboard-grid">
      <article class="panel">${panelHeader("Observed process map", "Directly-follows view · edge width reflects transition event count", `<button class="text-link" data-page="discovery">Open explorer →</button>`)}
        <div class="panel-body"><div class="process-map-wrap">${renderGraph(a)}</div><div class="map-legend"><span class="legend-item"><i class="legend-line"></i>Observed transitions</span><span class="legend-item"><i class="legend-line amber"></i>Long median elapsed time</span><span class="legend-item"><i class="legend-dot"></i>Activity volume shown below node</span></div></div>
      </article>
      <article class="panel">${panelHeader("Process health", "Signals calculated from observed cases")}
        ${healthPanel(a, riskCount)}
      </article>
    </section>
    <section class="lower-grid">
      <article class="panel">${panelHeader("Most common variants", "Observed case sequences", `<button class="text-link" data-page="discovery">All variants →</button>`)}
        ${variantTable(a.variants.slice(0, 5))}
      </article>
      <article class="panel">${panelHeader("Potential bottlenecks", "Transitions with ≥8h median elapsed time", `<button class="text-link" data-page="opportunities">View analysis →</button>`)}
        ${bottleneckList(a.bottlenecks.slice(0, 4))}
      </article>
    </section>`;
}

function healthPanel(a, riskCount) {
  const score = a.quality_score;
  const healthItems = [
    { icon: "!", tone: "red", title: "SLA breaches", detail: `Cases above ${number(a.sla.threshold_hours)} elapsed hours`, value: number(riskCount) },
    { icon: "↻", tone: "", title: "Repeated activity", detail: "Cases with a repeated activity", value: percent(a.rework_rate) },
    { icon: "⌘", tone: "blue", title: "Observed transitions", detail: "Directly-follows relationships", value: number(a.edges.length) },
  ];
  return `<div class="health-score"><div class="score-ring" style="--score:${score}%"><strong>${number(score)}</strong></div><div class="score-copy"><strong>Event-log integrity</strong><span>Valid persisted rows ÷ all rows submitted across imports. Synthetic seed records are schema-valid.</span></div></div>
    <div class="health-list">${healthItems.map((item) => `<div class="health-item"><span class="health-icon ${item.tone}">${item.icon}</span><span class="health-copy"><strong>${esc(item.title)}</strong><span>${esc(item.detail)}</span></span><strong class="health-value">${esc(item.value)}</strong></div>`).join("")}</div>`;
}

function variantTable(variants) {
  if (!variants.length) return `<div class="empty-state"><strong>No process variants yet</strong>Import an event log to discover case sequences.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Variant</th><th>Cases</th><th>Share</th><th>Median cycle</th></tr></thead><tbody>${variants.map((variant, index) => `<tr>
    <td><span class="variant-name"><i class="variant-marker ${index % 3 ? `alt-${index % 3}` : ""}"></i><span class="variant-sequence">${esc(variant.sequence.join(" → "))}</span></span></td>
    <td>${number(variant.cases)}</td><td><span class="share-bar"><span class="share-track"><i class="share-fill" style="width:${Math.max(3, variant.share * 100)}%"></i></span><span class="share-text">${percent(variant.share, 1)}</span></span></td>
    <td>${duration(variant.median_hours)}</td>
  </tr>`).join("")}</tbody></table></div><div class="table-footer"><span>Variant membership is based on ordered activity sequences.</span><span>${number(variants.length)} shown</span></div>`;
}

function bottleneckList(items) {
  if (!items.length) return `<div class="empty-state"><strong>No high-delay transition found</strong>Current rule flags transitions with a median elapsed time of at least 8 hours and adequate case volume.</div>`;
  return `<div class="bottleneck-list">${items.map((item, index) => `<div class="bottleneck-row"><span class="rank-number">${index + 1}</span><span class="bottleneck-copy"><strong>${esc(item.source)} → ${esc(item.target)}</strong><span>${number(item.case_count)} cases · ${number(item.count)} observed transitions</span></span><strong class="bottleneck-hours">${duration(item.median_hours)}<small>median elapsed</small></strong></div>`).join("")}</div>`;
}

function renderGraph(a) {
  const primaryPath = [...new Set(a.variants[0]?.sequence || [])];
  const nodes = [...primaryPath];
  for (const variant of a.variants) {
    for (let index = 0; index < variant.sequence.length; index += 1) {
      const activity = variant.sequence[index];
      if (nodes.includes(activity)) continue;
      let previous = -1;
      let next = -1;
      for (let i = index - 1; i >= 0; i -= 1) {
        if (nodes.includes(variant.sequence[i])) { previous = nodes.indexOf(variant.sequence[i]); break; }
      }
      for (let i = index + 1; i < variant.sequence.length; i += 1) {
        if (nodes.includes(variant.sequence[i])) { next = nodes.indexOf(variant.sequence[i]); break; }
      }
      let insertion = previous >= 0 ? previous + 1 : next >= 0 ? next : nodes.length;
      if (next > previous && insertion > next) insertion = next;
      nodes.splice(insertion, 0, activity);
    }
  }
  for (const activity of a.activities) if (!nodes.includes(activity.name)) nodes.push(activity.name);
  if (!nodes.length) return `<div class="empty-state"><strong>No events to visualize</strong>Import events with mapped case, activity, and timestamp fields.</div>`;
  const width = Math.max(620, nodes.length * 128 + 36);
  const height = 250;
  const nodeWidth = Math.min(108, Math.max(74, width / nodes.length - 19));
  const nodeHeight = 42;
  const extraRow = new Map();
  let extraIndex = 0;
  for (const name of nodes) {
    if (!primaryPath.includes(name)) { extraRow.set(name, extraIndex % 2 ? 164 : 34); extraIndex += 1; }
  }
  const positions = new Map(nodes.map((name, index) => [name, {
    x: 18 + index * (width - 36) / Math.max(nodes.length - 1, 1),
    y: primaryPath.includes(name) ? 102 : extraRow.get(name),
  }]));
  const maxCount = Math.max(...a.edges.map((item) => item.count), 1);
  const frequentVariant = a.variants[0]?.sequence || [];
  const highlightEdges = new Set(frequentVariant.slice(0, -1).map((activity, index) => `${activity}\u0000${frequentVariant[index + 1]}`));
  const edgeMarkup = a.edges.filter((edge) => {
    if (state.activeFilters.has("frequent") && edge.transition_share < 0.06) return false;
    if (state.activeFilters.has("delay") && edge.median_hours < 8) return false;
    return true;
  }).map((edge) => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) return "";
    const sx = source.x + nodeWidth / 2;
    const tx = target.x - nodeWidth / 2;
    const sy = source.y + nodeHeight / 2;
    const ty = target.y + nodeHeight / 2;
    const curve = edge.source === edge.target
      ? `M ${source.x - 12} ${source.y + 8} C ${source.x - 40} ${source.y - 14}, ${source.x - 36} ${source.y - 38}, ${source.x} ${source.y - 31} C ${source.x + 36} ${source.y - 24}, ${source.x + 34} ${source.y + 2}, ${source.x + 12} ${source.y + 8}`
      : sx <= tx
        ? `M ${sx} ${sy} C ${sx + (tx - sx) * .48} ${sy - 26}, ${tx - (tx - sx) * .48} ${ty - 26}, ${tx} ${ty}`
        : `M ${sx} ${sy} C ${sx + 18} ${height - 14}, ${tx - 18} ${height - 14}, ${tx} ${ty}`;
    const widthPx = 1.4 + (Math.log(edge.count + 1) / Math.log(maxCount + 1)) * 3.8;
    const key = `${edge.source}\u0000${edge.target}`;
    const classes = ["map-edge", edge.median_hours >= 8 ? "bottleneck-edge" : "", highlightEdges.has(key) ? "is-highlighted" : ""].filter(Boolean).join(" ");
    return `<path class="${classes}" data-edge="${esc(JSON.stringify({ source: edge.source, target: edge.target }))}" d="${curve}" stroke-width="${widthPx}" marker-end="url(#edge-arrow)" tabindex="0" role="button" aria-label="${esc(`${edge.source} to ${edge.target}, ${number(edge.count)} transitions`)}"><title>${esc(edge.source)} to ${esc(edge.target)}: ${number(edge.count)} transitions, ${number(edge.case_count)} cases, ${duration(edge.median_hours)} median elapsed</title></path>`;
  }).join("");
  const nodeMarkup = a.activities.map((item) => {
    const pos = positions.get(item.name);
    const label = item.name.length > 17 ? `${item.name.slice(0, 15)}…` : item.name;
    const bottleneckNode = a.bottlenecks.some((edge) => edge.target === item.name);
    return `<g class="map-node ${bottleneckNode ? "is-bottleneck" : ""}" data-node="${esc(item.name)}" transform="translate(${pos.x - nodeWidth / 2},${pos.y})" tabindex="0" role="button" aria-label="${esc(item.name)}, ${number(item.cases)} cases">
      <rect width="${nodeWidth}" height="${nodeHeight}" rx="7"></rect><text x="9" y="17">${esc(label)}</text><text class="node-count" x="9" y="32">${number(item.cases)} cases · ${number(item.events)} events</text></g>`;
  }).join("");
  const grid = [56, 95, 134, 173, 212].map((y) => `<line class="map-grid" x1="0" y1="${y}" x2="${width}" y2="${y}"/>`).join("");
  return `<svg class="process-map" style="width:${width}px;height:${height}px" viewBox="0 0 ${width} ${height}" role="group" aria-label="Observed directly-follows process graph"><defs><marker id="edge-arrow" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,7 L6,3.5 z" fill="#8095c9"/></marker></defs>${grid}${edgeMarkup}${nodeMarkup}</svg>`;
}

function activityTable(activities) {
  return `<div class="table-wrap"><table><thead><tr><th>Activity</th><th>Event count</th><th>Case coverage</th></tr></thead><tbody>${activities.map((item) => `<tr><td><strong>${esc(item.name)}</strong></td><td>${number(item.events)}</td><td>${number(item.cases)} cases</td></tr>`).join("")}</tbody></table></div>`;
}

function discoveryPage() {
  const a = state.analysis;
  const edge = state.selectedEdge ? a.edges.find((item) => item.source === state.selectedEdge.source && item.target === state.selectedEdge.target) : null;
  const node = state.selectedNode ? a.activities.find((item) => item.name === state.selectedNode) : null;
  const detail = edge ? `<div class="graph-detail"><h3>${esc(edge.source)} → ${esc(edge.target)}</h3><p>Observed directly-follows relationship. Edge share is the fraction of all adjacent event pairs in the selected event log.</p>
    <div class="detail-stat"><span>Transition events</span><strong>${number(edge.count)}</strong></div><div class="detail-stat"><span>Distinct cases</span><strong>${number(edge.case_count)}</strong></div><div class="detail-stat"><span>Transition share</span><strong>${percent(edge.transition_share, 1)}</strong></div><div class="detail-stat"><span>Median elapsed</span><strong>${duration(edge.median_hours)}</strong></div><div class="detail-stat"><span>Mean elapsed</span><strong>${duration(edge.mean_hours)}</strong></div>
    <div class="detail-note">Elapsed time is measured between adjacent events; it is not assumed to be pure queue or processing time.</div></div>`
    : node ? `<div class="graph-detail"><h3>${esc(node.name)}</h3><p>Activity frequency in the selected event log.</p><div class="detail-stat"><span>Observed events</span><strong>${number(node.events)}</strong></div><div class="detail-stat"><span>Cases containing activity</span><strong>${number(node.cases)}</strong></div><div class="detail-note">Activity frequency counts events; case coverage counts distinct case IDs.</div></div>`
      : `<div class="graph-detail"><h3>Process map</h3><p>Select an activity or transition to inspect the observed evidence.</p><div class="detail-stat"><span>Cases</span><strong>${number(a.case_count)}</strong></div><div class="detail-stat"><span>Directly-follows edges</span><strong>${number(a.edges.length)}</strong></div><div class="detail-stat"><span>Discovered variants</span><strong>${number(a.variant_count)}</strong></div><div class="detail-note">A directly-follows graph describes event ordering in the log. It does not prove a causal dependency or capture concurrency.</div></div>`;
  const actions = `<button class="button button-small" data-action="export-report">Export analysis CSV</button>`;
  return `${heading("ANALYZE / PROCESS DISCOVERY", "Process discovery studio", "Explore observed activity order, transition frequency, case variants, and elapsed-time patterns.", actions)}
    ${sampleBanner()}
    <div class="section-tabs"><button class="section-tab active" data-tab-target="#discovery-map">Process map</button><button class="section-tab" data-tab-target="#discovery-variants">Variants (${number(a.variant_count)})</button><button class="section-tab" data-tab-target="#discovery-activities">Activities (${number(a.activities.length)})</button></div>
    <div class="split-layout"><section class="panel" id="discovery-map">
      ${panelHeader("Directly-follows graph", "Observed transitions, not a normative or causal model", `<span class="status-pill">Version · current dataset</span>`)}
      <div class="filter-row"><button class="filter-chip ${state.activeFilters.has("frequent") ? "active" : ""}" data-filter="frequent">Frequent transitions</button><button class="filter-chip ${state.activeFilters.has("delay") ? "active" : ""}" data-filter="delay">Median elapsed ≥ 8h</button><span class="field-hint">Filters hide edges; source events remain unchanged.</span></div>
      <div class="panel-body"><div class="process-map-wrap">${renderGraph(a)}</div><div class="map-legend"><span class="legend-item"><i class="legend-line"></i>Observed transitions · width = event count</span><span class="legend-item"><i class="legend-line amber"></i>Median elapsed ≥ 8 hours</span><span class="legend-item">Scroll horizontally to inspect all activities.</span></div></div>
      <div id="discovery-variants">${panelHeader("Observed process variants", "Sequences grouped by exact ordered activity name")}${variantsDetailTable(a.variants)}</div>
      <div id="discovery-activities">${panelHeader("Activity frequency", "Event count and distinct case coverage")}${activityTable(a.activities)}</div>
    </section><aside class="panel">${panelHeader("Evidence detail", "Select a node or edge")}${detail}</aside></div>`;
}

function variantsDetailTable(variants) {
  return `<div class="table-wrap"><table><thead><tr><th>Variant sequence</th><th>Cases</th><th>Share</th><th>Median cycle</th></tr></thead><tbody>${variants.slice(0, 15).map((variant, index) => `<tr><td><div class="variant-sequence-full">${variant.sequence.map((part, i) => `${i ? `<span class="sequence-arrow">→</span>` : ""}<span class="sequence-step">${esc(part)}</span>`).join("")}</div></td><td>${number(variant.cases)}</td><td>${percent(variant.share, 1)}</td><td>${duration(variant.median_hours)}</td></tr>`).join("")}</tbody></table></div><div class="table-footer"><span>Incomplete traces are retained as observed; no completion is inferred.</span><span>${number(variants.length)} variants</span></div>`;
}

function dataPage() {
  const importRows = state.imports.map((item) => `<tr><td>${esc(item.filename)}</td><td>${esc(item.status.replaceAll("_", " "))}</td><td>${number(item.rows_imported)}</td><td>${number(item.rows_rejected)}</td><td>${esc(new Date(item.created_at).toLocaleDateString())}</td></tr>`).join("");
  const allRows = state.dashboard.analysis.event_count;
  const rejected = state.imports.reduce((sum, item) => sum + item.rows_rejected, 0);
  const seen = state.imports.reduce((sum, item) => sum + item.rows_seen, 0);
  const score = seen > 0 ? Math.round((seen - rejected) / seen * 100) : 100;
  const start = state.eventsTotal ? state.eventsOffset + 1 : 0;
  const end = Math.min(state.eventsOffset + state.events.length, state.eventsTotal);
  return `${heading("DATA / INGESTION", "Event log & data quality", "Map, validate, and inspect event data used by process analysis.", `<button class="button" data-action="download-sample">Download sample CSV</button>`)}
    <div class="data-layout">
      <section class="panel">${panelHeader("Import event log", "CSV · UTF-8 · 8 MB maximum")}
        <div class="panel-body"><div class="upload-drop ${state.upload ? "has-file" : ""}" id="uploadDrop"><span class="upload-icon">⇧</span><strong>${state.upload ? esc(state.upload.name) : "Drop a CSV file here, or browse"}</strong><p>${state.upload ? `${number(state.upload.rows)} data rows detected · ${number(state.upload.headers.length)} columns` : "CSV with a header row · No file is sent until you select Import"}</p><button class="button button-small" type="button" data-action="browse-file">Choose file</button><input id="csvInput" type="file" accept=".csv,text/csv" aria-label="Choose CSV file"></div>
          ${state.upload ? `<div class="mapping-grid">${mappingField("case_id", "Case ID", true)}${mappingField("activity", "Activity", true)}${mappingField("timestamp", "Event timestamp", true)}${mappingField("resource", "Resource", false)}</div>
            <div class="mapping-actions"><span class="field-hint">Timestamps must be ISO 8601 or a Python-supported ISO timestamp.</span><button class="button button-primary" data-action="import-csv">Validate & import</button></div>` : ""}
          ${state.importResult ? `<div class="upload-result"><div class="result-banner ${state.importResult.rows_rejected ? "warning" : ""}"><strong>${esc(state.importResult.status.replaceAll("_", " "))}.</strong><span>${esc(state.importResult.message)} ${number(state.importResult.rows_seen)} rows checked.</span></div>${state.importResult.errors?.length ? `<div class="result-errors">${state.importResult.errors.map((error) => `Row ${number(error.row)}: ${esc(error.reason)}`).join("<br>")}${state.importResult.rows_rejected > state.importResult.errors.length ? `<br>Additional rejected rows: ${state.importResult.rows_rejected - state.importResult.errors.length}` : ""}</div>` : ""}</div>` : ""}
        </div>
      </section>
      <section class="panel">${panelHeader("Data quality", "Score formula: valid imported rows ÷ all submitted rows")}
        <div class="quality-card"><div class="quality-header"><strong>Import validity</strong><span class="quality-score">${number(score)}%</span></div><div class="quality-bar"><span style="width:${score}%"></span></div>
          <div class="quality-row"><span>Rows submitted</span><strong>${number(seen)}</strong></div><div class="quality-row"><span>Accepted rows</span><strong>${number(seen - rejected)}</strong></div><div class="quality-row"><span>Rejected rows</span><strong>${number(rejected)}</strong></div><div class="quality-row"><span>Current event records</span><strong>${number(allRows)}</strong></div>
          <p class="quality-footnote">${seen ? "Duplicate events, missing required values, and invalid timestamps are rejected and included in this score. Synthetic seed data is schema-valid and not part of import validity." : "No imports yet. Synthetic seed data is schema-valid and excluded from import validity."}</p>
        </div>
      </section>
    </div>
    <section class="panel" style="margin-top:13px">${panelHeader("Recent imports", "Validation summaries")}
      <div class="table-wrap"><table><thead><tr><th>File</th><th>Status</th><th>Imported</th><th>Rejected</th><th>Date</th></tr></thead><tbody>${importRows || `<tr><td colspan="5"><div class="empty-state">No uploaded files. The demonstration event log is already available.</div></td></tr>`}</tbody></table></div>
    </section>
    <section class="panel" style="margin-top:13px">${panelHeader("Event explorer", "Searchable, paginated source events", `<form id="eventSearchForm" class="global-search events-search"><span>⌕</span><input id="eventSearchInput" value="${esc(state.eventsQuery)}" type="search" placeholder="Search case or activity" aria-label="Search events"></form>`)}
      <div class="table-wrap"><table><thead><tr><th>Case ID</th><th>Activity</th><th>Event time (UTC)</th><th>Resource</th></tr></thead><tbody>${state.events.length ? state.events.map((item) => `<tr><td><strong>${esc(item.case_id)}</strong></td><td>${esc(item.activity)}</td><td>${esc(formatUtc(item.event_time))}</td><td>${esc(item.resource || "—")}</td></tr>`).join("") : `<tr><td colspan="4"><div class="empty-state"><strong>No matching events</strong>Try a different case ID or activity name.</div></td></tr>`}</tbody></table></div>
      <div class="table-footer"><span>Showing ${number(start)}–${number(end)} of ${number(state.eventsTotal)} events</span><div class="pagination"><button data-action="events-prev" ${state.eventsOffset <= 0 ? "disabled" : ""} aria-label="Previous page">‹</button><button data-action="events-next" ${end >= state.eventsTotal ? "disabled" : ""} aria-label="Next page">›</button></div></div>
    </section>`;
}

function mappingField(key, label, required) {
  const headers = state.upload?.headers || [];
  return `<div class="field"><label for="mapping-${key}">${esc(label)}${required ? " *" : ""}</label><select class="select" id="mapping-${key}" data-map="${key}"><option value="">${required ? "Select a column" : "Not mapped"}</option>${headers.map((header) => `<option value="${esc(header)}" ${state.mapping[key] === header ? "selected" : ""}>${esc(header)}</option>`).join("")}</select></div>`;
}

function parseCsvHeader(text) {
  const line = text.split(/\r?\n/, 1)[0] || "";
  const result = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') { value += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { result.push(value.trim()); value = ""; }
    else value += char;
  }
  result.push(value.trim());
  return result.filter(Boolean);
}

function inferMapping(headers) {
  const find = (regex) => headers.find((header) => regex.test(header.toLowerCase())) || "";
  return {
    case_id: find(/case|invoice|order|ticket|request/),
    activity: find(/activity|event|step|action/),
    timestamp: find(/timestamp|time|date/),
    resource: find(/resource|user|owner|agent/),
  };
}

function opportunityEvidence() {
  const a = state.analysis;
  const opportunities = [];
  const loopVariants = a.variants.filter((variant) => {
    const countByActivity = new Set(variant.sequence);
    return countByActivity.size < variant.sequence.length;
  });
  if (loopVariants.length) {
    const impacted = loopVariants.reduce((sum, item) => sum + item.cases, 0);
    opportunities.push({
      title: "Reduce repeated approval work",
      description: "Approval activity repeats in observed cases. Review delegation rules, approval thresholds, and handoff ownership before considering automation.",
      cases: impacted,
      evidence: `${number(loopVariants.length)} variants contain repeated activities; ${number(impacted)} cases are in those variants.`,
      complexity: "Medium",
      confidence: "Observed pattern",
      risk: "Preserve segregation of duties and required approval controls; repeated activity alone does not establish that a step is automatable.",
    });
  }
  for (const edge of a.bottlenecks.slice(0, 3)) {
    opportunities.push({
      title: `Investigate ${edge.source.toLowerCase()} → ${edge.target.toLowerCase()}`,
      description: "A high-volume transition has a long observed median elapsed time. Validate queue ownership, operating hours, and event semantics with process owners.",
      cases: edge.case_count,
      evidence: `${number(edge.case_count)} distinct cases · median ${duration(edge.median_hours)} between adjacent events.`,
      complexity: edge.case_count > 40 ? "Medium" : "Low",
      confidence: "Elapsed-time signal",
      risk: "Elapsed time between events is not necessarily pure waiting time. Validate with operational owners before sizing an intervention.",
    });
  }
  if (!opportunities.length && a.case_count) {
    opportunities.push({
      title: "Review process variation",
      description: "Compare the most common process path with less-frequent sequences and confirm which differences are intentional.",
      cases: a.case_count,
      evidence: `${number(a.variant_count)} distinct observed variants across ${number(a.case_count)} cases.`,
      complexity: "Low",
      confidence: "Observed variation",
      risk: "Variation may reflect legitimate policy or case complexity. Do not standardize without control-owner review.",
    });
  }
  return opportunities;
}

function opportunityCard(item, index) {
  return `<article class="panel opportunity-card"><div class="opportunity-top"><div class="opportunity-heading"><span class="opportunity-icon">✳</span><div><h3>${esc(item.title)}</h3><p>${esc(item.description)}</p></div></div><span class="confidence-pill">${esc(item.confidence)}</span></div>
    <div class="opportunity-meta"><div class="meta-block"><span>Affected cases</span><strong>${number(item.cases)}</strong></div><div class="meta-block"><span>Potential complexity</span><strong>${esc(item.complexity)}</strong></div><div class="meta-block"><span>Evidence basis</span><strong>Observed event log</strong></div></div>
    <div class="evidence-line"><strong>Evidence</strong><span>${esc(item.evidence)}</span></div><div class="risk-note"><strong>Validation & controls:</strong> ${esc(item.risk)}</div>
    <div class="mapping-actions"><span class="field-hint">Hypothesis only · no realized savings claimed</span><button class="button button-small" data-action="promote-opportunity" data-index="${index}">Add to roadmap</button></div></article>`;
}

function assumptionField(key, label, suffix, step = "1") {
  const value = state.scenario?.assumptions?.[key] ?? "";
  return `<div class="field assumption-field"><label for="assumption-${key}">${esc(label)}<span>${esc(suffix)}</span></label><input class="input" type="number" step="${step}" min="0" id="assumption-${key}" data-assumption="${key}" value="${esc(value)}"></div>`;
}

function financialPanel() {
  const s = state.scenario || {};
  const resultItems = [
    ["Annual addressable labor cost", money(s.annual_addressable_labor_cost), false],
    ["Annual gross savings", money(s.annual_gross_savings), false],
    ["Annual net benefit", money(s.annual_net_benefit), true],
    ["First-year net impact", money(s.first_year_net_impact), false],
    ["3-year net benefit", money(s.three_year_net_benefit), false],
    ["3-year ROI", s.three_year_roi_percent === null ? "—" : `${number(s.three_year_roi_percent, 1)}%`, false],
    ["Payback", s.payback_months === null ? "Not reached" : `${number(s.payback_months, 1)} months`, false],
  ];
  return `<section class="financial-layout"><article class="panel">${panelHeader("Financial assumptions", "Editable model inputs · USD")}
    <div class="assumption-grid">
      ${assumptionField("annual_volume", "Annual case volume", "cases")}
      ${assumptionField("manual_minutes", "Manual effort per case", "minutes", ".5")}
      ${assumptionField("hourly_cost", "Loaded labor cost", "USD / hr", ".5")}
      ${assumptionField("eligible_share", "Eligible share", "0–1", ".01")}
      ${assumptionField("time_reduction", "Expected time reduction", "0–1", ".01")}
      ${assumptionField("realization", "Realization factor", "0–1", ".01")}
      ${assumptionField("implementation_cost", "Implementation cost", "USD", "100")}
      ${assumptionField("annual_recurring_cost", "Annual recurring cost", "USD", "100")}
      ${assumptionField("ramp_months", "Ramp-up period", "months", "1")}
    </div>
    <div class="formula-box"><strong>Annual gross savings</strong> = annual volume × manual minutes ÷ 60 × hourly cost × eligible share × time reduction × realization. <strong>First year</strong> applies a linear ramp factor, then subtracts recurring and implementation costs. Payback includes half the ramp period.</div>
    <div class="panel-body" style="padding-top:0"><button class="button button-primary" data-action="save-scenario">Recalculate & save scenario</button></div>
  </article><article class="panel">${panelHeader("Scenario output", "Calculated from the assumptions at left")}
    <div class="result-grid">${resultItems.map(([label, value, highlight]) => `<div class="result-metric ${highlight ? "highlight" : ""}"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("")}</div>
    <p class="result-disclaimer"><strong>Estimate, not realized savings.</strong> Results depend on editable assumptions, a half-ramp-year approximation, and undiscounted three-year cash flows. Validate costs, adoption, eligibility, and baseline time with Finance and process owners.</p>
  </article></section>`;
}

function opportunitiesPage() {
  const opportunities = opportunityEvidence();
  return `${heading("OPTIMIZE / DECISION SUPPORT", "Automation intelligence", "Evidence-led process improvement hypotheses with transparent financial assumptions.", `<button class="button" data-page="discovery">Inspect process map</button>`)}
    <div class="sample-notice"><span class="notice-icon">i</span><span><strong>Recommendations are hypotheses.</strong> Frequency and elapsed time can prioritize investigation; they do not prove automability or realized benefit.</span></div>
    <div class="opportunity-list">${opportunities.map(opportunityCard).join("")}</div>
    ${financialPanel()}`;
}

function roadmapPage() {
  const initiatives = state.initiatives;
  const count = initiatives.length;
  const proposed = initiatives.filter((item) => item.status === "Proposed").length;
  return `${heading("TRANSFORM / DELIVERY", "Transformation roadmap", "Turn validated process findings into owned initiatives, measurable milestones, and control-aware plans.", `<button class="button button-primary" data-action="focus-initiative">＋ New initiative</button>`)}
    <div class="roadmap-summary"><div class="summary-chip"><span class="summary-chip-icon">▤</span><span><span>Total initiatives</span><strong>${number(count)}</strong></span></div><div class="summary-chip"><span class="summary-chip-icon">◷</span><span><span>Proposed</span><strong>${number(proposed)}</strong></span></div><div class="summary-chip"><span class="summary-chip-icon">✓</span><span><span>Estimated benefit</span><strong>Not yet validated</strong></span></div></div>
    <div class="roadmap-body"><section class="panel">${panelHeader("Initiative portfolio", "Persisted proposals · assign an owner after review")}
      ${initiatives.length ? initiatives.map((item) => `<div class="initiative-row"><div class="initiative-title"><i class="initiative-dot"></i><div><strong>${esc(item.title)}</strong><span>${esc(item.description)}</span></div></div><div class="initiative-detail"><span>Owner</span><strong>${esc(item.owner)}</strong></div><div class="initiative-detail"><span>Business case</span><strong>${item.evidence?.affected_cases ? `${number(item.evidence.affected_cases)} affected cases · estimate pending` : "Not quantified"}</strong></div><span class="status-pill">${esc(item.status)}</span></div>`).join("") : `<div class="empty-state"><strong>No initiatives yet</strong>Add an evidence-backed opportunity or create a proposal using the form.</div>`}
      <div class="table-footer"><span>Initiatives are proposals; delivery progress is not connected to an external system.</span><span>${number(count)} saved</span></div>
    </section><aside class="panel" id="initiativeFormPanel">${panelHeader("Draft an initiative", "Define ownership and a measurable outcome")}
      <form class="initiative-form" id="initiativeForm"><div class="field"><label for="initiativeTitle">Initiative title *</label><input class="input" id="initiativeTitle" name="title" maxlength="160" placeholder="e.g. Streamline invoice approval" required></div>
        <div class="field"><label for="initiativeDescription">Problem & proposed change *</label><textarea class="textarea" id="initiativeDescription" name="description" maxlength="3000" placeholder="Describe the measured baseline, proposed intervention, controls, and a validation criterion." required></textarea></div>
        <div class="field"><label for="initiativeOwner">Accountable owner</label><input class="input" id="initiativeOwner" name="owner" maxlength="120" placeholder="Unassigned"></div>
        <div class="field"><label for="initiativeOutcome">Success measure</label><input class="input" id="initiativeOutcome" name="outcome" maxlength="300" placeholder="e.g. Reduce median approval elapsed time"></div>
        <button class="button button-primary" type="submit">Save proposal</button></form>
    </aside></div>`;
}

function reportsPage() {
  const reportCards = [
    ["Current-state process assessment", "Case volumes, observed variants, direct-follows transitions, and performance measures.", "◫", "current-state"],
    ["Bottleneck analysis", "High-delay transitions with affected case counts and elapsed-time semantics.", "◷", "bottlenecks"],
    ["Variant analysis", "Exact sequence counts, percentage of cases, and median cycle duration.", "⤴", "variants"],
    ["Executive summary", "A concise current analysis extract with observed findings and limitations.", "▧", "executive"],
    ["Data quality summary", "Import totals, rejected rows, and current valid-event count.", "✓", "quality"],
    ["Financial scenario", "Saved assumptions and estimated business-case outputs.", "$", "financial"],
  ];
  return `${heading("REPORTS / EVIDENCE", "Reports & exports", "Download analysis derived from the current stored event log.", `<button class="button button-primary" data-action="export-report">Export current analysis</button>`)}
    <div class="sample-notice"><span class="notice-icon">i</span><span><strong>CSV export available.</strong> PDF, XLSX, and scheduled reporting are not implemented in this local release.</span></div>
    <div class="report-grid">${reportCards.map(([title, description, icon, type]) => `<article class="panel report-card"><span class="report-icon">${esc(icon)}</span><h3>${esc(title)}</h3><p>${esc(description)}</p><button class="button button-small" data-action="export-report" data-report-type="${esc(type)}">Download CSV</button></article>`).join("")}</div>
    <article class="panel report-method">${panelHeader("Calculation & methodology notes", "Trace the output to its source and interpretation")}
      <div class="panel-body">Exports include the reporting timestamp, event and case totals, cycle-time percentiles, SLA threshold, bottleneck transitions, and discovered variants. Metrics are recalculated from stored events when the file is requested.
        <ul><li>Cycle time is first-to-last observed event, only for cases with at least two events.</li><li>P90 uses linear interpolation over sorted case durations.</li><li>Transition elapsed time is adjacent-event timestamp difference; not assumed to be pure wait time.</li><li>Variant identity is the exact ordered sequence of activity names; incomplete cases remain as observed.</li><li>SLA is a configurable-in-code 72-hour demonstration threshold.</li><li>Financial estimates are exported separately and are not represented as realized benefits.</li></ul>
      </div>
    </article>`;
}

function renderPage() {
  if (!state.analysis) return;
  state.selectedNode = state.selectedNode || null;
  const renderers = {
    dashboard: dashboardPage,
    discovery: discoveryPage,
    data: dataPage,
    opportunities: opportunitiesPage,
    roadmap: roadmapPage,
    reports: reportsPage,
  };
  content.innerHTML = renderers[state.page]();
}

async function boot() {
  try {
    await refreshDashboard();
    await refreshCurrentPage();
  } catch (error) {
    content.innerHTML = `<section class="panel"><div class="panel-body"><h2>Could not load workspace</h2><p>${esc(error.message)}</p><button class="button button-primary" data-action="retry">Retry</button></div></section>`;
    return;
  }
  renderPage();
}

function setUpload(file, text) {
  const headers = parseCsvHeader(text.replace(/^\uFEFF/, ""));
  if (!headers.length) {
    toast("The selected file has no readable CSV header row.", true);
    return;
  }
  const detected = inferMapping(headers);
  state.upload = {
    name: file.name,
    content: text.replace(/^\uFEFF/, ""),
    headers,
    rows: Math.max(0, text.split(/\r?\n/).filter((line) => line.length).length - 1),
  };
  state.mapping = detected;
  state.importResult = null;
  renderPage();
}

function readCsvFile(file) {
  if (!file.name.toLowerCase().endsWith(".csv")) {
    toast("Only CSV files are supported in this release.", true);
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    toast("CSV file exceeds the 8 MB upload limit.", true);
    return;
  }
  file.text().then((text) => setUpload(file, text)).catch(() => toast("Could not read the selected file.", true));
}

async function performImport(button) {
  if (!state.upload) {
    toast("Choose a CSV file before importing.", true);
    return;
  }
  for (const field of ["case_id", "activity", "timestamp"]) {
    if (!state.mapping[field]) {
      toast(`Map the required ${field.replace("_", " ")} column first.`, true);
      return;
    }
  }
  button.disabled = true;
  button.textContent = "Validating…";
  try {
    state.importResult = await api("/api/v1/imports", {
      method: "POST",
      body: JSON.stringify({ filename: state.upload.name, content: state.upload.content, mapping: state.mapping }),
    });
    await refreshDashboard();
    await refreshEvents();
    state.page = "data";
    state.upload = null;
    renderPage();
    toast(state.importResult.message);
  } catch (error) {
    button.disabled = false;
    button.textContent = "Validate & import";
    toast(error.message, true);
  }
}

async function saveScenario(button) {
  const assumptions = {};
  $$("[data-assumption]").forEach((input) => { assumptions[input.dataset.assumption] = Number(input.value); });
  button.disabled = true;
  button.textContent = "Calculating…";
  try {
    state.scenario = await api("/api/v1/scenario", { method: "POST", body: JSON.stringify({ assumptions }) });
    renderPage();
    toast("Scenario assumptions saved and recalculated.");
  } catch (error) {
    button.disabled = false;
    button.textContent = "Recalculate & save scenario";
    toast(error.message, true);
  }
}

async function saveInitiative(form, evidence = {}) {
  const formData = new FormData(form);
  const outcome = $("#initiativeOutcome", form)?.value || "";
  const description = String(formData.get("description") || "").trim();
  const result = await api("/api/v1/initiatives", {
    method: "POST",
    body: JSON.stringify({
      title: String(formData.get("title") || "").trim(),
      description: outcome ? `${description}\n\nSuccess measure: ${outcome}` : description,
      owner: String(formData.get("owner") || "Unassigned").trim() || "Unassigned",
      evidence,
    }),
  });
  state.initiatives.unshift(result);
  setPage("roadmap");
  toast("Initiative proposal saved.");
}

async function downloadReport(reportType = "executive") {
  try {
    const response = await fetch(`/api/v1/report.csv?days=${state.days}&type=${encodeURIComponent(reportType)}`);
    if (!response.ok) throw new Error("Report export failed.");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `abhinexora-${reportType}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast("Analysis CSV downloaded.");
  } catch (error) {
    toast(error.message, true);
  }
}

function downloadSample() {
  const header = "case_id,activity,event_timestamp,resource";
  const base = Date.parse("2026-10-01T00:00:00Z");
  const rows = [];
  const patterns = [
    [["Invoice received", 0], ["Invoice validated", 2], ["Approval requested", 4], ["Payment scheduled", 20], ["Payment completed", 25]],
    [["Invoice received", 0], ["Invoice validated", 2], ["Approval requested", 3], ["Approval requested", 48], ["Payment scheduled", 70], ["Payment completed", 75]],
    [["Invoice received", 0], ["Invoice validated", 2], ["Correction requested", 4], ["Invoice resubmitted", 28], ["Invoice validated", 30], ["Approval requested", 35], ["Payment scheduled", 54], ["Payment completed", 60]],
  ];
  for (let index = 1; index <= 18; index += 1) {
    const caseId = `SAMPLE-${String(index).padStart(3, "0")}`;
    for (const [step, offset] of patterns[index % patterns.length]) {
      const timestamp = new Date(base - (index * 36 + (60 - offset)) * 3600000).toISOString();
      const resource = step === "Invoice received" ? "" : `AP-${String(index % 5 + 1).padStart(2, "0")}`;
      rows.push([caseId, step, timestamp, resource].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","));
    }
  }
  const blob = new Blob([[header, ...rows].join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "abhinexora-synthetic-invoice-events.csv";
  link.click();
  URL.revokeObjectURL(url);
  toast("Deterministic-shape sample CSV generated in your browser. The contents are synthetic.");
}

function openOpportunityForm(index) {
  const item = opportunityEvidence()[index];
  if (!item) return;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
    <div class="modal-header"><div><h2 id="modalTitle">Add evidence to roadmap</h2><p>Review the finding and define an accountable proposal.</p></div><button class="modal-close" data-action="close-modal" aria-label="Close dialog">×</button></div>
    <form class="initiative-form" id="promoteForm"><div class="field"><label for="promoteTitle">Initiative title *</label><input class="input" id="promoteTitle" name="title" maxlength="160" required value="${esc(item.title)}"></div>
    <div class="field"><label for="promoteDescription">Problem & proposed change *</label><textarea class="textarea" id="promoteDescription" name="description" maxlength="3000" required>${esc(item.description)}\n\nEvidence: ${esc(item.evidence)}\n\nValidation / controls: ${esc(item.risk)}</textarea></div>
    <div class="field"><label for="promoteOwner">Owner</label><input class="input" id="promoteOwner" name="owner" maxlength="120" value="Unassigned"></div><button class="button button-primary" type="submit">Save roadmap proposal</button></form></section>`;
  document.body.append(backdrop);
  $("#promoteTitle", backdrop).focus();
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop || event.target.closest('[data-action="close-modal"]')) backdrop.remove();
  });
  $("#promoteForm", backdrop).addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const result = await api("/api/v1/initiatives", {
        method: "POST",
        body: JSON.stringify({
          title: data.get("title"),
          description: data.get("description"),
          owner: data.get("owner"),
          evidence: { affected_cases: item.cases, confidence: item.confidence, source: item.evidence },
        }),
      });
      state.initiatives.unshift(result);
      backdrop.remove();
      setPage("roadmap");
      toast("Evidence-backed proposal saved to the roadmap.");
    } catch (error) {
      toast(error.message, true);
    }
  });
}

document.addEventListener("click", async (event) => {
  const pageButton = event.target.closest("[data-page]");
  if (pageButton) {
    event.preventDefault();
    setPage(pageButton.dataset.page);
    if (pageButton.dataset.page === "data") {
      try { await refreshEvents(); renderPage(); } catch (error) { toast(error.message, true); }
    }
    return;
  }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "open-upload") {
    setPage("data");
    try { await refreshEvents(); renderPage(); } catch (error) { toast(error.message, true); }
    return;
  }
  if (action === "browse-file") { $("#csvInput")?.click(); return; }
  if (action === "import-csv") { await performImport(event.target.closest("button")); return; }
  if (action === "save-scenario") { await saveScenario(event.target.closest("button")); return; }
  if (action === "export-report") {
    await downloadReport(event.target.closest("[data-report-type]")?.dataset.reportType || "executive");
    return;
  }
  if (action === "download-sample") { downloadSample(); return; }
  if (action === "promote-opportunity") { openOpportunityForm(Number(event.target.closest("[data-index]").dataset.index)); return; }
  if (action === "close-modal") { event.target.closest(".modal-backdrop")?.remove(); return; }
  if (action === "focus-initiative") { $("#initiativeTitle")?.focus(); $("#initiativeFormPanel")?.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
  if (action === "events-prev" && state.eventsOffset > 0) {
    state.eventsOffset = Math.max(0, state.eventsOffset - 12);
    await refreshEvents(); renderPage(); return;
  }
  if (action === "events-next" && state.eventsOffset + state.events.length < state.eventsTotal) {
    state.eventsOffset += 12;
    await refreshEvents(); renderPage(); return;
  }
  if (action === "retry") { await boot(); return; }
  const filter = event.target.closest("[data-filter]");
  if (filter) {
    const key = filter.dataset.filter;
    state.activeFilters.has(key) ? state.activeFilters.delete(key) : state.activeFilters.add(key);
    renderPage();
    return;
  }
  const tab = event.target.closest("[data-tab-target]");
  if (tab) {
    $$(".section-tab").forEach((item) => item.classList.toggle("active", item === tab));
    $(tab.dataset.tabTarget)?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const edge = event.target.closest("[data-edge]");
  if (edge) {
    state.selectedEdge = JSON.parse(edge.dataset.edge);
    state.selectedNode = null;
    renderPage();
    return;
  }
  const node = event.target.closest("[data-node]");
  if (node) {
    state.selectedNode = node.dataset.node;
    state.selectedEdge = null;
    renderPage();
    return;
  }
  if (event.target.closest("#dateControl")) {
    const choices = [30, 90, 365];
    const currentIndex = choices.indexOf(state.days);
    state.days = choices[(currentIndex + 1) % choices.length];
    $("#dateControl").dataset.range = `${state.days}d`;
    $("#dateControl").innerHTML = `<span class="calendar-icon">▦</span><span>Last ${state.days} days</span><span class="chevron">⌄</span>`;
    try {
      await refreshDashboard();
      if (state.page === "data") await refreshEvents();
      renderPage();
    } catch (error) { toast(error.message, true); }
    return;
  }
  if (event.target.closest("#menuToggle")) {
    $("#sidebar").classList.toggle("is-open");
    $("#sidebarBackdrop").classList.toggle("is-visible");
    return;
  }
  if (event.target.closest("#sidebarBackdrop")) {
    $("#sidebar").classList.remove("is-open");
    $("#sidebarBackdrop").classList.remove("is-visible");
    return;
  }
  if (event.target.closest(".notification-button")) toast("No notifications are configured in this local release.");
});

document.addEventListener("change", (event) => {
  if (event.target.matches("[data-map]")) state.mapping[event.target.dataset.map] = event.target.value;
  if (event.target.id === "csvInput") {
    const file = event.target.files?.[0];
    if (!file) return;
    readCsvFile(file);
  }
});

document.addEventListener("dragover", (event) => {
  const dropZone = event.target.closest("#uploadDrop");
  if (!dropZone) return;
  event.preventDefault();
  dropZone.classList.add("drag-over");
});

document.addEventListener("dragleave", (event) => {
  const dropZone = event.target.closest("#uploadDrop");
  if (dropZone && !dropZone.contains(event.relatedTarget)) dropZone.classList.remove("drag-over");
});

document.addEventListener("drop", (event) => {
  const dropZone = event.target.closest("#uploadDrop");
  if (!dropZone) return;
  event.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = event.dataTransfer?.files?.[0];
  if (file) readCsvFile(file);
});

document.addEventListener("submit", async (event) => {
  if (event.target.id === "eventSearchForm") {
    event.preventDefault();
    state.eventsQuery = $("#eventSearchInput").value.trim();
    state.eventsOffset = 0;
    try { await refreshEvents(); renderPage(); } catch (error) { toast(error.message, true); }
    return;
  }
  if (event.target.id === "initiativeForm") {
    event.preventDefault();
    try { await saveInitiative(event.target); } catch (error) { toast(error.message, true); }
  }
});

document.addEventListener("input", (event) => {
  if (event.target.matches("[data-assumption]")) {
    const key = event.target.dataset.assumption;
    const value = Number(event.target.value);
    if (Number.isFinite(value) && state.scenario) state.scenario.assumptions[key] = value;
  }
});

$("#globalSearch").addEventListener("keydown", async (event) => {
  if (event.key === "Enter") {
    state.eventsQuery = event.target.value.trim();
    state.eventsOffset = 0;
    setPage("data");
    try { await refreshEvents(); renderPage(); } catch (error) { toast(error.message, true); }
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("#globalSearch").focus();
  }
  const graphItem = event.target.closest("[data-edge], [data-node]");
  if (graphItem && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    graphItem.click();
  }
  if (event.key === "Escape") document.querySelector(".modal-backdrop")?.remove();
});

boot();
