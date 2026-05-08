// === GLOBAL INSIGHT ENGINE v6 - DOCKER + FASTAPI ===
// Updated: 2024-01-08-v12
const CONFIG = { maxCountries: 200, correlationThreshold: 0.3, outlierZScore: 2 };
let dataset = [], variableDefs = [], categories = [], selectedVar = null;
let corrFilter = 'all', activeCategory = null, activeTab = 'explorer', peerMode = 'global';
let weights = {}, charts = {}, CURRENT_DATASET = null;
let compareCountries = [];
let currentDatasetId = 'builtin:embed';

// === API BASE ===
const API_BASE = window.location.origin;
async function api(path, opts = {}) {
  const r = await fetch(`${API_BASE}${path}`, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function apiWithSignal(path, opts = {}) {
  if (_abortController) opts = { ...opts, signal: _abortController.signal };
  return api(path, opts);
}

// === MATH ===
const M = {
  mean: a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0,
  std: a => { const m = M.mean(a); return a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) : 0; },
  pearson: (x, y) => {
    const n = x.length; if (n < 2 || n !== y.length) return 0;
    const mx = M.mean(x), my = M.mean(y); let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { const xi = x[i] - mx, yi = y[i] - my; num += xi * yi; dx += xi * xi; dy += yi * yi; }
    return dx && dy ? num / Math.sqrt(dx * dy) : 0;
  },
  percentile: (a, v) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return (s.filter(x => x <= v).length / s.length) * 100; },
  zscore: (a, v) => { const m = M.mean(a), s = M.std(a); return s ? (v - m) / s : 0; }
};

// === DATA ===
function vals(key) { return dataset.map(d => parseFloat(d[key])).filter(v => !isNaN(v)); }
function getCorrelations(varKey) {
  if (!varKey) return [];
  const vx = vals(varKey); if (!vx.length) return [];
  return variableDefs.filter(v => v.key !== varKey).map(v => {
    const vy = vals(v.key);
    return { key: v.key, name: v.name, icon: v.icon, r: vy.length ? M.pearson(vx, vy) : 0 };
  }).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
}

function detectOutliers(key) {
  const v = vals(key); if (!v.length) return [];
  const m = M.mean(v), s = M.std(v);
  return dataset.map(d => {
    const val = parseFloat(d[key]);
    if (isNaN(val)) return null;
    const z = s ? (val - m) / s : 0;
    return Math.abs(z) >= CONFIG.outlierZScore ? { country: d.country, value: val, zscore: z, key } : null;
  }).filter(Boolean).sort((a, b) => Math.abs(b.zscore) - Math.abs(a.zscore));
}

function generateInsights(key, allCorr) {
  const values = vals(key); if (!values.length) return {};
  const mean = M.mean(values), std = M.std(values);
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const highest = dataset.reduce((a, b) => { const av = parseFloat(a[key]) || 0, bv = parseFloat(b[key]) || 0; return av > bv ? a : b; }, dataset[0]);
  const lowest = dataset.reduce((a, b) => { const av = parseFloat(a[key]) || Infinity, bv = parseFloat(b[key]) || Infinity; return av < bv ? a : b; }, dataset[0]);
  const range = (parseFloat(highest[key]) || 0) - (parseFloat(lowest[key]) || 0);
  const bestCorr = allCorr[0];
  const worstCorr = allCorr.filter(c => c.r < 0)[0];
  const outliers = detectOutliers(key);
  const strong = allCorr.filter(c => Math.abs(c.r) > 0.7).length;
  return { mean, median, std, range, highest, lowest, bestCorr, worstCorr, outliers, strong };
}

// === CHARTS ===
function renderDistribution(key, values) {
  if (charts.dist) charts.dist.destroy();
  const el = document.getElementById('distributionChart'); if (!el) return;
  const bins = 15, min = Math.min(...values), max = Math.max(...values), step = (max - min) / bins || 1;
  const labels = Array.from({ length: bins }, (_, i) => (min + step * i).toFixed(1));
  const data = Array(bins).fill(0);
  values.forEach(v => { const i = Math.min(bins - 1, Math.floor((v - min) / step)); data[i]++; });
  charts.dist = new Chart(el, {
    type: 'bar', data: { labels, datasets: [{ data, backgroundColor: 'rgba(34,211,238,0.25)', borderColor: 'rgba(34,211,238,0.5)', borderWidth: 1, borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { color: 'rgba(148,163,184,0.05)' }, ticks: { color: '#64748b', font: { size: 10 } } }, y: { grid: { color: 'rgba(148,163,184,0.05)' }, ticks: { color: '#64748b', font: { size: 10 } } } } }
  });
}

function renderNetwork(key, corrs) {
  const canvas = document.getElementById('networkCanvas'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width; canvas.height = rect.height;
  if (rect.width === 0 || rect.height === 0) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const nodes = [{ x: canvas.width / 2, y: canvas.height / 2, label: variableDefs.find(v => v.key === key)?.name || key, color: '#22d3ee', size: 12 }];
  const top = corrs.slice(0, 8);
  const radius = Math.min(canvas.width, canvas.height) * 0.35;
  top.forEach((c, i) => {
    const angle = (i / top.length) * Math.PI * 2 - Math.PI / 2;
    nodes.push({ x: canvas.width / 2 + Math.cos(angle) * radius, y: canvas.height / 2 + Math.sin(angle) * radius, label: c.name, color: c.r > 0 ? '#06b6d4' : '#f43f5e', size: 6 + Math.abs(c.r) * 6 });
  });
  top.forEach((c, i) => {
    const n = nodes[i + 1];
    ctx.beginPath();
    ctx.moveTo(nodes[0].x, nodes[0].y);
    ctx.lineTo(n.x, n.y);
    ctx.strokeStyle = c.r > 0 ? 'rgba(34,211,238,0.2)' : 'rgba(244,63,94,0.2)';
    ctx.lineWidth = 1 + Math.abs(c.r) * 2;
    ctx.stroke();
  });
  nodes.forEach(n => {
    ctx.beginPath(); ctx.arc(n.x, n.y, n.size, 0, Math.PI * 2);
    ctx.fillStyle = n.color; ctx.globalAlpha = 0.8; ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#94a3b8'; ctx.font = '11px Inter'; ctx.textAlign = 'center';
    ctx.fillText(n.label, n.x, n.y + n.size + 14);
  });
}

function renderScatter(d1, d2) {
  if (charts.scatter) charts.scatter.destroy();
  const el = document.getElementById('scatterChart'); if (!el) return;
  const data = dataset.map(row => {
    const x = parseFloat(row[d1.key]), y = parseFloat(row[d2.key]);
    return (!isNaN(x) && !isNaN(y)) ? { x, y, label: row.country } : null;
  }).filter(Boolean);
  charts.scatter = new Chart(el, {
    type: 'scatter', data: { datasets: [{ label: `${d1.name} vs ${d2.name}`, data: data.map(d => ({ x: d.x, y: d.y })), backgroundColor: 'rgba(34,211,238,0.5)', borderColor: 'rgba(34,211,238,0.8)', pointRadius: 4, pointHoverRadius: 7 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${ctx.raw.label}: (${d1.name}=${ctx.raw.x?.toFixed(1)}, ${d2.name}=${ctx.raw.y?.toFixed(1)})` } } }, scales: { x: { title: { display: true, text: `${d1.name} (${d1.unit})`, color: '#94a3b8', font: { size: 11 } }, grid: { color: 'rgba(148,163,184,0.05)' }, ticks: { color: '#64748b', font: { size: 10 } } }, y: { title: { display: true, text: `${d2.name} (${d2.unit})`, color: '#94a3b8', font: { size: 11 } }, grid: { color: 'rgba(148,163,184,0.05)' }, ticks: { color: '#64748b', font: { size: 10 } } } } }
  });
}

function renderHeatmap() {
  const canvas = document.getElementById('heatmapCanvas'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const n = Math.min(variableDefs.length, 16);
  const size = 34, padding = 110;
  canvas.width = n * size + padding; canvas.height = n * size + padding;
  if (canvas.width === 0 || canvas.height === 0) return;
  ctx.fillStyle = '#0a0e1a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '10px Inter'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const label = variableDefs[i].name.slice(0, 18);
    ctx.fillStyle = '#94a3b8'; ctx.fillText(label, padding - 8, padding + i * size + size / 2);
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  for (let j = 0; j < n; j++) {
    const label = variableDefs[j].name.slice(0, 18);
    ctx.save();
    ctx.translate(padding + j * size + size / 2, padding - 8);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = '#94a3b8'; ctx.fillText(label, 0, 0);
    ctx.restore();
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const r = i === j ? 1 : M.pearson(vals(variableDefs[i].key), vals(variableDefs[j].key));
      const h = 180 + r * 60;
      const s = 20 + Math.abs(r) * 60;
      const l = 15 + Math.abs(r) * 25;
      ctx.fillStyle = `hsl(${h},${s}%,${l}%)`; ctx.fillRect(padding + j * size, padding + i * size, size - 1, size - 1);
    }
  }
}

// === UI ===
function renderVariableList() {
  const list = document.getElementById('variableList');
  const search = (document.getElementById('varSearch')?.value || '').toLowerCase();
  const filtered = variableDefs.filter(v => {
    const matchesSearch = !search || v.name.toLowerCase().includes(search) || v.key.toLowerCase().includes(search);
    const matchesCat = !activeCategory || v.category === activeCategory;
    return matchesSearch && matchesCat;
  });
  list.innerHTML = filtered.map(v => `
    <div class="variable-item p-2.5 cursor-pointer ${selectedVar === v.key ? 'active' : ''}" onclick="selectVariable('${v.key}')">
      <div class="flex items-center gap-2">
        <i data-lucide="${v.icon}" class="w-3.5 h-3.5 text-slate-500"></i>
        <div class="flex-1 min-w-0">
          <div class="text-xs font-medium text-white truncate">${v.name}</div>
          <div class="text-[0.65rem] text-slate-500">${v.category}</div>
        </div>
      </div>
    </div>
  `).join('');
  lucide.createIcons();
}

function renderCategoryGrid() {
  const grid = document.getElementById('categoryGrid');
  if (!grid) return;
  grid.innerHTML = categories.map(c => `
    <button onclick="setCategory('${c}')" class="cat-tile ${activeCategory === c ? 'active' : ''}">
      ${c}
    </button>
  `).join('') + `
    <button onclick="setCategory(null)" class="cat-tile ${!activeCategory ? 'active' : ''}">
      All
    </button>
  `;
}

function setCategory(cat) {
  activeCategory = cat;
  renderCategoryGrid();
  renderVariableList();
}

function filterVariables() {
  renderVariableList();
}

function selectVariable(key) {
  selectedVar = key;
  renderVariableList();
  showVariableDetails(key);
}

function showVariableDetails(key) {
  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('resultsArea').classList.remove('hidden');
  const v = variableDefs.find(d => d.key === key);
  if (!v) return;
  const values = vals(key);
  const insights = generateInsights(key, getCorrelations(key));
  document.getElementById('varTitle').textContent = v.name;
  document.getElementById('varMeta').textContent = `${v.category} · ${values.length} countries · ${v.unit}`;
  document.getElementById('varDesc').textContent = v.desc || '';
  document.getElementById('varMean').textContent = insights.mean.toFixed(1);
  renderDistribution(key, values);
  const corrs = getCorrelations(key);
  renderNetwork(key, corrs);
  renderCorrelationBars(corrs);
  initScatterSelect();
  updateScatterPlot();
  renderHeatmap();
  renderInsights(insights, v);
  renderNarrative(insights, v);
  document.getElementById('peerToggleContainer').style.display = 'flex';
}

function renderCorrelationBars(corrs) {
  const container = document.getElementById('correlationBars');
  if (!container) return;
  const filtered = corrFilter === 'all' ? corrs : corrs.filter(c => corrFilter === 'positive' ? c.r > 0 : c.r < 0);
  container.innerHTML = filtered.slice(0, 12).map((c, i) => {
    const w = Math.min(100, Math.abs(c.r) * 100);
    const color = c.r > 0 ? 'bg-brand-500' : 'bg-rose-500';
    return `
      <div class="flex items-center gap-3 cursor-pointer hover:bg-slate-800/30 p-1.5 rounded-lg transition-colors" onclick="selectVariable('${c.key}')">
        <div class="w-24 text-xs text-slate-300 truncate">${c.name}</div>
        <div class="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
          <div class="h-full ${color} rounded-full corr-bar" style="width:0%;animation:fillBar 0.8s ${i * 0.05}s forwards"></div>
        </div>
        <div class="w-14 text-xs font-mono ${c.r > 0 ? 'text-brand-300' : 'text-rose-300'}">${c.r > 0 ? '+' : ''}${c.r.toFixed(2)}</div>
      </div>
      <style>@keyframes fillBar{to{width:${w}%}}</style>
    `;
  }).join('');
}

function setCorrFilter(filter) {
  corrFilter = filter;
  if (selectedVar) renderCorrelationBars(getCorrelations(selectedVar));
}

function initScatterSelect() {
  const sel = document.getElementById('scatterVarSelect');
  if (!sel || !selectedVar) return;
  sel.innerHTML = variableDefs.filter(v => v.key !== selectedVar).map(v => `<option value="${v.key}">${v.name}</option>`).join('');
}

function updateScatterPlot() {
  if (!selectedVar) return;
  const sel = document.getElementById('scatterVarSelect');
  if (!sel) return;
  const d1 = variableDefs.find(v => v.key === selectedVar);
  const d2 = variableDefs.find(v => v.key === sel.value);
  if (d1 && d2) renderScatter(d1, d2);
}

function renderInsights(insights, v) {
  const banners = document.getElementById('insightBanners');
  if (!banners) return;
  const cards = [];
  if (insights.bestCorr) {
    cards.push(`
      <div class="insight-card glass-light p-4 border-l-2 border-brand-500">
        <div class="flex items-center gap-2 mb-1"><i data-lucide="link" class="w-3.5 h-3.5 text-brand-400"></i><span class="text-xs font-semibold text-white">Strongest Link</span></div>
        <div class="text-sm text-slate-300">${insights.bestCorr.name} <span class="text-brand-300">r=${insights.bestCorr.r.toFixed(2)}</span></div>
      </div>
    `);
  }
  if (insights.worstCorr) {
    cards.push(`
      <div class="insight-card glass-light p-4 border-l-2 border-rose-500">
        <div class="flex items-center gap-2 mb-1"><i data-lucide="arrow-down" class="w-3.5 h-3.5 text-rose-400"></i><span class="text-xs font-semibold text-white">Inverse Link</span></div>
        <div class="text-sm text-slate-300">${insights.worstCorr.name} <span class="text-rose-300">r=${insights.worstCorr.r.toFixed(2)}</span></div>
      </div>
    `);
  }
  if (insights.outliers.length) {
    cards.push(`
      <div class="insight-card glass-light p-4 border-l-2 border-amber-500">
        <div class="flex items-center gap-2 mb-1"><i data-lucide="alert-triangle" class="w-3.5 h-3.5 text-amber-400"></i><span class="text-xs font-semibold text-white">${insights.outliers.length} Outliers</span></div>
        <div class="text-sm text-slate-300">${insights.outliers.slice(0, 3).map(o => o.country).join(', ')}${insights.outliers.length > 3 ? '...' : ''}</div>
      </div>
    `);
  }
  banners.innerHTML = cards.join('');
  lucide.createIcons();
}

function renderNarrative(insights, v) {
  const panel = document.getElementById('narrativePanel');
  const text = document.getElementById('narrativeText');
  if (!panel || !text) return;
  const parts = [];
  parts.push(`${v.name} averages <strong class="text-brand-300">${insights.mean.toFixed(1)} ${v.unit}</strong> across ${dataset.length} countries.`);
  if (insights.bestCorr) parts.push(`It moves most closely with <strong class="text-brand-300">${insights.bestCorr.name}</strong> (r=${insights.bestCorr.r.toFixed(2)}).`);
  if (insights.worstCorr) parts.push(`It moves opposite to <strong class="text-rose-300">${insights.worstCorr.name}</strong> (r=${insights.worstCorr.r.toFixed(2)}).`);
  if (insights.outliers.length) parts.push(`<strong class="text-amber-300">${insights.outliers.length} countries</strong> deviate significantly from the norm.`);
  text.innerHTML = parts.join(' ');
  panel.classList.remove('hidden');
}

function setPeerMode(mode) {
  peerMode = mode;
  document.getElementById('peerGlobal').classList.toggle('active', mode === 'global');
  document.getElementById('peerRegional').classList.toggle('active', mode === 'regional');
  if (selectedVar) showVariableDetails(selectedVar);
}

// === STATUS ===
function showStatus(text, pct) {
  const bar = document.getElementById('statusBar');
  const txt = document.getElementById('statusText');
  const prog = document.getElementById('statusProgress');
  const killBtn = document.getElementById('statusKillBtn');
  const meta = document.getElementById('statusMeta');
  if (!bar || !txt || !prog) return;
  bar.classList.add('visible');
  txt.textContent = text;
  prog.style.width = pct + '%';
  if (pct >= 100) { setTimeout(() => bar.classList.remove('visible'), 1200); }
  if (killBtn) { killBtn.classList.toggle('hidden', pct <= 0 || pct >= 100); }
  if (meta) { meta.classList.add('hidden'); }
}

// === INIT ===
async function loadDefaultDataset() {
  if (typeof DATASET !== 'undefined' && DATASET.length) return;
  try {
    showStatus('Fetching data...', 30);
    const resp = await fetch('/static/dataset_embed.js');
    if (!resp.ok) throw new Error('Dataset not found');
    const text = await resp.text();
    eval(text);
    showStatus('Processing data...', 70);
  } catch (e) {
    console.error('Failed to load dataset:', e);
    showStatus('Failed to load data', 100);
  }
}

// === COMPARE ===
function initCompareUI() {
  const sel = document.getElementById('compareSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">+ Add country...</option>' + dataset.map(d => `<option value="${d.country}">${d.country}</option>`).join('');
}

function addCompareCountry(country) {
  if (!country || compareCountries.includes(country)) return;
  compareCountries.push(country);
  renderCompareTags();
  renderCompareResults();
}

function removeCompareCountry(country) {
  compareCountries = compareCountries.filter(c => c !== country);
  renderCompareTags();
  renderCompareResults();
}

function renderCompareTags() {
  const tags = document.getElementById('compareTags');
  if (!tags) return;
  tags.innerHTML = compareCountries.map(c => `
    <span class="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-brand-500/10 text-brand-300 text-xs border border-brand-500/20">
      ${c}
      <button onclick="removeCompareCountry('${c}')" class="hover:text-white"><i data-lucide="x" class="w-3 h-3"></i></button>
    </span>
  `).join('');
  lucide.createIcons();
}

function renderCompareResults() {
  const results = document.getElementById('compareResults');
  const empty = document.getElementById('compareEmpty');
  if (!results || !empty) return;
  if (compareCountries.length < 2) { results.classList.add('hidden'); empty.classList.remove('hidden'); return; }
  results.classList.remove('hidden'); empty.classList.add('hidden');
  const countries = dataset.filter(d => compareCountries.includes(d.country));
  renderCompareRadar(countries);
  renderCompareTable(countries);
  renderCompareHeatmap(countries);
}

function renderCompareRadar(countries) {
  if (charts.compareRadar) charts.compareRadar.destroy();
  const el = document.getElementById('compareRadarCanvas'); if (!el) return;
  const keys = variableDefs.slice(0, 8).map(v => v.key);
  const colors = ['rgba(34,211,238,0.5)', 'rgba(244,63,94,0.5)', 'rgba(34,197,94,0.5)', 'rgba(168,85,247,0.5)'];
  charts.compareRadar = new Chart(el, {
    type: 'radar', data: { labels: variableDefs.slice(0, 8).map(v => v.name), datasets: countries.map((c, i) => ({ label: c.country, data: keys.map(k => { const v = parseFloat(c[k]); return isNaN(v) ? 0 : v; }), backgroundColor: colors[i % colors.length], borderColor: colors[i % colors.length].replace('0.5', '1'), borderWidth: 1 })) },
    options: { responsive: true, maintainAspectRatio: false, scales: { r: { grid: { color: 'rgba(148,163,184,0.1)' }, pointLabels: { color: '#94a3b8', font: { size: 10 } }, ticks: { color: '#64748b', backdropColor: 'transparent' } } } }
  });
}

function renderCompareTable(countries) {
  const table = document.getElementById('compareTable');
  if (!table) return;
  table.innerHTML = `<table class="text-xs w-full"><thead><tr class="text-slate-400"><th class="text-left p-2">Variable</th>${countries.map(c => `<th class="text-right p-2">${c.country}</th>`).join('')}</tr></thead><tbody>${variableDefs.slice(0, 10).map(v => `<tr class="border-t border-slate-700/30"><td class="p-2 text-white">${v.name}</td>${countries.map(c => `<td class="text-right p-2 text-slate-300">${(parseFloat(c[v.key]) || 0).toFixed(1)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function renderCompareHeatmap(countries) {
  const canvas = document.getElementById('compareHeatmapCanvas'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const n = countries.length, m = Math.min(variableDefs.length, 12);
  const size = 36, padding = 140;
  canvas.width = n * size + padding; canvas.height = m * size + padding;
  if (canvas.width === 0 || canvas.height === 0) return;
  ctx.fillStyle = '#0a0e1a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '10px Inter'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i < m; i++) {
    ctx.fillStyle = '#94a3b8'; ctx.fillText(variableDefs[i].name.slice(0, 20), padding - 8, padding + i * size + size / 2);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  for (let j = 0; j < n; j++) {
    ctx.save(); ctx.translate(padding + j * size + size / 2, padding - 8); ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = '#94a3b8'; ctx.fillText(countries[j].country.slice(0, 15), 0, 0); ctx.restore();
  }
  const allValues = variableDefs.slice(0, m).map(v => vals(v.key));
  for (let i = 0; i < m; i++) {
    const values = allValues[i];
    const min = Math.min(...values), max = Math.max(...values);
    for (let j = 0; j < n; j++) {
      const val = parseFloat(countries[j][variableDefs[i].key]);
      const norm = max > min ? (val - min) / (max - min) : 0.5;
      const h = 180 + norm * 60; const s = 20 + norm * 60; const l = 15 + norm * 25;
      ctx.fillStyle = `hsl(${h},${s}%,${l}%)`;
      ctx.fillRect(padding + j * size, padding + i * size, size - 1, size - 1);
    }
  }
}

// === OUTLIERS ===
function initOutliers() {
  const list = document.getElementById('outlierList');
  if (!list) return;
  const allOutliers = [];
  variableDefs.forEach(v => {
    const outliers = detectOutliers(v.key);
    outliers.forEach(o => allOutliers.push({ ...o, varName: v.name, varKey: v.key }));
  });
  const top = allOutliers.sort((a, b) => Math.abs(b.zscore) - Math.abs(a.zscore)).slice(0, 20);
  list.innerHTML = top.map(o => `
    <div class="glass-light p-4 rounded-xl border-l-2 ${o.zscore > 0 ? 'border-brand-500' : 'border-rose-500'}">
      <div class="flex items-center justify-between mb-1">
        <span class="text-xs font-semibold text-white">${o.country}</span>
        <span class="text-xs font-mono ${o.zscore > 0 ? 'text-brand-300' : 'text-rose-300'}">z=${o.zscore.toFixed(2)}</span>
      </div>
      <div class="text-sm text-slate-300">${o.varName}: ${o.value.toFixed(1)}</div>
      <button onclick="selectVariable('${o.varKey}')" class="mt-2 text-[0.65rem] text-brand-400 hover:text-brand-300">Explore variable</button>
    </div>
  `).join('');
}

// === BENCHMARK ===
function initBenchmark() {
  const inputs = document.getElementById('benchmarkInputs');
  const sel = document.getElementById('benchmarkCountrySelect');
  if (!inputs) return;
  inputs.innerHTML = variableDefs.slice(0, 8).map(v => `
    <div>
      <label class="block text-[0.65rem] text-slate-400 mb-1">${v.name}</label>
      <input type="number" id="bench-${v.key}" class="w-full px-3 py-2 rounded-lg bg-slate-800/50 border border-slate-700/50 text-sm text-white focus:outline-none focus:border-brand-500/50" placeholder="0-100">
    </div>
  `).join('');
  if (sel) {
    sel.innerHTML = '<option value="">-- Pick a country proxy --</option>' + dataset.map(d => `<option value="${d.country}">${d.country}</option>`).join('');
  }
}

function fillBenchmarkFromCountry() {
  const sel = document.getElementById('benchmarkCountrySelect');
  if (!sel) return;
  const country = dataset.find(d => d.country === sel.value);
  if (!country) return;
  variableDefs.slice(0, 8).forEach(v => {
    const input = document.getElementById(`bench-${v.key}`);
    if (input) input.value = parseFloat(country[v.key]) || 0;
  });
}

function calculateBenchmark() {
  const values = variableDefs.slice(0, 8).map(v => {
    const input = document.getElementById(`bench-${v.key}`);
    return { key: v.key, value: parseFloat(input?.value) || 0 };
  });
  const results = document.getElementById('benchmarkResults');
  if (!results) return;
  results.classList.remove('hidden');
  const percentiles = values.map(v => {
    const all = vals(v.key);
    return { key: v.key, percentile: M.percentile(all, v.value) };
  });
  const bars = document.getElementById('percentileBars');
  if (bars) {
    bars.innerHTML = percentiles.map(p => {
      const v = variableDefs.find(d => d.key === p.key);
      return `
        <div>
          <div class="flex justify-between text-xs mb-1"><span class="text-slate-300">${v.name}</span><span class="text-brand-300 font-mono">${p.percentile.toFixed(0)}th</span></div>
          <div class="h-2 bg-slate-800 rounded-full overflow-hidden"><div class="h-full bg-brand-500 rounded-full" style="width:${p.percentile}%"></div></div>
        </div>
      `;
    }).join('');
  }
  const closest = dataset.map(d => {
    const diff = values.reduce((sum, v) => {
      const actual = parseFloat(d[v.key]) || 0;
      return sum + Math.abs(actual - v.value);
    }, 0);
    return { country: d.country, diff };
  }).sort((a, b) => a.diff - b.diff)[0];
  const cm = document.getElementById('closestMatch');
  if (cm) {
    cm.innerHTML = `<div class="flex items-center gap-4"><div class="w-12 h-12 rounded-xl bg-brand-500/20 flex items-center justify-center"><i data-lucide="map-pin" class="w-6 h-6 text-brand-400"></i></div><div><div class="text-sm text-slate-500">Your profile most closely matches</div><div class="text-lg font-bold text-white">${closest ? closest.country : 'N/A'}</div></div></div>`;
    lucide.createIcons();
  }
}

// === GEM DISCOVERY ===
function findHiddenGems() {
  const gems = [];
  for (let i = 0; i < variableDefs.length; i++) {
    for (let j = i + 1; j < variableDefs.length; j++) {
      const v1 = variableDefs[i], v2 = variableDefs[j];
      if (v1.category === v2.category) continue;
      const r = M.pearson(vals(v1.key), vals(v2.key));
      if (Math.abs(r) > 0.5) {
        const surprise = Math.abs(r) * (v1.category !== v2.category ? 1.5 : 1);
        gems.push({ v1, v2, r, surprise, explanation: `${v1.name} and ${v2.name} are more linked than expected for ${v1.category} + ${v2.category}.` });
      }
    }
  }
  return gems.sort((a, b) => b.surprise - a.surprise);
}

function renderGemDiscovery() {
  const list = document.getElementById('gemList');
  if (!list) return;
  const gems = findHiddenGems();
  list.innerHTML = gems.slice(0, 15).map((g, i) => `
    <div class="gem-card fade-in" style="animation-delay:${i * 0.05}s">
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-lg bg-amber-500/15 flex items-center justify-center"><i data-lucide="sparkles" class="w-4 h-4 text-amber-400"></i></div>
          <div><div class="text-xs text-slate-500">Unexpected Connection</div><div class="text-sm font-semibold text-white">${g.v1.name} ↔ ${g.v2.name}</div></div>
        </div>
        <span class="text-xs font-mono ${g.r >= 0 ? 'text-brand-300' : 'text-rose-300'}">${g.r >= 0 ? '+' : ''}${g.r.toFixed(2)}</span>
      </div>
      <div class="flex flex-wrap gap-1.5 mb-3">
        <span class="text-[0.6rem] px-2 py-0.5 rounded-full bg-brand-500/15 text-brand-300">${g.v1.category}</span>
        <span class="text-[0.6rem] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300">${g.v2.category}</span>
        <span class="text-[0.6rem] px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300">${g.surprise.toFixed(1)}σ unexpected</span>
      </div>
      <p class="text-xs text-slate-400 leading-relaxed">${g.explanation}</p>
      <div class="flex gap-2 mt-3">
        <button onclick="selectVariable('${g.v1.key}')" class="text-[0.65rem] text-brand-400 hover:text-brand-300 transition-colors">Explore ${g.v1.name}</button>
        <span class="text-slate-600">·</span>
        <button onclick="selectVariable('${g.v2.key}')" class="text-[0.65rem] text-brand-400 hover:text-brand-300 transition-colors">Explore ${g.v2.name}</button>
      </div>
    </div>
  `).join('');
  lucide.createIcons();
}

// === DECISIONS (now called Rank) ===
function initDecisionFramework() {
  const sliders = document.getElementById('weightSliders');
  if (!sliders) return;
  sliders.innerHTML = variableDefs.map(v => `
    <div>
      <div class="flex justify-between mb-1"><span class="text-[0.65rem] text-slate-300">${v.name}</span><span class="text-[0.65rem] font-mono text-brand-300" id="wval-${v.key}">${weights[v.key] || 1}</span></div>
      <input type="range" min="0" max="5" step="0.5" value="${weights[v.key] || 1}" class="slider-track w-full" oninput="setWeight('${v.key}', this.value)">
    </div>
  `).join('');
  calculateDecisionScores();
}

function setWeight(key, val) {
  weights[key] = parseFloat(val);
  const label = document.getElementById(`wval-${key}`);
  if (label) label.textContent = val;
  calculateDecisionScores();
}

function resetWeights() {
  variableDefs.forEach(v => weights[v.key] = 1);
  initDecisionFramework();
}

function calculateDecisionScores() {
  const scores = dataset.map(d => {
    let score = 0, totalWeight = 0;
    variableDefs.forEach(v => {
      const val = parseFloat(d[v.key]);
      if (!isNaN(val)) {
        const w = weights[v.key] || 1;
        const normalized = (v.higherIsBetter !== false) ? val : -val;
        score += normalized * w;
        totalWeight += w;
      }
    });
    return { country: d.country, score: totalWeight ? score / totalWeight : 0 };
  }).sort((a, b) => b.score - a.score);
  renderDecisionResults(scores.slice(0, 10));
  renderRadar(scores.slice(0, 5));
}

function renderDecisionResults(top) {
  const el = document.getElementById('decisionResults');
  if (!el) return;
  el.innerHTML = top.map((s, i) => `
    <div class="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-800/30 transition-colors">
      <div class="w-6 h-6 rounded-full bg-brand-500/10 flex items-center justify-center text-[0.65rem] font-mono text-brand-300">${i + 1}</div>
      <div class="flex-1"><div class="text-xs text-white">${s.country}</div></div>
      <div class="text-xs font-mono text-brand-300">${s.score.toFixed(1)}</div>
    </div>
  `).join('');
}

function renderRadar(top) {
  if (charts.radar) charts.radar.destroy();
  const el = document.getElementById('radarChart'); if (!el) return;
  const keys = variableDefs.slice(0, 6).map(v => v.key);
  const colors = ['rgba(34,211,238,0.3)', 'rgba(244,63,94,0.3)', 'rgba(34,197,94,0.3)', 'rgba(168,85,247,0.3)', 'rgba(245,158,11,0.3)'];
  charts.radar = new Chart(el, {
    type: 'radar', data: { labels: variableDefs.slice(0, 6).map(v => v.name), datasets: top.map((s, i) => {
      const country = dataset.find(d => d.country === s.country);
      return { label: s.country, data: keys.map(k => parseFloat(country?.[k]) || 0), backgroundColor: colors[i % colors.length], borderColor: colors[i % colors.length].replace('0.3', '0.8'), borderWidth: 1 };
    }) },
    options: { responsive: true, maintainAspectRatio: false, scales: { r: { grid: { color: 'rgba(148,163,184,0.1)' }, pointLabels: { color: '#94a3b8', font: { size: 10 } }, ticks: { color: '#64748b', backdropColor: 'transparent' } } } }
  });
}

// === SIMULATOR (now called Scenario Builder) ===
function initSimulatorUI() {
  const sel = document.getElementById('simVariable');
  if (!sel) return;
  sel.innerHTML = variableDefs.map(v => `<option value="${v.key}">${v.name}</option>`).join('');
  initSimulator();
}

function initSimulator() {
  const sel = document.getElementById('simVariable');
  if (!sel) return;
  const key = sel.value;
  const v = variableDefs.find(x => x.key === key);
  if (!v) return;
  const values = vals(key);
  const mean = M.mean(values);
  document.getElementById('simLabel').textContent = v.name;
  document.getElementById('simSlider').value = 0;
  document.getElementById('simValue').textContent = '0% change (from ' + mean.toFixed(1) + ')';
  runSimulation(0);
}

function runSimulation(pctChange) {
  const sel = document.getElementById('simVariable');
  if (!sel) return;
  const key = sel.value;
  const v = variableDefs.find(x => x.key === key);
  if (!v) return;
  const values = vals(key);
  const mean = M.mean(values);
  const newValue = mean * (1 + pctChange / 100);
  document.getElementById('simValue').textContent = (pctChange >= 0 ? '+' : '') + pctChange + '% (' + newValue.toFixed(1) + ')';
  const corrs = getCorrelations(key);
  const affected = corrs.filter(c => Math.abs(c.r) >= 0.3).map(c => {
    const cValues = vals(c.key);
    const cMean = M.mean(cValues);
    const projectedChange = cMean * (c.r * pctChange / 100);
    return { ...c, projected: cMean + projectedChange, delta: projectedChange };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  document.getElementById('simAffectedCount').textContent = affected.length;
  const results = document.getElementById('simResults');
  if (results) {
    results.innerHTML = affected.slice(0, 15).map((a, idx) => {
      const deeperCorrs = getCorrelations(a.key).filter(c => Math.abs(c.r) >= 0.3 && c.key !== key).slice(0, 5);
      return `
      <div class="rounded-lg ${a.delta > 0 ? 'bg-emerald-500/8' : 'bg-rose-500/8'} overflow-hidden">
        <div class="flex items-center justify-between p-2 cursor-pointer" onclick="const el=document.getElementById('simDeep-${idx}');el.classList.toggle('hidden');const chev=document.getElementById('simChev-${idx}');if(chev)chev.style.transform=el.classList.contains('hidden')?'rotate(0deg)':'rotate(180deg)';">
          <div class="flex items-center gap-2"><i data-lucide="${a.icon}" class="w-3.5 h-3.5 text-slate-500"></i><span class="text-xs text-slate-300">${a.name}</span></div>
          <div class="flex items-center gap-1.5">
            <div class="text-xs font-mono ${a.delta > 0 ? 'text-emerald-300' : 'text-rose-300'}">${a.delta > 0 ? '+' : ''}${a.delta.toFixed(1)} (${(a.r * 100).toFixed(0)}%)</div>
            <i data-lucide="chevron-down" class="w-3 h-3 text-slate-500 transition-transform" style="transition-duration:0.2s" id="simChev-${idx}"></i>
          </div>
        </div>
        <div id="simDeep-${idx}" class="hidden px-2 pb-2 space-y-1">
          <div class="text-[0.6rem] text-slate-500 uppercase tracking-wider pl-2 pt-1">Chain of influence</div>
          ${deeperCorrs.map(dc => `
            <div class="flex items-center justify-between p-1.5 rounded bg-slate-800/50 ml-4">
              <div class="flex items-center gap-1.5"><i data-lucide="${dc.icon}" class="w-3 h-3 text-slate-500"></i><span class="text-[0.65rem] text-slate-300">${dc.name}</span></div>
              <span class="text-[0.65rem] font-mono ${dc.r >= 0 ? 'text-emerald-300/70' : 'text-rose-300/70'}">${dc.r >= 0 ? '+' : ''}${(dc.r * 100).toFixed(0)}% <span class="text-slate-600">via ${a.name}</span></span>
            </div>
          `).join('')}
          ${deeperCorrs.length === 0 ? '<div class="text-[0.65rem] text-slate-600 pl-2">No strong chain correlations found</div>' : ''}
        </div>
      </div>
    `;
    }).join('');
    lucide.createIcons();
  }
  renderSimChart(v, affected.slice(0, 10));
}

function renderSimChart(v, affected) {
  if (charts.simChart) charts.simChart.destroy();
  const el = document.getElementById('simChart');
  if (!el) return;
  charts.simChart = new Chart(el, {
    type: 'bar',
    data: {
      labels: affected.map(a => a.name.slice(0, 20)),
      datasets: [{
        label: 'Projected Change',
        data: affected.map(a => a.delta),
        backgroundColor: affected.map(a => a.delta >= 0 ? 'rgba(34,211,238,0.4)' : 'rgba(244,63,94,0.4)'),
        borderColor: affected.map(a => a.delta >= 0 ? 'rgba(34,211,238,0.7)' : 'rgba(244,63,94,0.7)'),
        borderWidth: 1,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: 'rgba(148,163,184,0.05)' }, ticks: { color: '#64748b', font: { size: 9 }, maxRotation: 45 } },
        y: { grid: { color: 'rgba(148,163,184,0.05)' }, ticks: { color: '#64748b', font: { size: 10 } } }
      }
    }
  });
}

// === CHATBOT ===
function openChatbot(context, detail) {
  const panel = document.getElementById('chatbotPanel');
  const backdrop = document.getElementById('chatbotBackdrop');
  if (!panel) return;
  panel.classList.remove('translate-x-full');
  if (backdrop) { backdrop.classList.remove('hidden'); setTimeout(() => backdrop.classList.remove('opacity-0'), 10); }
  const pill = document.getElementById('chatbotContextPill');
  const pillText = document.getElementById('chatbotContextText');
  if (pill && pillText && detail) {
    pill.classList.remove('hidden');
    pillText.textContent = `Looking at: ${detail}`;
  }
  if (context === 'general') {
    if (pill) pill.classList.add('hidden');
  }
}

function closeChatbot() {
  const panel = document.getElementById('chatbotPanel');
  const backdrop = document.getElementById('chatbotBackdrop');
  if (panel) panel.classList.add('translate-x-full');
  if (backdrop) { backdrop.classList.add('opacity-0'); setTimeout(() => backdrop.classList.add('hidden'), 300); }
}

function sendChatbotMessage(msg, auto = false) {
  const input = document.getElementById('chatbotInput');
  const messages = document.getElementById('chatbotMessages');
  if (!messages) return;
  const text = auto ? msg : (input?.value || '').trim();
  if (!text) return;
  if (!auto && input) input.value = '';
  appendChatMessage('user', text, false);
  setTimeout(() => {
    const response = getChatbotResponse(text);
    appendChatMessage('assistant', response, false);
  }, 400);
}

function appendChatMessage(role, text, isTyping) {
  const container = document.getElementById('chatbotMessages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'flex gap-3 fade-in';
  const isUser = role === 'user';
  const iconBg = isUser ? 'bg-slate-600' : 'bg-gradient-to-br from-brand-400 to-brand-600';
  const icon = isUser ? 'user' : 'sparkles';
  const textColor = isUser ? 'text-white' : 'text-slate-300';
  div.innerHTML = `
    <div class="w-7 h-7 rounded-lg ${iconBg} flex-shrink-0 flex items-center justify-center mt-0.5">
      <i data-lucide="${icon}" class="w-3.5 h-3.5 text-white"></i>
    </div>
    <div class="text-sm ${textColor} leading-relaxed flex-1">${text.replace(/\*\*(.+?)\*\*/g, '<strong class="text-brand-300">$1</strong>').replace(/\n/g, '<br>')}</div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  lucide.createIcons();
}

function getChatbotResponse(msg) {
  msg = msg.toLowerCase();
  const varName = selectedVar ? variableDefs.find(v => v.key === selectedVar)?.name : 'this variable';

  if (msg.includes('mapping') || msg.includes('concept map') || msg.includes('diagram') || msg.includes('connect card')) {
    return `**The Mapping tab** is a freeform canvas for exploring relationships between ideas, variables, and countries.

* **Add cards** to the canvas with the + button. Each card has a note you can edit inline.
* **Drag cards** anywhere on the canvas to organize your thinking.
* **Connect cards** by clicking "connect" on one card, then clicking the target card. A dashed arrow appears showing the relationship.
* **Use it for:** tracing cause-and-effect chains, building research hypotheses, mapping policy pathways, or documenting your own analytical narrative.

The canvas persists in your browser via localStorage, so your maps survive reloads. Cards automatically pick up the color of the currently selected variable's category, helping you visually group related concepts.`;
  }

  if (msg.includes('distribution') || msg.includes('histogram') || msg.includes('chart')) {
    return `**The Distribution Chart** shows how ${varName} is spread across all countries.

* **Each bar** represents a range of values (a "bin"). The height shows how many countries fall in that range.
* **A tall bar in the middle** means most countries cluster around an average value.
* **Spread-out bars** mean high variation — some countries score much higher or lower than others.
* **A lopsided shape** (more bars on one side) means most countries are similar, but a few are extreme.

**How it's built:** The app divides the full range of ${varName} into 15 equal buckets and counts how many countries land in each one. Simple, but powerful for spotting where a country sits relative to the pack.`;
  }

  if (msg.includes('network') || msg.includes('diagram') || msg.includes('node') || msg.includes('connection')) {
    return `**The Network Diagram** is a visual map of how ${varName} connects to other variables.

* **The big center node** is ${varName} itself.
* **Smaller orbiting nodes** are the top 8 variables most correlated with it.
* **Blue lines** mean positive correlation: when one goes up, so does the other.
* **Red lines** mean negative correlation: when one goes up, the other tends to go down.
* **Line thickness** shows strength — thicker = more tightly linked.

**How to read it:** Look for clusters. If many nodes orbit closely, ${varName} is a "hub" variable that connects a whole system. Sparse orbits mean it acts more independently.`;
  }

  if (msg.includes('correlation') || msg.includes('r value') || msg.includes('related')) {
    return `**Correlation** tells you how strongly two variables move together — but crucially, it does **not** prove one causes the other.

* **r = +1** — Perfect positive. When A goes up, B always goes up.
* **r = -1** — Perfect negative. When A goes up, B always goes down.
* **r = 0** — No linear relationship. They move independently.

**Rule of thumb for the strength you see here:**

* **0.0 to 0.3** — Weak. Might be noise, might be real but small.
* **0.3 to 0.5** — Moderate. There's probably something there worth investigating.
* **0.5 to 0.7** — Strong. There's a real pattern here.
* **0.7 to 1.0** — Very strong. These variables are deeply connected.

**Important caveat:** Correlation does **not** mean causation. Just because ice cream sales and drowning incidents correlate doesn't mean ice cream causes drowning. Both just rise in summer. The app shows *that* things are related — figuring out *why* requires deeper investigation.`;
  }

  if (msg.includes('scatter') || msg.includes('explore') || msg.includes('plot') || msg.includes('point')) {
    const scatterVar = document.getElementById('scatterVarSelect');
    const scatterName = scatterVar ? scatterVar.options[scatterVar.selectedIndex]?.text || 'another variable' : 'another variable';
    return `**The Scatter Plot** compares ${varName} against ${scatterName} — one dot per country.

* **Each dot** is one country. Its horizontal position is its ${varName} score; its vertical position is its ${scatterName} score.
* **The trend line** (a straight gray line through the cloud) shows the general direction. Sloping up = positive relationship. Sloping down = negative. Flat = no relationship.
* **Dots far from the line** are outliers — countries that break the pattern. Hovering (or selecting) them lets you investigate why.

**How it's built:** The app uses simple linear regression (the least-squares method) to find the "best fit" line through all the points. The equation of that line is printed at the top of the chart. The closer the dots hug the line, the stronger the relationship.`;
  }

  if (msg.includes('heatmap') || msg.includes('color grid') || msg.includes('matrix')) {
    return `**The Heatmap** is a color-coded "correlation matrix" — a bird's-eye view of how *every* variable relates to *every other* variable.

* **Each cell** is one pair of variables. The color shows the strength and direction of their correlation.
* **Bright cyan** = strong positive. **Reddish** = strong negative. **Dark / muted** = weak or no correlation.
* **The diagonal** is always bright — a variable perfectly correlates with itself.
* **Symmetry** — the matrix is mirrored across the diagonal. The top-right half is the same as the bottom-left.

**How to use it:** Look for bright off-diagonal blocks. Those are "families" of variables that move together. Dark rows or columns mean a variable is relatively independent — it doesn't strongly correlate with much else, which can make it interesting for unique insights.`;
  }

  if (msg.includes('rank') || msg.includes('decision') || msg.includes('framework') || msg.includes('score') || msg.includes('priority')) {
    return `**The Rank tab** helps you weigh multiple variables into a single "goodness" score for each country.

* **Priority sliders** let you decide which variables matter most to *your* question. Health more important than GDP? Slide it up.
* **Higher-is-better** is assumed by default, but some variables (like pollution) flip automatically.
* **The ranked list** updates in real time as you drag sliders. Top countries are the best fit for your weighted priorities.
* **The radar chart** shows how the top 5 countries score across the first 6 variables — a visual fingerprint.

**Use it when:** You need to answer "Which country is best for...?" or "Where should I focus investment?" rather than just exploring one variable at a time.`;
  }

  if (msg.includes('recommendation') || msg.includes('top') || msg.includes('score') || msg.includes('rank') || msg.includes('decision-result')) {
    return `**Top Recommendations** in the Rank tab are the countries that score highest against your weighted priorities.

* **The score** is a weighted average. Each variable is multiplied by its slider weight, then summed and normalized.
* **Higher score = better fit** for what you said matters.
* **Ties and near-ties** are common when weights are balanced — small slider changes can reshuffle the top few.
* **The radar chart** below the list shows *why* each top country scored well — which dimensions it excels in.

**Pro tip:** If one variable dominates the ranking, try lowering its weight to surface countries that are well-rounded rather than extreme on one dimension.`;
  }

  if (msg.includes('simulator') || msg.includes('what if') || msg.includes('scenario')) {
    return `**The Scenario Builder** lets you play "what if" with the data.

* **Pick any variable** as your "lever" — e.g., GDP per capita.
* **Slide the percentage** up or down to simulate a change.
* **The Projected Impact chart** shows which other variables would likely shift based on their historical correlations.
* **Each affected indicator** has a dropdown showing deeper "chain of influence" correlations — which variables are further downstream from this change.

**How it works:** The app uses the correlation coefficient (r) between the lever variable and each other variable. If you move the lever by +10%, and the correlation is 0.5, the app projects the other variable to shift by +5% (10% × 0.5). This is a **simplified projection** — it assumes linearity and doesn't account for external shocks, policy changes, or time lags. Use it for directional thinking, not precise forecasting.

**The chain of influence dropdowns** help you trace how a change ripples through the system. A strong GDP → Education correlation, and a strong Education → Innovation correlation, suggests GDP growth might eventually boost innovation — but always verify with deeper research before acting on correlation-based chains.`;
  }

  if (msg.includes('outlier') || msg.includes('anomaly') || msg.includes('strange')) {
    return `**Outliers** are countries that deviate dramatically from the norm for a given variable.

* **Z-score** measures how many standard deviations a country is from the mean. We flag anything beyond |2.0|.
* **High z-score** = unusually high. **Low z-score** = unusually low.
* **Outliers are clues, not errors.** A country with extremely high press freedom but low GDP might have an unusual history. A country with high literacy but low innovation might reveal a policy gap.

**How it's built:** For each variable, the app calculates the mean and standard deviation across all countries. Then it checks each country's value: (value − mean) ÷ standard deviation. Anything with an absolute z-score ≥ 2.0 appears in the Outliers tab.`;
  }

  if (msg.includes('discover') || msg.includes('gem') || msg.includes('hidden') || msg.includes('surprising')) {
    return `**Hidden Gem Discovery** surfaces the most unexpected correlations in the dataset.

* **Cross-domain links** are the focus — connections between variables from completely different categories (e.g., Environment + Economy).
* **"σ unexpected"** measures how surprising a link is. Higher = more counter-intuitive.
* **These are starting points for research.** A strong unexpected correlation is a signal that there might be an underlying mechanism worth investigating.

**How it's built:** The app calculates correlations between all variable pairs, then weights cross-category pairs more heavily. The top 15 by "surprise score" are shown.`;
  }

  if (msg.includes('data source') || msg.includes('method') || msg.includes('how') || msg.includes('calculated') || msg.includes('algorithm')) {
    return `Most of the heavy lifting in this app is done with classic, well-understood statistical methods:

* **Pearson correlation** — measures linear relationships. It's the standard "r" value you see in the correlations section.
* **Z-scores** — for outlier detection. (value − mean) ÷ standard deviation.
* **Percentiles** — rank-based positioning. Simple sorting and division.
* **Linear regression** — the trend line in scatter plots. Least-squares fitting.
* **Normalization** — scaling everything to 0–100 so different units can be compared in radar charts and the Rank tab.

Nothing here is exotic or opaque. The goal is transparency: you should be able to understand *how* every number was produced, not just trust a black box. That's why every chart has an **Explain** button.`;
  }

  // Fallback
  return `Great question! Let me break that down for you.

The Insight Engine analyzes ${varName} and ${dataset.length ? dataset.length + ' data points' : 'the loaded dataset'} to find patterns, relationships, and outliers. Every chart and number is built from straightforward statistics — correlations, distributions, rankings — and designed to be readable without a PhD.

If you're looking at something specific, just tell me the name of the chart or section (like "Network Diagram" or "Correlations"), and I'll walk you through exactly what it means, how to read it, and how it was constructed.

You can also click the **Explain** button next to any chart for instant context.`;
}

const chartLabels = {
    'mapping': 'the Mapping canvas',
    'distribution': 'the Distribution chart',
    'network': 'the Network Diagram',
    'correlations': 'the Correlations section',
    'scatter': 'the Scatter Plot',
    'heatmap': 'the Heatmap',
    'decisions': 'the Rank tab',
    'weight-sliders': 'the Priority Sliders',
    'decision-results': 'the Top Recommendations',
    'simulator': 'the Scenario Builder',
    'radar': 'the Radar chart',
    'outliers': 'the Outliers tab',
    'discover': 'the Hidden Gem Discovery',
    'compare': 'the Country Comparison',
    'benchmark': 'the Profile tab'
  };

function openChatbotFor(chartName) {
  const selected = selectedVar ? variableDefs.find(v => v.key === selectedVar)?.name : 'this dataset';
  const msg = `I'm looking at ${chartLabels[chartName] || 'this chart'} for ${selected}. Can you explain in detail how to read this visual, what it means, and how it was made?`;
  openChatbot('chart', chartLabels[chartName]);
  sendChatbotMessage(msg, true);
}

// === DATASET BROWSER ===
const DATASET_CATALOG = {
  builtin: [
    { id: 'happiness_2023', name: 'World Happiness Report 2023', source: 'UN SDSN', category: 'Wellbeing', description: 'Life satisfaction, GDP per capita, social support, healthy life expectancy, freedom, generosity, corruption perception', indicators: 7, icon: 'smile', color: 'amber' },
    { id: 'hdi_2022', name: 'Human Development Index', source: 'UNDP', category: 'Development', description: 'Life expectancy, expected years of schooling, mean years of schooling, GNI per capita, HDI value', indicators: 5, icon: 'heart-pulse', color: 'blue' },
    { id: 'epi_2022', name: 'Environmental Performance Index', source: 'Yale', category: 'Environment', description: 'Climate change mitigation, air quality, water sanitation, biodiversity, agriculture, fisheries', indicators: 12, icon: 'leaf', color: 'green' },
    { id: 'peace_2023', name: 'Global Peace Index', source: 'IEP', category: 'Security', description: 'Ongoing conflict, safety and security, militarization, political instability, terrorism impact', indicators: 9, icon: 'shield', color: 'indigo' },
    { id: 'press_2023', name: 'Press Freedom Index', source: 'RSF', category: 'Governance', description: 'Media independence, transparency, pluralism, abuses, infrastructure', indicators: 5, icon: 'radio', color: 'cyan' },
    { id: 'corruption_2023', name: 'Corruption Perceptions Index', source: 'Transparency Int.', category: 'Governance', description: 'Perceived levels of public sector corruption across 180 countries', indicators: 1, icon: 'scale', color: 'slate' },
    { id: 'innovation_2023', name: 'Global Innovation Index', source: 'WIPO', category: 'Innovation', description: 'Institutions, human capital, infrastructure, market sophistication, business sophistication, outputs', indicators: 8, icon: 'lightbulb', color: 'yellow' },
    { id: 'digital_2023', name: 'Digital Competitiveness', source: 'IMD', category: 'Technology', description: 'Knowledge, technology, future readiness, e-government, cybersecurity', indicators: 6, icon: 'cpu', color: 'teal' },
    { id: 'labor_2023', name: 'Labor Rights Index', source: 'ITUC', category: 'Labor', description: 'Union rights, collective bargaining, strikes, child labor, forced labor, discrimination', indicators: 5, icon: 'users', color: 'orange' },
    { id: 'food_2023', name: 'Food Security Index', source: 'EIU', category: 'Food', description: 'Affordability, availability, quality and safety, natural resources and resilience', indicators: 6, icon: 'utensils', color: 'emerald' },
    { id: 'cyber_2023', name: 'Cybersecurity Index', source: 'ITU', category: 'Technology', description: 'Legal measures, technical measures, organizational measures, capacity development, cooperation', indicators: 5, icon: 'shield-check', color: 'sky' },
    { id: 'inequality_2023', name: 'Income Inequality (Gini)', source: 'World Bank', category: 'Social', description: 'Gini coefficient, poverty rates, income shares by quintile, Palma ratio', indicators: 4, icon: 'trending-down', color: 'rose' }
  ],
  wb_presets: [
    { id: 'wb:economy', name: 'Economy', description: 'GDP, growth, inflation, trade, debt, investment, unemployment', indicators: 25, icon: 'trending-up', color: 'emerald' },
    { id: 'wb:health', name: 'Health', description: 'Life expectancy, mortality, health spending, disease', indicators: 25, icon: 'heart-pulse', color: 'rose' },
    { id: 'wb:education', name: 'Education', description: 'Enrollment, literacy, years of schooling, spending', indicators: 20, icon: 'graduation-cap', color: 'blue' },
    { id: 'wb:environment', name: 'Environment', description: 'CO2, renewables, forest, water, emissions, biodiversity', indicators: 25, icon: 'trees', color: 'green' },
    { id: 'wb:social', name: 'Social & Demographics', description: 'Population, gender, inequality, migration', indicators: 20, icon: 'users', color: 'purple' },
    { id: 'wb:governance', name: 'Governance & Business', description: 'Business climate, taxes, legal, women participation', indicators: 20, icon: 'landmark', color: 'amber' },
    { id: 'wb:digital', name: 'Digital & Infrastructure', description: 'Internet, broadband, ICT, e-government', indicators: 15, icon: 'wifi', color: 'cyan' },
    { id: 'wb:tourism', name: 'Tourism', description: 'International arrivals, tourism receipts', indicators: 5, icon: 'plane', color: 'sky' },
    { id: 'wb:full', name: 'Full World Bank (120+)', description: 'Comprehensive set of all available indicators', indicators: 120, icon: 'database', color: 'slate' }
  ]
};

// === DATASET BROWSER ===
async function showDatasetBrowser() {
  let existing = document.getElementById('datasetBrowserModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'datasetBrowserModal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4';
  modal.onclick = e => { if (e.target === modal) modal.remove(); };

  const builtinCards = DATASET_CATALOG.builtin.map(ds => {
    const isActive = CURRENT_DATASET && CURRENT_DATASET.file === ds.id;
    return `
    <div class="glass-light rounded-xl p-4 cursor-pointer transition-all hover:bg-brand-500/10 hover:border-brand-500/30 border border-transparent ${isActive ? 'border-brand-500/40 bg-brand-500/5' : ''}" onclick="loadBuiltinDataset('${ds.id}');document.getElementById('datasetBrowserModal').remove()">
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-lg bg-${ds.color}-500/15 flex items-center justify-center"><i data-lucide="${ds.icon}" class="w-4 h-4 text-${ds.color}-400"></i></div>
          <div><div class="text-sm font-semibold text-white">${ds.name}</div><div class="text-[0.65rem] text-slate-400">${ds.source} · ${ds.category}</div></div>
        </div>
        ${isActive ? '<span class="text-[0.65rem] px-2 py-0.5 rounded-full bg-brand-500/20 text-brand-300">Active</span>' : ''}
      </div>
      <div class="text-xs text-slate-400">${ds.description}</div>
    </div>`;
  }).join('');

  const wbCards = DATASET_CATALOG.wb_presets.map(p => `
    <div class="glass-light rounded-xl p-4 cursor-pointer transition-all hover:bg-brand-500/10 hover:border-brand-500/30 border border-transparent" onclick="fetchWorldBankPreset('${p.id}');document.getElementById('datasetBrowserModal').remove()">
      <div class="flex items-center gap-2 mb-2">
        <div class="w-8 h-8 rounded-lg bg-${p.color}-500/15 flex items-center justify-center"><i data-lucide="${p.icon}" class="w-4 h-4 text-${p.color}-400"></i></div>
        <div><div class="text-sm font-semibold text-white">${p.name}</div><div class="text-[0.65rem] text-slate-400">${p.indicators} variables</div></div>
      </div>
      <div class="text-xs text-slate-400">${p.description}</div>
    </div>
  `).join('');

  modal.innerHTML = `
    <div class="glass rounded-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
      <div class="flex items-center justify-between p-5 border-b border-slate-700/50">
        <h3 class="text-lg font-bold text-white flex items-center gap-2"><i data-lucide="library" class="w-5 h-5 text-brand-400"></i>Data Library</h3>
        <button onclick="document.getElementById('datasetBrowserModal').remove()" class="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-slate-700/50"><i data-lucide="x" class="w-4 h-4 text-slate-400"></i></button>
      </div>
      <div class="flex border-b border-slate-700/50">
        <button id="libTab-curated" onclick="switchLibTab('curated')" class="lib-tab px-4 py-3 text-xs font-medium text-brand-300 border-b-2 border-brand-500 transition-colors">Curated Datasets</button>
        <button id="libTab-live" onclick="switchLibTab('live')" class="lib-tab px-4 py-3 text-xs font-medium text-slate-400 border-b-2 border-transparent hover:text-white transition-colors">Live APIs</button>
        <button id="libTab-upload" onclick="switchLibTab('upload')" class="lib-tab px-4 py-3 text-xs font-medium text-slate-400 border-b-2 border-transparent hover:text-white transition-colors">Upload</button>
      </div>
      <div class="overflow-auto p-5 flex-1">
        <div id="libPane-curated">
          <div class="mb-4">
            <div class="text-[0.65rem] text-slate-500 mb-2 uppercase tracking-wider font-medium">Built-in Reference Datasets</div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${builtinCards}</div>
          </div>
        </div>
        <div id="libPane-live" class="hidden">
          <div class="mb-4">
            <div class="text-[0.65rem] text-slate-500 mb-2 uppercase tracking-wider font-medium">World Bank Presets</div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${wbCards}</div>
          </div>
          <div class="mb-4">
            <div class="text-[0.65rem] text-slate-500 mb-2 uppercase tracking-wider font-medium">Other Live Sources</div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div class="glass-light rounded-xl p-4 cursor-pointer transition-all hover:bg-brand-500/10 hover:border-brand-500/30 border border-transparent" onclick="fetchClimateData();document.getElementById('datasetBrowserModal').remove()">
                <div class="flex items-center gap-2 mb-2">
                  <div class="w-8 h-8 rounded-lg bg-teal-500/15 flex items-center justify-center"><i data-lucide="cloud" class="w-4 h-4 text-teal-400"></i></div>
                  <div><div class="text-sm font-semibold text-white">Capital City Climate</div><div class="text-[0.65rem] text-slate-400">Open-Meteo · 195+ cities</div></div>
                </div>
                <div class="text-xs text-slate-400">Temperature and precipitation averages for capital cities worldwide</div>
              </div>
              <div class="glass-light rounded-xl p-4 cursor-pointer transition-all hover:bg-brand-500/10 hover:border-brand-500/30 border border-transparent" onclick="fetchCustomWBIndicators();document.getElementById('datasetBrowserModal').remove()">
                <div class="flex items-center gap-2 mb-2">
                  <div class="w-8 h-8 rounded-lg bg-slate-500/15 flex items-center justify-center"><i data-lucide="list-filter" class="w-4 h-4 text-slate-400"></i></div>
                  <div><div class="text-sm font-semibold text-white">Custom World Bank</div><div class="text-[0.65rem] text-slate-400">120+ indicators</div></div>
                </div>
                <div class="text-xs text-slate-400">Select individual indicators from the full World Bank catalog</div>
              </div>
            </div>
          </div>
        </div>
        <div id="libPane-upload" class="hidden">
          <div class="glass-light rounded-xl p-6 text-center">
            <div class="w-12 h-12 rounded-full bg-brand-500/15 flex items-center justify-center mx-auto mb-3"><i data-lucide="upload-cloud" class="w-6 h-6 text-brand-400"></i></div>
            <div class="text-sm font-semibold text-white mb-2">Upload Custom Dataset</div>
            <p class="text-xs text-slate-400 mb-4 max-w-sm mx-auto">Import a CSV or JSON file with country rows and indicator columns. The first column should be "country".</p>
            <label class="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-brand-600/80 text-sm text-white hover:bg-brand-500 cursor-pointer transition-colors">
              <i data-lucide="file-up" class="w-4 h-4"></i>Choose File
              <input type="file" accept=".json,.csv" class="hidden" onchange="handleFileUpload(event);document.getElementById('datasetBrowserModal').remove()">
            </label>
          </div>
        </div>
      </div>
      <div class="border-t border-slate-700/30 p-4 flex items-center justify-between">
        <div class="flex items-center gap-2 text-[0.65rem] text-slate-500">
          <i data-lucide="info" class="w-3 h-3"></i>
          <span>${DATASET_CATALOG.builtin.length + DATASET_CATALOG.wb_presets.length} sources available</span>
        </div>
        <button onclick="requestDatasetEmail()" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg glass-light text-[0.65rem] text-slate-400 hover:text-brand-300 hover:border-brand-500/20 border border-transparent transition-all">
          <i data-lucide="mail" class="w-3 h-3"></i>
          Request a dataset
        </button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  lucide.createIcons();
}

function switchLibTab(tab) {
  document.querySelectorAll('.lib-tab').forEach(t => { t.classList.remove('text-brand-300', 'border-brand-500'); t.classList.add('text-slate-400', 'border-transparent'); });
  document.getElementById('libTab-' + tab).classList.remove('text-slate-400', 'border-transparent');
  document.getElementById('libTab-' + tab).classList.add('text-brand-300', 'border-brand-500');
  ['curated', 'live', 'upload'].forEach(t => document.getElementById('libPane-' + t).classList.add('hidden'));
  document.getElementById('libPane-' + tab).classList.remove('hidden');
}

function requestDatasetEmail() {
  const body = `Hi Insight Engine team,

I'd like to request additional data for the Global Insight Engine.

Dataset name/topic:
(please describe what indicators or data you'd like to see)

Source preference:
(World Bank, UN, OECD, FAO, WHO, or other)

Time range:
(e.g., 2020–2024, historical, most recent)

Why this matters:
(optional — how would this data help your analysis?)

---
This request was generated from the Data Sources panel.
`;
  const subject = encodeURIComponent('Dataset Request: Global Insight Engine');
  const bodyEnc = encodeURIComponent(body);
  window.open(`mailto:samreedcole7@gmail.com?subject=${subject}&body=${bodyEnc}`, '_blank');
}

async function loadBuiltinDataset(id) {
  showStatus('Loading dataset...', 20);
  try {
    const data = await api(`/api/datasets/builtin/${id}`);
    if (!data || !data.length) throw new Error('Empty dataset');
    dataset = data;
    variableDefs = Object.keys(data[0]).filter(k => k !== 'country').map(k => ({
      key: k, name: k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      unit: 'units', category: 'Custom', desc: 'Built-in dataset', icon: 'circle',
      higherIsBetter: true
    }));
    categories = [...new Set(variableDefs.map(v => v.category))];
    variableDefs.forEach(v => weights[v.key] = 1);
    selectedVar = null;
    document.getElementById('emptyState').classList.remove('hidden');
    document.getElementById('resultsArea').classList.add('hidden');
    const vs = document.getElementById('varSearch');
    if (vs) vs.value = '';
    showStatus('Loaded ' + id, 100);
    renderCategoryGrid();
    renderVariableList();
    initDecisionFramework();
    initBenchmark();
    initSimulatorUI();
    initCompareUI();
    initMapping();
    lucide.createIcons();
    CURRENT_DATASET = { file: id };
    const dp2 = document.getElementById('dataPointCount');
    if (dp2) dp2.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 pulse-dot"></span><span>${variableDefs.length} variables</span>`;
    return true;
  } catch (e) {
    showStatus('Failed to load: ' + e.message, 100);
    return false;
  }
}

// === EXPORT ===
function exportInsights(format) {
  if (format === 'csv') {
    const headers = ['country', ...variableDefs.map(v => v.key)];
    const rows = dataset.map(d => headers.map(h => d[h] ?? '').join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'insight-engine-data.csv'; a.click();
    URL.revokeObjectURL(url);
  } else if (format === 'txt') {
    const lines = [`Global Insight Engine Report`, `Generated: ${new Date().toISOString()}`, `Dataset: ${currentDatasetId}`, ``, `Variables:`, ...variableDefs.map(v => `- ${v.name} (${v.category})`), ``, `Countries: ${dataset.length}`];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'insight-engine-report.txt'; a.click();
    URL.revokeObjectURL(url);
  } else if (format === 'png') {
    Object.entries(charts).forEach(([name, chart]) => {
      if (!chart) return;
      const url = chart.toBase64Image();
      const a = document.createElement('a');
      a.href = url; a.download = `chart-${name}.png`; a.click();
    });
  }
}

function shareSession() {
  const state = { tab: activeTab, var: selectedVar, cat: activeCategory, corr: corrFilter, peers: peerMode, compare: compareCountries };
  const json = btoa(JSON.stringify(state));
  const url = `${window.location.origin}${window.location.pathname}?state=${json}`;
  navigator.clipboard.writeText(url).then(() => alert('Share link copied to clipboard!'));
}

function restoreFromURL() {
  const params = new URLSearchParams(window.location.search);
  const state = params.get('state');
  if (state) {
    try {
      const parsed = JSON.parse(atob(state));
      if (parsed.tab) switchTab(parsed.tab);
      if (parsed.var) selectVariable(parsed.var);
      if (parsed.cat) setCategory(parsed.cat);
      if (parsed.corr) setCorrFilter(parsed.corr);
      if (parsed.peers) setPeerMode(parsed.peers);
      if (parsed.compare) { compareCountries = parsed.compare; renderCompareTags(); renderCompareResults(); }
    } catch (e) { console.error('Failed to restore state:', e); }
  }
}

// === MAPPING TAB ===
let mappingCards = JSON.parse(localStorage.getItem('gie-mapping-cards') || '[]');
let mappingConnections = JSON.parse(localStorage.getItem('gie-mapping-connections') || '[]');
let mappingDragging = null, mappingDragOffset = {x:0,y:0}, mappingLineMode = false, mappingLineFrom = null;

function initMapping() {
  const canvas = document.getElementById('mappingCanvas');
  if (!canvas) return;
  canvas.addEventListener('mousedown', onMappingMouseDown);
  canvas.addEventListener('mousemove', onMappingMouseMove);
  canvas.addEventListener('mouseup', onMappingMouseUp);
  canvas.addEventListener('click', e => {
    if (e.target === canvas) { mappingLineMode = false; mappingLineFrom = null; canvas.style.cursor = 'grab'; }
  });
  renderMappingCards();
  renderMappingLines();
}

function addMappingCard(x, y, text) {
  const id = 'card_' + Date.now() + '_' + Math.floor(Math.random()*1000);
  const canvas = document.getElementById('mappingCanvas');
  const rect = canvas ? canvas.getBoundingClientRect() : {width:800,height:400};
  mappingCards.push({
    id,
    x: (x != null) ? x : 40 + Math.random() * Math.max(100, rect.width - 180),
    y: (y != null) ? y : 40 + Math.random() * Math.max(100, rect.height - 120),
    text: text || 'New card',
    color: mappingColorFromVar()
  });
  saveMapping();
  renderMappingCards();
  renderMappingLines();
}

function mappingColorFromVar() {
  if (!selectedVar) return '#06b6d4';
  const v = variableDefs.find(d => d.key === selectedVar);
  const colorMap = {
    'Economy': '#22c55e', 'Health': '#f43f5e', 'Education': '#3b82f6',
    'Environment': '#10b981', 'Social': '#a855f7', 'Governance': '#f59e0b',
    'Digital': '#06b6d4', 'Tourism': '#0ea5e9', 'Security': '#6366f1',
    'Wellbeing': '#ec4899', 'Innovation': '#eab308', 'Labor': '#f97316',
    'Food': '#10b981', 'Technology': '#06b6d4', 'Development': '#3b82f6',
    'General': '#64748b', 'Climate': '#14b8a6', 'Infrastructure': '#0ea5e9'
  };
  return colorMap[v?.category || 'General'] || '#06b6d4';
}

function renderMappingCards() {
  const container = document.getElementById('mappingCardsContainer');
  if (!container) return;
  container.innerHTML = mappingCards.map(c => `
    <div id="${c.id}" class="absolute group" style="left:${c.x}px;top:${c.y}px;z-index:3;cursor:grab;"
      onmousedown="startMappingDrag(event,'${c.id}')">
      <div class="glass rounded-xl px-4 py-3 min-w-[140px] max-w-[260px] border-l-2" style="border-left-color:${c.color};">
        <div class="flex items-start justify-between gap-2 mb-1.5">
          <div class="flex-1">
            <div contenteditable="true" class="text-xs text-white outline-none leading-relaxed break-words min-h-[1rem]" onblur="updateMappingText('${c.id}',this.innerText)" onclick="event.stopPropagation()">${escapeHtml(c.text)}</div>
          </div>
          <button onclick="deleteMappingCard('${c.id}');event.stopPropagation();" class="opacity-0 group-hover:opacity-100 transition-opacity text-slate-500 hover:text-rose-400 flex-shrink-0"><i data-lucide="x" class="w-3 h-3"></i></button>
        </div>
        <div class="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onclick="startMappingLine('${c.id}');event.stopPropagation();" class="text-[0.6rem] text-brand-400 hover:text-brand-300 flex items-center gap-0.5">
            <i data-lucide="pen-tool" class="w-3 h-3"></i>connect
          </button>
        </div>
      </div>
    </div>
  `).join('');
  lucide.createIcons();
}

function escapeHtml(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function updateMappingText(id, text) {
  const c = mappingCards.find(x => x.id === id);
  if (c) { c.text = text; saveMapping(); }
}

function deleteMappingCard(id) {
  mappingCards = mappingCards.filter(c => c.id !== id);
  mappingConnections = mappingConnections.filter(c => c.from !== id && c.to !== id);
  saveMapping();
  renderMappingCards();
  renderMappingLines();
}

function startMappingDrag(e, id) {
  if (mappingLineMode) return;
  mappingDragging = id;
  const el = document.getElementById(id);
  if (el) { mappingDragOffset = { x: e.clientX - el.offsetLeft, y: e.clientY - el.offsetTop }; }
  e.preventDefault();
}

function onMappingMouseDown(e) {
  if (mappingDragging) return;
  const card = e.target.closest('#mappingCardsContainer [id^="card_"]');
  if (card && mappingLineMode) {
    const targetId = card.id;
    if (targetId && targetId !== mappingLineFrom) {
      const exists = mappingConnections.find(c => (c.from === mappingLineFrom && c.to === targetId));
      if (!exists) { mappingConnections.push({ from: mappingLineFrom, to: targetId }); saveMapping(); renderMappingLines(); }
    }
    mappingLineMode = false;
    mappingLineFrom = null;
    document.getElementById('mappingCanvas').style.cursor = 'grab';
    e.stopPropagation();
  }
}

function onMappingMouseMove(e) {
  if (!mappingDragging) return;
  const c = mappingCards.find(x => x.id === mappingDragging);
  if (!c) return;
  const canvas = document.getElementById('mappingCanvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  c.x = Math.max(0, Math.min(rect.width - 60, e.clientX - rect.left - (mappingDragOffset.x - rect.left)));
  c.y = Math.max(0, Math.min(rect.height - 40, e.clientY - rect.top - (mappingDragOffset.y - rect.top)));
  const el = document.getElementById(mappingDragging);
  if (el) { el.style.left = c.x + 'px'; el.style.top = c.y + 'px'; }
  renderMappingLines();
}

function onMappingMouseUp() {
  if (mappingDragging) saveMapping();
  mappingDragging = null;
}

function startMappingLine(fromId) {
  mappingLineMode = true;
  mappingLineFrom = fromId;
  const canvas = document.getElementById('mappingCanvas');
  if (canvas) canvas.style.cursor = 'crosshair';
  setTimeout(() => { if (mappingLineMode) { mappingLineMode = false; mappingLineFrom = null; if (canvas) canvas.style.cursor = 'grab'; } }, 8000);
}

function renderMappingLines() {
  const svg = document.getElementById('mappingLines');
  if (!svg) return;
  const canvas = document.getElementById('mappingCanvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  svg.setAttribute('width', rect.width);
  svg.setAttribute('height', rect.height);
  const cardEls = {};
  mappingCards.forEach(c => { const el = document.getElementById(c.id); if (el) cardEls[c.id] = el; });
  let paths = '';
  mappingConnections.forEach(conn => {
    const fromEl = cardEls[conn.from], toEl = cardEls[conn.to];
    if (!fromEl || !toEl) return;
    const fx = fromEl.offsetLeft + fromEl.offsetWidth / 2;
    const fy = fromEl.offsetTop + fromEl.offsetHeight / 2;
    const tx = toEl.offsetLeft + toEl.offsetWidth / 2;
    const ty = toEl.offsetTop + toEl.offsetHeight / 2;
    const dx = tx - fx, dy = ty - fy;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const offset = Math.min(40, dist * 0.3);
    paths += `<path d="M${fx},${fy} C${fx + offset},${fy} ${tx - offset},${ty} ${tx},${ty}" stroke="rgba(6,182,212,0.4)" stroke-width="1.5" fill="none" stroke-dasharray="4 3" marker-end="url(#arrowhead)" />`;
  });
  const arrowDef = `<defs><marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 L2,3 Z" fill="rgba(6,182,212,0.5)"/></marker></defs>`;
  svg.innerHTML = arrowDef + paths;
}

function clearMapping() {
  if (!confirm('Clear all cards and connections?')) return;
  mappingCards = [];
  mappingConnections = [];
  saveMapping();
  renderMappingCards();
  renderMappingLines();
}

function saveMapping() {
  localStorage.setItem('gie-mapping-cards', JSON.stringify(mappingCards));
  localStorage.setItem('gie-mapping-connections', JSON.stringify(mappingConnections));
}

// === CORE ===
async function init() {
  showStatus('Initializing...', 10);
  await loadDefaultDataset();
  dataset = DATASET;
  variableDefs = VARIABLE_DEFS;
  categories = [...new Set(variableDefs.map(v => v.category))];
  variableDefs.forEach(v => weights[v.key] = 1);
  showStatus('Processing...', 40);
  initTheme();
  initTabDragDrop();
  initTooltips();
  lucide.createIcons();
  initTabs();
  initExplorer();
  initDecisionFramework();
  initBenchmark();
  initSimulatorUI();
  initCompareUI();
  initMapping();
  restoreFromURL();
  showStatus('Ready', 100);
  const dp = document.getElementById('dataPointCount');
  if (dp) dp.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 pulse-dot"></span><span>${variableDefs.length} variables</span>`;
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  const tc = document.getElementById('tab-' + tab);
  if (tc) tc.classList.remove('hidden');
  if (tab === 'decisions') calculateDecisionScores();
  if (tab === 'discover') renderGemDiscovery();
  if (tab === 'outliers') initOutliers();
  if (tab === 'mapping') { setTimeout(() => { renderMappingCards(); renderMappingLines(); }, 50); }
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
}

function initExplorer() {
  renderCategoryGrid();
  renderVariableList();
}

// === LANDING ===
function dismissLanding(datasetId) {
  const overlay = document.getElementById('landingOverlay');
  if (overlay) {
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 500);
  }
  document.getElementById('mainApp').classList.remove('opacity-0');
  if (datasetId) loadBuiltinDataset(datasetId);
}

function dismissLandingAndOpenSources() {
  dismissLanding();
  setTimeout(() => showDatasetBrowser(), 300);
}

// === THEME SYSTEM ===
function initTheme() {
  const saved = localStorage.getItem('gie-theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = saved === 'dark' || (saved === null && prefersDark);
  applyTheme(isDark);
}

function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('light-mode');
  const newMode = document.documentElement.classList.contains('light-mode') ? 'light' : 'dark';
  localStorage.setItem('gie-theme', newMode);
  applyTheme(newMode === 'light');
}

function applyTheme(isLight) {
  const root = document.documentElement;
  if (isLight) {
    root.classList.add('light-mode');
    root.style.setProperty('--bg-primary', '#f8fafc');
    root.style.setProperty('--bg-secondary', '#f1f5f9');
    root.style.setProperty('--text-primary', '#0f172a');
    root.style.setProperty('--text-secondary', '#475569');
    root.style.setProperty('--glass-bg', 'rgba(241,245,249,0.75)');
    root.style.setProperty('--glass-border', 'rgba(148,163,184,0.15)');
  } else {
    root.classList.remove('light-mode');
    root.style.setProperty('--bg-primary', '#0a0e1a');
    root.style.setProperty('--bg-secondary', '#0f172a');
    root.style.setProperty('--text-primary', '#f8fafc');
    root.style.setProperty('--text-secondary', '#94a3b8');
    root.style.setProperty('--glass-bg', 'rgba(15,23,42,0.75)');
    root.style.setProperty('--glass-border', 'rgba(34,211,238,0.08)');
  }
  Object.values(charts).forEach(c => { if (c) c.update(); });
}

// === TOOLTIP SYSTEM ===
let _activeTooltip = null;

function initTooltips() {
  document.body.addEventListener('mousemove', (e) => {
    const el = e.target.closest('[data-tooltip]');
    if (el) {
      const text = el.getAttribute('data-tooltip');
      if (text) showTooltip(e.clientX, e.clientY, text, el);
    } else if (!e.target.closest('.gie-tooltip')) {
      hideTooltip();
    }
  });
  document.body.addEventListener('mouseleave', () => hideTooltip());
}

function showTooltip(x, y, text, sourceEl) {
  if (_activeTooltip && _activeTooltip._source === sourceEl) {
    _activeTooltip.style.left = (x + 14) + 'px';
    _activeTooltip.style.top = (y + 14) + 'px';
    return;
  }
  hideTooltip();
  const tt = document.createElement('div');
  tt.className = 'gie-tooltip';
  tt._source = sourceEl;
  tt.innerHTML = `<div class="text-xs text-white whitespace-nowrap leading-relaxed">${text}</div>`;
  tt.style.cssText = `
    position:fixed; z-index:9999; pointer-events:none;
    background:rgba(15,23,42,0.92); backdrop-filter:blur(8px);
    border:1px solid rgba(34,211,238,0.15); border-radius:8px;
    padding:6px 10px; box-shadow:0 4px 20px rgba(0,0,0,0.3);
    font-family:'Inter',sans-serif; opacity:0; transition:opacity 0.15s;
    max-width:280px; white-space:normal; line-height:1.4;
  `;
  document.body.appendChild(tt);
  requestAnimationFrame(() => {
    const rect = tt.getBoundingClientRect();
    let lx = x + 14, ly = y + 14;
    if (lx + rect.width > window.innerWidth - 8) lx = x - rect.width - 8;
    if (ly + rect.height > window.innerHeight - 8) ly = y - rect.height - 8;
    if (ly < 8) ly = 8;
    tt.style.left = lx + 'px';
    tt.style.top = ly + 'px';
    tt.style.opacity = '1';
  });
  _activeTooltip = tt;
}

function hideTooltip() {
  if (_activeTooltip) { _activeTooltip.style.opacity = '0'; setTimeout(() => _activeTooltip?.remove(), 150); _activeTooltip = null; }
}

// === DRAG-AND-DROP TAB REORDERING ===
function initTabDragDrop() {
  const container = document.getElementById('tabBar');
  if (!container) return;
  const saved = localStorage.getItem('gie-tab-order');
  if (saved) restoreTabOrder(JSON.parse(saved));

  container.addEventListener('dragstart', (e) => {
    const btn = e.target.closest('[draggable]');
    if (!btn) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', btn.dataset.tab);
    btn.classList.add('opacity-40', 'scale-95');
  });
  container.addEventListener('dragend', (e) => {
    const btn = e.target.closest('[draggable]');
    if (btn) btn.classList.remove('opacity-40', 'scale-95');
    saveTabOrder();
  });
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const after = getDragAfterElement(container, e.clientX);
    const dragging = container.querySelector('.opacity-40');
    if (!dragging) return;
    if (after == null) container.appendChild(dragging);
    else container.insertBefore(dragging, after);
  });
}

function getDragAfterElement(container, x) {
  const els = [...container.querySelectorAll('[draggable]:not(.opacity-40)')];
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = x - box.left - box.width / 2;
    if (offset < 0 && offset > closest.offset) return { offset, el: child };
    return closest;
  }, { offset: -Infinity }).el;
}

function saveTabOrder() {
  const container = document.getElementById('tabBar');
  if (!container) return;
  const order = [...container.querySelectorAll('[data-tab]')].map(b => b.dataset.tab);
  localStorage.setItem('gie-tab-order', JSON.stringify(order));
}

function restoreTabOrder(order) {
  const container = document.getElementById('tabBar');
  if (!container) return;
  const buttons = {};
  container.querySelectorAll('[data-tab]').forEach(b => { buttons[b.dataset.tab] = b; });
  order.forEach(tab => {
    if (buttons[tab]) container.appendChild(buttons[tab]);
  });
}

// === FILE UPLOAD ===
function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    if (file.name.endsWith('.json')) {
      try { const data = JSON.parse(text); loadCustomDataset(data); } catch (err) { alert('Invalid JSON file'); }
    } else if (file.name.endsWith('.csv')) {
      const data = parseCSV(text);
      loadCustomDataset(data);
    }
  };
  reader.readAsText(file);
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const obj = {};
    const values = line.split(',');
    headers.forEach((h, i) => {
      const val = values[i] ? values[i].trim().replace(/^"|"$/g, '') : '';
      obj[h] = isNaN(val) || val === '' ? val : parseFloat(val);
    });
    return obj;
  });
}

function loadCustomDataset(data) {
  if (!Array.isArray(data) || data.length === 0) return;
  DATASET.length = 0;
  data.forEach(d => DATASET.push(d));
  const keys = Object.keys(data[0]).filter(k => k !== 'country');
  VARIABLE_DEFS.length = 0;
  keys.forEach(k => {
    VARIABLE_DEFS.push({
      key: k,
      name: k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      unit: 'units',
      category: 'Custom',
      desc: 'User-uploaded',
      icon: 'circle',
      higherIsBetter: true
    });
  });
  init();
}

window.addEventListener('resize', () => { if (selectedVar) { const corrs = getCorrelations(selectedVar); const v = variableDefs.find(d => d.key === selectedVar); } });
document.addEventListener('DOMContentLoaded', init);