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
    const d = Math.sqrt(dx * dy); return d === 0 ? 0 : num / d;
  },
  normalize: (v, arr) => { const mn = Math.min(...arr), mx = Math.max(...arr); return mx === mn ? 0.5 : (v - mn) / (mx - mn); },
  percentile: (v, arr) => { let c = 0; for (let x of arr) if (x <= v) c++; return arr.length ? c / arr.length * 100 : 50; },
  zscore: (v, arr) => { const m = M.mean(arr), s = M.std(arr); return s === 0 ? 0 : (v - m) / s; }
};
function vals(key, data = dataset) { return data.map(d => d[key]).filter(v => v != null && !isNaN(v)); }
function getCorrelations(key, data = dataset) {
  return variableDefs.filter(v => v.key !== key && data.some(d => d[v.key] != null))
    .map(v => ({ ...v, r: M.pearson(vals(key, data), vals(v.key, data)) }))
    .filter(c => !isNaN(c.r)).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
}
function corrStrength(r) { const a = Math.abs(r); return a >= 0.9 ? 'Very Strong' : a >= 0.7 ? 'Strong' : a >= 0.5 ? 'Moderate' : a >= 0.3 ? 'Weak' : 'Negligible'; }
let _abortController = null;
let _tickerTimer = null;
let _statusStartTime = 0;

function showStatus(msg, pct) {
  const bar = document.getElementById('statusBar'); if (!bar) return;
  bar.classList.add('visible');
  const st = document.getElementById('statusText'); if (st) st.textContent = msg;
  const sp = document.getElementById('statusProgress'); if (sp) sp.style.width = pct + '%';
  const spt = document.getElementById('statusPercent'); if (spt) spt.textContent = pct + '%';
  // Live ticker
  const tickerWrap = document.getElementById('statusLiveTicker');
  if (tickerWrap) tickerWrap.classList.remove('hidden');
  // Kill button appears only on long / indeterminate loads
  const killBtn = document.getElementById('statusKillBtn');
  if (killBtn) {
    if (pct < 100 && pct > 0) killBtn.classList.remove('hidden');
    else killBtn.classList.add('hidden');
  }
  // Elapsed time meta
  const meta = document.getElementById('statusMeta');
  const stage = document.getElementById('statusStage');
  if (meta && pct > 0 && pct < 100) {
    meta.classList.remove('hidden');
    if (stage) stage.textContent = msg.toLowerCase().replace(/\.{3}$/, '').replace(/[^a-z0-9 ]/g, '').trim().split(' ').slice(0,3).join(' ');
  } else if (meta) {
    meta.classList.add('hidden');
  }
  if (pct >= 100) {
    clearInterval(_tickerTimer); _tickerTimer = null;
    setTimeout(() => { bar.classList.remove('visible'); if (killBtn) killBtn.classList.add('hidden'); if (tickerWrap) tickerWrap.classList.add('hidden'); }, 800);
  }
}

function killLoad() {
  if (_abortController) { _abortController.abort(); _abortController = null; }
  showStatus('Cancelled', 100);
}

const _tickerMessages = [
  'querying world bank api...',
  'normalizing country names...',
  'filtering aggregate regions...',
  'computing correlations...',
  'building distribution charts...',
  'mapping variable networks...',
  'detecting statistical outliers...',
  'preparing narrative insights...',
  'calculating percentiles...',
  'indexing peer groups...',
  'aggregating climate normals...',
  'resolving indicator metadata...',
];

function startLiveTicker(intervalMs = 2200) {
  clearInterval(_tickerTimer);
  _statusStartTime = performance.now();
  const tickerEl = document.getElementById('tickerText');
  const meta = document.getElementById('statusMeta');
  const stage = document.getElementById('statusStage');
  if (!tickerEl) return;
  let idx = 0;
  const render = () => {
    const elapsed = ((performance.now() - _statusStartTime) / 1000).toFixed(1);
    if (meta) meta.classList.remove('hidden');
    const msgs = [..._tickerMessages].sort(() => Math.random() - 0.5).slice(0, 4);
    const text = msgs.join('  ·  ') + '  ·  ' + msgs[0] + '  ·  ';
    tickerEl.textContent = text;
    tickerEl.className = 'inline-block ticker-scroll';
    if (stage) stage.textContent = msgs[0].replace(/\.{3}$/, '');
    idx = (idx + 1) % _tickerMessages.length;
  };
  render();
  _tickerTimer = setInterval(render, intervalMs);
}

// === DATASET LOADING ===
const DATASET_PACKS = [];

async function loadDefaultDataset() {
  showStatus('Loading dataset...', 5);
  _abortController = new AbortController();
  startLiveTicker();
  try {
    const result = await api('/api/datasets/builtin/hdi_2022', { signal: _abortController.signal });
    if (result && result.data && result.data.length > 0) {
      DATASET.length = 0; result.data.forEach(d => DATASET.push(d));
      VARIABLE_DEFS.length = 0; result.indicators.forEach(v => VARIABLE_DEFS.push(v));
      DATASET_PACKS.length = 0;
      DATASET_PACKS.push({ name: result.name, source: result.source, description: result.description, variableCount: VARIABLE_DEFS.length, lastUpdated: result.last_updated, requiresKey: false, dataset: DATASET, variables: VARIABLE_DEFS, loaded: true, file: 'builtin:hdi_2022' });
      CURRENT_DATASET = DATASET_PACKS[0];
      currentDatasetId = 'builtin:hdi_2022';
      showStatus('Loaded Human Development Index', 50);
      return;
    }
  } catch (e) { console.log('Backend builtin unavailable, trying WB live', e); }
  
  try {
    const defaults = 'gdp_per_capita,life_expectancy,population,electricity_access,internet_users,co2_per_capita,renewable_energy,gini,unemployment,health_exp_per_capita,infant_mortality,sanitation';
    const result = await api(`/api/worldbank/fetch?indicators=${defaults}&countries=all&date_range=2020:2023&latest_only=true`);
    if (result.data && result.data.length > 0) {
      DATASET.length = 0; result.data.forEach(d => DATASET.push(d));
      const keys = Object.keys(DATASET[0]).filter(x => x !== 'country');
      window.VARIABLE_DEFS = keys.map(x => ({
        key: x, name: x.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        unit: '', category: 'General', desc: 'World Bank indicator', icon: 'bar-chart-3', higherIsBetter: null
      }));
      DATASET_PACKS.length = 0;
      DATASET_PACKS.push({ name: 'World Bank Live', source: 'backend', description: 'Live World Bank indicators', variableCount: VARIABLE_DEFS.length, lastUpdated: '2024', requiresKey: false, dataset: DATASET, variables: VARIABLE_DEFS, loaded: true, file: 'backend' });
      CURRENT_DATASET = DATASET_PACKS[0];
      currentDatasetId = 'builtin:wb_live';
      showStatus('Live data loaded', 50);
      return;
    }
  } catch (e) { console.log('Backend unavailable, using embedded', e); }
  initDatasetSystem();
  showStatus('Embedded data loaded', 50);
}

function initDatasetSystem() {
  DATASET_PACKS.length = 0;
  if (typeof DATASET !== 'undefined' && DATASET.length > 0) {
    if (typeof VARIABLE_DEFS === 'undefined' || !VARIABLE_DEFS.length) {
      const k = Object.keys(DATASET[0]).filter(x => !['country', 'code', 'region', 'income'].includes(x));
      window.VARIABLE_DEFS = k.map(x => ({ key: x, name: x.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()), unit: '', category: 'General', desc: 'Indicator', icon: 'bar-chart-3', higherIsBetter: null }));
    }
    DATASET_PACKS.push({ name: 'World Bank Core', source: 'dataset_embed.js', description: 'Economic, health, and social indicators', variableCount: VARIABLE_DEFS.length, lastUpdated: '2024', requiresKey: false, dataset: DATASET, variables: VARIABLE_DEFS, loaded: true, file: 'dataset_embed.js' });
    CURRENT_DATASET = DATASET_PACKS[0];
  }
}

function switchToDataset(packName) {
  const pack = DATASET_PACKS.find(p => p.name === packName); if (!pack) return false;
  DATASET.length = 0; pack.dataset.forEach(d => DATASET.push(d));
  VARIABLE_DEFS.length = 0; pack.variables.forEach(v => VARIABLE_DEFS.push(v));
  dataset = DATASET; variableDefs = VARIABLE_DEFS;
  categories = [...new Set(variableDefs.map(v => v.category))];
  weights = {}; variableDefs.forEach(v => weights[v.key] = 1);
  selectedVar = null; corrFilter = 'all'; activeCategory = null;
  document.getElementById('emptyState').classList.remove('hidden');
  document.getElementById('resultsArea').classList.add('hidden');
  const vs = document.getElementById('varSearch'); if (vs) vs.value = '';
  showStatus('Loaded ' + pack.name, 100);
  renderCategoryGrid(); renderVariableList(); initDecisionFramework();
  initBenchmark(); initSimulatorUI(); initCompareUI();
  lucide.createIcons(); CURRENT_DATASET = pack;
  const dp2 = document.getElementById('dataPointCount');
  if (dp2) dp2.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 pulse-dot"></span><span>${variableDefs.length} variables</span>`;
  return true;
}

// === DATASET LIBRARY CATALOG ===
const DATASET_CATALOG = {
  builtin: [
    { id: 'happiness_2023', name: 'World Happiness Report 2023', category: 'Wellbeing', source: 'UN SDSN', description: 'Happiness, social support, freedom, generosity, corruption perceptions', icon: 'heart', color: 'rose' },
    { id: 'hdi_2022', name: 'Human Development Index 2021/2022', category: 'Development', source: 'UNDP', description: 'HDI, life expectancy, schooling, GNI per capita', icon: 'users', color: 'blue' },
    { id: 'epi_2022', name: 'Environmental Performance Index 2022', category: 'Environment', source: 'Yale/Columbia', description: 'Ecosystem vitality, environmental health, air quality, biodiversity', icon: 'leaf', color: 'green' },
    { id: 'peace_2023', name: 'Global Peace Index 2023', category: 'Security', source: 'IEP', description: 'Peace, safety, militarization, conflict, terrorism', icon: 'shield', color: 'indigo' },
    { id: 'press_freedom_2023', name: 'Press Freedom Index 2023', category: 'Governance', source: 'RSF', description: 'Press freedom, safety of journalists, media independence', icon: 'newspaper', color: 'amber' },
    { id: 'corruption_perceptions_2023', name: 'Corruption Perceptions Index 2023', category: 'Governance', source: 'Transparency Int.', description: 'Perceived public sector corruption, ranking', icon: 'scale', color: 'purple' },
    { id: 'labor_rights_2023', name: 'Global Rights Index 2023', category: 'Labor', source: 'ITUC', description: 'Workers rights, collective bargaining, trade unions', icon: 'briefcase', color: 'orange' },
    { id: 'cybersecurity_2023', name: 'Global Cybersecurity Index 2023', category: 'Technology', source: 'ITU', description: 'Cybersecurity readiness, legal, technical, cooperation', icon: 'lock', color: 'cyan' },
    { id: 'food_security_2023', name: 'Global Food Security Index 2022', category: 'Food', source: 'Economist Impact', description: 'Food affordability, availability, quality, sustainability', icon: 'utensils', color: 'emerald' },
    { id: 'innovation_2023', name: 'Global Innovation Index 2023', category: 'Innovation', source: 'WIPO', description: 'Innovation capacity, outputs, institutions, infrastructure', icon: 'lightbulb', color: 'yellow' },
    { id: 'digital_competitiveness_2023', name: 'IMD Digital Competitiveness 2023', category: 'Digital', source: 'IMD', description: 'Knowledge, technology, future readiness of digital economies', icon: 'cpu', color: 'sky' },
    { id: 'gini_ref_2022', name: 'Income Inequality Reference', category: 'Social', source: 'World Bank', description: 'Gini index, income shares, Palma ratio', icon: 'bar-chart-2', color: 'pink' },
  ],
  wb_presets: [
    { id: 'wb:economy', name: 'Economy', description: 'GDP, growth, debt, trade, FDI, industry', indicators: 25, icon: 'trending-up', color: 'emerald' },
    { id: 'wb:health', name: 'Health', description: 'Life expectancy, mortality, health spending, disease', indicators: 25, icon: 'heart-pulse', color: 'rose' },
    { id: 'wb:education', name: 'Education', description: 'Enrollment, literacy, years of schooling, spending', indicators: 20, icon: 'graduation-cap', color: 'blue' },
    { id: 'wb:environment', name: 'Environment', description: 'CO2, renewables, forest, water, emissions, biodiversity', indicators: 25, icon: 'trees', color: 'green' },
    { id: 'wb:social', name: 'Social & Demographics', description: 'Population, gender, inequality, migration', indicators: 20, icon: 'users', color: 'purple' },
    { id: 'wb:governance', name: 'Governance & Business', description: 'Business climate, taxes, legal, women participation', indicators: 20, icon: 'landmark', color: 'amber' },
    { id: 'wb:digital', name: 'Digital & Infrastructure', description: 'Internet, broadband, ICT, e-government', indicators: 15, icon: 'wifi', color: 'cyan' },
    { id: 'wb:tourism', name: 'Tourism', description: 'International arrivals, tourism receipts', indicators: 5, icon: 'plane', color: 'sky' },
    { id: 'wb:full', name: 'Full World Bank (120+)', description: 'Comprehensive set of all available indicators', indicators: 120, icon: 'database', color: 'slate' },
  ]
};

// === DATASET BROWSER ===
async function showDatasetBrowser() {
  let existing = document.getElementById('datasetBrowserModal'); if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'datasetBrowserModal'; modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4';
  modal.onclick = e => { if (e.target === modal) modal.remove(); };

  // Build tab content as strings first
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

  const categoryColors = {
    'Economy': 'emerald', 'Health': 'rose', 'Education': 'blue', 'Environment': 'green',
    'Social': 'purple', 'Governance': 'amber', 'Digital': 'cyan', 'Tourism': 'sky',
    'Security': 'indigo', 'Wellbeing': 'pink', 'Innovation': 'yellow', 'Labor': 'orange',
    'Food': 'emerald', 'Technology': 'cyan', 'Development': 'blue', 'General': 'slate',
    'Climate': 'teal', 'Infrastructure': 'sky'
  };

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
    </div>`;
  document.body.appendChild(modal); lucide.createIcons();
}

function switchLibTab(tab) {
  document.querySelectorAll('.lib-tab').forEach(t => { t.classList.remove('text-brand-300', 'border-brand-500'); t.classList.add('text-slate-400', 'border-transparent'); });
  document.getElementById('libTab-' + tab).classList.remove('text-slate-400', 'border-transparent');
  document.getElementById('libTab-' + tab).classList.add('text-brand-300', 'border-brand-500');
  ['curated','live','upload'].forEach(t => document.getElementById('libPane-' + t).classList.add('hidden'));
  document.getElementById('libPane-' + tab).classList.remove('hidden');
}

async function loadBuiltinDataset(datasetId) {
  showStatus('Loading ' + datasetId + '...', 5);
  _abortController = new AbortController();
  startLiveTicker();
  try {
    const result = await apiWithSignal('/api/datasets/builtin/' + datasetId);
    if (!result || !result.data || !result.data.length) { showStatus('No data returned', 100); return; }
    DATASET.length = 0; result.data.forEach(d => DATASET.push(d));
    VARIABLE_DEFS.length = 0; result.indicators.forEach(v => VARIABLE_DEFS.push(v));
    dataset = DATASET; variableDefs = VARIABLE_DEFS;
    categories = [...new Set(variableDefs.map(v => v.category))];
    weights = {}; variableDefs.forEach(v => weights[v.key] = 1);
    selectedVar = null; corrFilter = 'all'; activeCategory = null;
    document.getElementById('emptyState').classList.remove('hidden');
    document.getElementById('resultsArea').classList.add('hidden');
    const vs = document.getElementById('varSearch'); if (vs) vs.value = '';
    showStatus('Loaded ' + result.name, 100);
    renderCategoryGrid(); renderVariableList(); initDecisionFramework();
    initBenchmark(); initSimulatorUI(); initCompareUI();
    lucide.createIcons();
    CURRENT_DATASET = { name: result.name, source: result.source, description: result.description, variableCount: variableDefs.length, lastUpdated: result.last_updated, requiresKey: false, dataset: DATASET, variables: VARIABLE_DEFS, loaded: true, file: datasetId };
    const dp2 = document.getElementById('dataPointCount');
    if (dp2) dp2.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 pulse-dot"></span><span>${variableDefs.length} variables</span>`;
  } catch (e) { showStatus('Failed: ' + e.message, 100); console.error(e); }
}

async function fetchWorldBankPreset(presetId) {
  const preset = DATASET_CATALOG.wb_presets.find(p => p.id === presetId);
  if (!preset) { showStatus('Preset not found', 100); return; }
  showStatus('Fetching ' + preset.name + '...', 5);
  _abortController = new AbortController();
  startLiveTicker();
  try {
    const resp = await apiWithSignal('/api/sources/list');
    const p = (resp.sources && resp.sources.worldbank_presets || []).find(x => x.id === presetId);
    if (!p) { showStatus('Preset not found on server', 100); return; }
    showStatus('Querying World Bank API for ' + preset.indicators + ' indicators...', 15);
    const result = await apiWithSignal(`/api/worldbank/fetch?indicators=${p.indicators}&countries=all&date_range=2020:2023`);
    if (!result.data || !result.data.length) { showStatus('No data returned', 100); return; }
    const keys = Object.keys(result.data[0]).filter(x => x !== 'country');
    const vars = keys.map(x => ({ key: x, name: x.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()), unit: '', category: preset.name, desc: 'World Bank indicator', icon: 'bar-chart-3', higherIsBetter: null }));
    DATASET.length = 0; result.data.forEach(d => DATASET.push(d));
    VARIABLE_DEFS.length = 0; vars.forEach(v => VARIABLE_DEFS.push(v));
    dataset = DATASET; variableDefs = VARIABLE_DEFS;
    categories = [...new Set(variableDefs.map(v => v.category))];
    weights = {}; variableDefs.forEach(v => weights[v.key] = 1);
    selectedVar = null; corrFilter = 'all'; activeCategory = null;
    document.getElementById('emptyState').classList.remove('hidden');
    document.getElementById('resultsArea').classList.add('hidden');
    showStatus(`Loaded ${preset.name} (${vars.length} variables)`, 100);
    renderCategoryGrid(); renderVariableList(); initDecisionFramework();
    initBenchmark(); initSimulatorUI(); initCompareUI();
    lucide.createIcons();
    CURRENT_DATASET = { name: 'WB: ' + preset.name, source: 'World Bank API', description: preset.description, variableCount: vars.length, lastUpdated: '2024', requiresKey: false, dataset: DATASET, variables: VARIABLE_DEFS, loaded: true, file: presetId };
    const dp2 = document.getElementById('dataPointCount');
    if (dp2) dp2.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 pulse-dot"></span><span>${variableDefs.length} variables</span>`;
  } catch (e) { showStatus('Fetch failed: ' + e.message, 100); }
}

async function fetchCustomWBIndicators() {
  showStatus('Loading indicator catalog...', 10);
  _abortController = new AbortController();
  startLiveTicker();
  try {
    const wb = await apiWithSignal('/api/worldbank/indicators');
    if (!wb.indicators) { showStatus('Catalog unavailable', 100); return; }
    const indList = wb.indicators.map(i => `<option value="${i.id}">${i.name} [${i.wb_code}] (${i.category})</option>`).join('');
    let modal = document.createElement('div');
    modal.id = 'customWBModal'; modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4';
    modal.onclick = e => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
      <div class="glass rounded-2xl w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
        <div class="flex items-center justify-between p-5 border-b border-slate-700/50">
          <h3 class="text-lg font-bold text-white">Custom World Bank Indicators</h3>
          <button onclick="document.getElementById('customWBModal').remove()" class="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-slate-700/50"><i data-lucide="x" class="w-4 h-4 text-slate-400"></i></button>
        </div>
        <div class="p-5 flex-1 overflow-auto">
          <p class="text-xs text-slate-400 mb-3">Hold Ctrl/Cmd to select multiple. Selected: <span id="wbSelCount" class="text-brand-300 font-semibold">0</span></p>
          <select id="wbIndicatorSelect" multiple class="w-full h-64 px-3 py-2 rounded-lg bg-slate-800/80 border border-slate-700/50 text-xs text-white mb-3 overflow-y-auto">${indList}</select>
          <button onclick="fetchWorldBankData()" class="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-brand-600/80 text-sm text-white hover:bg-brand-500 transition-colors">
            <i data-lucide="download" class="w-4 h-4"></i>Fetch & Load
          </button>
        </div>
      </div>`;
    document.body.appendChild(modal); lucide.createIcons();
    const sel = document.getElementById('wbIndicatorSelect');
    if (sel) sel.addEventListener('change', () => { const cnt = document.getElementById('wbSelCount'); if (cnt) cnt.textContent = sel.selectedOptions.length; });
  } catch (e) { showStatus('Catalog load failed', 100); }
}

async function fetchWorldBankData() {
  const sel = document.getElementById('wbIndicatorSelect'); if (!sel) return;
  const selected = Array.from(sel.selectedOptions).map(o => o.value);
  if (!selected.length) { showStatus('Select at least one indicator', 100); return; }
  showStatus('Fetching ' + selected.length + ' indicators from World Bank...', 5);
  _abortController = new AbortController();
  startLiveTicker();
  try {
    const result = await apiWithSignal(`/api/worldbank/fetch?indicators=${selected.join(',')}&countries=all&date_range=2020:2023`);
    if (!result.data || !result.data.length) { showStatus('No data returned', 100); return; }
    const keys = Object.keys(result.data[0]).filter(x => x !== 'country');
    const vars = keys.map(x => ({ key: x, name: x.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()), unit: '', category: 'World Bank', desc: 'World Bank indicator', icon: 'bar-chart-3', higherIsBetter: null }));
    DATASET.length = 0; result.data.forEach(d => DATASET.push(d));
    VARIABLE_DEFS.length = 0; vars.forEach(v => VARIABLE_DEFS.push(v));
    dataset = DATASET; variableDefs = VARIABLE_DEFS;
    categories = [...new Set(variableDefs.map(v => v.category))];
    weights = {}; variableDefs.forEach(v => weights[v.key] = 1);
    selectedVar = null; corrFilter = 'all'; activeCategory = null;
    document.getElementById('emptyState').classList.remove('hidden');
    document.getElementById('resultsArea').classList.add('hidden');
    const vs = document.getElementById('varSearch'); if (vs) vs.value = '';
    CURRENT_DATASET = { name: 'World Bank Custom', source: 'backend', description: `${selected.length} indicators fetched`, variableCount: vars.length };
    showStatus(`Loaded ${vars.length} variables`, 100);
    renderCategoryGrid(); renderVariableList(); initDecisionFramework();
    initBenchmark(); initSimulatorUI(); initCompareUI();
    lucide.createIcons();
    const dp3 = document.getElementById('dataPointCount');
    if (dp3) dp3.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 pulse-dot"></span><span>${variableDefs.length} variables</span>`;
  } catch (e) { showStatus('Fetch failed: ' + e.message, 100); }
}

async function fetchClimateData() {
  showStatus('Fetching climate data...', 5);
  _abortController = new AbortController();
  startLiveTicker();
  try {
    const result = await apiWithSignal('/api/climate/fetch');
    if (!result.data || !result.data.length) { showStatus('No climate data', 100); return; }
    const keys = Object.keys(result.data[0]).filter(x => x !== 'country');
    const vars = keys.map(x => ({ key: x, name: x.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()), unit: '', category: 'Climate', desc: 'Open-Meteo climate data', icon: 'cloud', higherIsBetter: null }));
    DATASET.length = 0; result.data.forEach(d => DATASET.push(d));
    VARIABLE_DEFS.length = 0; vars.forEach(v => VARIABLE_DEFS.push(v));
    dataset = DATASET; variableDefs = VARIABLE_DEFS;
    categories = [...new Set(variableDefs.map(v => v.category))];
    weights = {}; variableDefs.forEach(v => weights[v.key] = 1);
    selectedVar = null;
    CURRENT_DATASET = { name: 'Climate Data', source: 'Open-Meteo', description: 'Capital city climate averages', variableCount: vars.length };
    showStatus(`Loaded ${vars.length} variables`, 100);
    renderCategoryGrid(); renderVariableList(); initDecisionFramework();
    initBenchmark(); initSimulatorUI(); initCompareUI();
    lucide.createIcons();
    const dp4 = document.getElementById('dataPointCount');
    if (dp4) dp4.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 pulse-dot"></span><span>${variableDefs.length} variables</span>`;
  } catch (e) { showStatus('Climate fetch failed: ' + e.message, 100); }
}

function selectDatasetPack(name) { switchToDataset(name); }

// === LANDING PAGE ===
function dismissLanding(datasetId) {
  const overlay = document.getElementById('landingOverlay');
  if (overlay) {
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 500);
  }
  if (datasetId) {
    if (datasetId.startsWith('wb:')) {
      fetchWorldBankPreset(datasetId);
    } else {
      loadBuiltinDataset(datasetId);
    }
  }
}

function dismissLandingAndOpenSources() {
  const overlay = document.getElementById('landingOverlay');
  if (overlay) {
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 500);
  }
  showDatasetBrowser();
}

// === INSIGHT GUIDE CHATBOT ===
let chatHistory = [];

function openChatbot(mode, contextData) {
  const panel = document.getElementById('chatbotPanel');
  const backdrop = document.getElementById('chatbotBackdrop');
  if (!panel) return;
  panel.classList.remove('translate-x-full');
  if (backdrop) { backdrop.classList.remove('hidden'); setTimeout(() => backdrop.classList.remove('opacity-0'), 10); }
  lucide.createIcons();

  if (mode === 'general') {
    updateChatbotContext('general', 'Global Insight Engine');
  } else if (mode === 'chart' && contextData) {
    updateChatbotContext('chart', contextData);
  }
}

function closeChatbot() {
  const panel = document.getElementById('chatbotPanel');
  const backdrop = document.getElementById('chatbotBackdrop');
  if (panel) panel.classList.add('translate-x-full');
  if (backdrop) { backdrop.classList.add('opacity-0'); setTimeout(() => backdrop.classList.add('hidden'), 300); }
}

function updateChatbotContext(type, label) {
  const pill = document.getElementById('chatbotContextPill');
  const text = document.getElementById('chatbotContextText');
  if (pill && text) {
    if (type === 'general') {
      pill.classList.add('hidden');
    } else {
      pill.classList.remove('hidden');
      text.textContent = 'Looking at: ' + label;
    }
  }
}

function openChatbotFor(chartName) {
  const chartLabels = {
    'distribution': 'the Distribution chart',
    'network': 'the Network Diagram',
    'correlations': 'the Correlations section',
    'scatter': 'the Scatter Plot',
    'heatmap': 'the Heatmap',
    'radar': 'the Radar Comparison',
    'compare-heatmap': 'the Difference Heatmap',
    'outliers': 'the Outliers view',
    'decisions': 'the Decision Framework',
    'benchmark': 'the Profile benchmark',
    'simulator': 'the Simulator'
  };
  const selected = selectedVar ? (variableDefs.find(v => v.key === selectedVar) || {}).name || 'selected variable' : 'selected variable';
  const msg = `I'm looking at ${chartLabels[chartName] || 'this chart'} for ${selected}. Can you explain in detail how to read this visual, what it means, and how it was made?`;
  openChatbot('chart', chartLabels[chartName]);
  sendChatbotMessage(msg, true);
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
    <div class="${isTyping ? 'typing-indicator' : ''}">
      <div class="text-sm ${textColor} leading-relaxed chat-content">${isTyping ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-brand-400 animate-bounce mx-0.5" style="animation-delay:0s"></span><span class="inline-block w-1.5 h-1.5 rounded-full bg-brand-400 animate-bounce mx-0.5" style="animation-delay:0.15s"></span><span class="inline-block w-1.5 h-1.5 rounded-full bg-brand-400 animate-bounce mx-0.5" style="animation-delay:0.3s"></span>' : formatChatText(text)}</div>
    </div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  lucide.createIcons();
}

function formatChatText(text) {
  // Simple markdown-ish formatting: bold, paragraphs, bullet lists
  let html = text
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-brand-300">$1</strong>')
    .replace(/^\* (.+)$/gm, '<li class="flex items-start gap-2"><span class="text-brand-400 mt-0.5">›</span><span>$1</span></li>')
    .replace(/\n\n/g, '</p><p class="mt-2">')
    .replace(/\n/g, '<br>');
  // Wrap in p if not already
  if (!html.startsWith('<p')) html = '<p>' + html + '</p>';
  return html;
}

function sendChatbotMessage(text, skipUI) {
  const input = document.getElementById('chatbotInput');
  const msg = text || (input ? input.value.trim() : '');
  if (!msg) return;
  if (input && !text) input.value = '';

  if (!skipUI) appendChatMessage('user', msg);
  chatHistory.push({ role: 'user', text: msg });

  // Show typing indicator
  appendChatMessage('assistant', '', true);

  // Generate response based on context
  setTimeout(() => {
    // Remove typing indicator (last child)
    const container = document.getElementById('chatbotMessages');
    if (container && container.lastChild) container.lastChild.remove();

    const response = generateChatResponse(msg);
    appendChatMessage('assistant', response);
    chatHistory.push({ role: 'assistant', text: response });
  }, 600 + Math.random() * 800);
}

function generateChatResponse(userMsg) {
  const msg = userMsg.toLowerCase();
  const currentVar = selectedVar ? (variableDefs.find(v => v.key === selectedVar) || {}) : {};
  const varName = currentVar.name || 'the selected variable';
  const varDesc = currentVar.desc || 'a development indicator';

  // Chart-specific explanations
  if (msg.includes('distribution') || msg.includes('histogram') || msg.includes('bar chart')) {
    return `**The Distribution chart** shows how ${varName} is spread across all the data points currently loaded.

Here's what you're seeing:
* The **horizontal axis** (x-axis) shows the range of values — from the lowest to the highest score for ${varName}.
* The **vertical bars** tell you how many countries fall into each "bucket" or range. A tall bar means many countries have similar scores.
* If the bars cluster on the left, most countries score low. If they cluster on the right, most score high. A bell-shaped curve suggests a "normal" spread.

**How it's built:** The app takes every country's value for ${varName}, sorts them, then groups them into about 15 equal-width ranges (called "bins"). Each bar's height is simply the count of countries in that bin. This is the most straightforward way to see if a variable is evenly distributed or skewed toward one end.`;
  }

  if (msg.includes('network') || msg.includes('diagram') || msg.includes('node')) {
    return `**The Network Diagram** shows which other variables are most closely related to ${varName}.

Here's how to read it:
* **The big node in the center** is ${varName} itself — this is your "anchor."
* **Surrounding nodes** are other variables. The closer a node sits to the center, the stronger its connection to ${varName}.
* **Lines (edges)** connect related variables. Thicker = stronger relationship. The color shifts from cool (weak) to warm (strong).
* **Node size** reflects how many connections that variable has overall — a large node is a "hub" that connects to many things.

**How it's built:** The app calculates the **Pearson correlation coefficient** (a number from -1 to +1) between every pair of numeric variables. Only relationships above a threshold (default 0.3) are drawn. The layout uses a simple force-directed algorithm: related nodes attract each other, unrelated ones repel. It's a bit like watching magnets sort themselves out.`;
  }

  if (msg.includes('correlation') || msg.includes('pearson') || msg.includes('r=') || msg.includes('link')) {
    return `**Correlations** tell you whether two variables "move together."

* A score of **+1.0** means perfect lockstep: when one goes up, the other always goes up by a predictable amount.
* A score of **-1.0** means perfect opposition: when one goes up, the other always goes down.
* **0.0** means no relationship at all — they're independent.

**Rule of thumb for reading the numbers:**
* **0.0 to 0.3** — Weak or negligible. Probably coincidence.
* **0.3 to 0.5** — Moderate. Worth noting, but don't bet the farm on it.
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

* **Rows and columns** are the same list of variables, so the matrix is symmetrical (the top-right mirrors the bottom-left).
* **Color intensity** shows strength. Deep blue = strong positive correlation. Deep red = strong negative. Pale or white = weak or none.
* **The diagonal** (top-left to bottom-right) is always solid — that's a variable correlated with itself, so it's always +1.0.

**How it's built:** The app computes Pearson correlations between every pair of variables, then maps the -1.0 to +1.0 range onto a blue-to-red color gradient. This view is incredibly useful for spotting "clusters" of variables that all move together — for example, you might notice that GDP, education, and health all share a deep blue block, suggesting they rise and fall as a group.`;
  }

  if (msg.includes('outlier') || msg.includes('z-score') || msg.includes('unusual')) {
    return `**The Outliers view** flags countries that are statistically unusual — in a good way or a bad way.

* **Z-score** is the key number. It measures how many "standard deviations" a country's value is from the average.
* A **z-score of +2.0** means that country scores two full "spread units" above the mean — it's in the top ~2.5%.
* A **z-score of -2.0** means it's two units below — in the bottom ~2.5%.
* The app flags anything with an absolute z-score above **2.0** (you can change this threshold in settings).

**How it's built:** For each variable, the app calculates the mean and standard deviation across all countries. Then it subtracts the mean from each country's value and divides by the standard deviation. That's it — elegantly simple, yet powerful. Countries that show up here are worth a second look: they might be policy success stories, data anomalies, or simply unique cases.`;
  }

  if (msg.includes('radar') || msg.includes('spider') || msg.includes('comparison')) {
    return `**The Radar Chart** (sometimes called a "spider chart") lets you compare two countries across multiple variables at once.

* **Each spoke** (axis pointing outward) is one variable. The further a dot is from the center on that spoke, the higher that country's score.
* **The colored polygon** connects the dots, creating a "shape" that represents that country's overall profile.
* Two countries with similar shapes have similar profiles. Two with very different shapes are structurally different.

**How it's built:** The app normalizes every variable to a 0–100 scale (so variables with wildly different units can be compared side by side), then plots each country's normalized scores on evenly-spaced radial axes. It's one of the best ways to see the *balance* of strengths and weaknesses in a single glance.`;
  }

  if (msg.includes('decision') || msg.includes('framework') || msg.includes('score') || msg.includes('priority')) {
    return `**The Decision Framework** helps you weigh multiple variables into a single "goodness" score for each country.

Here's how it works:
* **You set weights** (sliders) for each variable. Want GDP to matter more? Slide it up. Want pollution to penalize a country? Keep it high — but note that "higher is better" variables add points, while "lower is better" ones subtract.
* **The app multiplies** each country's score by your weight, sums them up, and ranks countries.
* **Priority actions** are auto-generated suggestions: countries with low scores get recommendations based on which variables drag them down the most.

**How it's built:** It's essentially a weighted linear combination. Each variable is first normalized (0–100) so units don't matter. Then: Score = Σ (normalized_value × weight × direction). The direction is +1 for "higher is better" and -1 for "lower is better." Simple math, but the power is in *your* judgment via the sliders.`;
  }

  if (msg.includes('weight') && (msg.includes('slider') || msg.includes('priority') || msg.includes('how') || msg.includes('use'))) {
    const sliderCount = variableDefs.length || 'several';
    return `**The Priority Sliders** are how you tell the app what matters *to you*.

Here's how to think about them:
* **Each slider** is one variable (like GDP per Capita, Life Expectancy, CO₂ Emissions). Slide it right = "this matters a lot." Slide it left = "this barely matters."
* **All sliders add up to 100%** (the Total Weight bar at the bottom shows this). You don't have to hit exactly 100 — the app normalizes your choices automatically — but it's a helpful mental check.
* **"Higher is better" vs "Lower is better"** — some variables (like happiness) you want more of. Others (like corruption or pollution) you want less of. The app automatically knows which is which and flips the math behind the scenes. You don't need to "invert" anything yourself.

**A practical tip:** Start with everything at 1 (neutral). Then crank up the 2–3 variables you actually care about. The rankings will shift dramatically. If two variables are equally important, give them the same weight. If one is twice as important, double its slider.

**What happens when you move a slider?** The app instantly recalculates every country's composite score, re-sorts them, and updates the Top Recommendations list. It's real-time policy simulation — no "submit" button needed.`;
  }

  if (msg.includes('recommendation') || msg.includes('top') || msg.includes('score') || msg.includes('rank') || msg.includes('decision-result')) {
    return `**Top Recommendations** is the ranked list of countries that best match *your* priorities.

Here's what each number means:
* **Composite Score** — a single number from 0 to 100 that averages every variable, weighted by your slider settings. 100 = perfect alignment with what you said matters. 0 = worst alignment.
* **The colored bar** visualizes this score. Long green bar = great fit. Short red bar = poor fit.
* **Rank** — simply the sorted position. #1 is your "ideal" country given your current weights.

**How to use this:**
* If you're a policymaker, look at the top performers and study what they do differently.
* If you're an investor, the top-ranked countries might represent stable, high-growth environments given your criteria.
* If you're a researcher, flip the weights and watch how the rankings change. That's often where the real insights hide.

**Behind the scenes:** Every country's raw values are first normalized (so GDP in dollars and life expectancy in years can be compared apples-to-apples). Then each is multiplied by your weight and the variable's "direction" (+1 for "more is better", -1 for "less is better"). Sum across all variables = composite score. Sort = ranking. It's transparent, tweakable, and fast.`;
  }

  if (msg.includes('benchmark') || msg.includes('profile') || msg.includes('percentile') || msg.includes('rank')) {
    return `**The Profile / Benchmark view** shows where a specific country stands compared to its peers.

* **Percentiles** tell you the story: "Denmark is at the 94th percentile for Life Expectancy" means Denmark scores better than 94% of countries.
* **Peer comparison** lets you choose "global" peers (all countries) or "regional" peers (same continent/region). A country might look mediocre globally but exceptional regionally — or vice versa.
* **Strengths & weaknesses** are auto-flagged: variables where the country is above the 75th percentile are "Strengths"; below 25th are "Challenges."

**How it's built:** The app sorts all countries for each variable and finds each country's position in that sorted list. Percentile = (position ÷ total) × 100. Regional grouping uses the metadata from the REST Countries API. This view is perfect for quick country briefings.`;
  }

  if (msg.includes('simulator') || msg.includes('what if') || msg.includes('scenario')) {
    return `**The Simulator** lets you play "what if" with the data.

* **Choose a country** and a variable. The app shows that country's current value and the global average.
* **Adjust the slider** to set a hypothetical new value. The app instantly recalculates what would change: correlations, rankings, and percentile shifts.
* **Scenario cards** (pre-built) let you run common hypotheticals: "What if every country matched the top performer?" or "What if the lowest 20% caught up to the median?"

**How it's built:** When you change a value, the app temporarily replaces that data point, re-runs all calculations (correlations, percentiles, rankings), and shows you the delta. It's all client-side — no server needed — so it's fast and private. Think of it as a sandbox for policy imagination.`;
  }

  if (msg.includes('variable') && (msg.includes('this') || msg.includes('current') || msg.includes('selected'))) {
    return `**${varName}** is ${varDesc}.

Currently, the app is analyzing this variable across ${dataset.length} data points. When you select a variable, the app does a few things automatically:

1. **Distribution** — shows how the values spread across all countries
2. **Network** — finds which other variables move together with ${varName}
3. **Correlations** — ranks every other variable by statistical similarity
4. **Narrative** — generates a plain-language summary of the top and bottom performers

You can click any of these sections and then hit the **"Explain"** button next to a chart to get a deeper walkthrough.`;
  }

  if (msg.includes('how') && (msg.includes('use') || msg.includes('start') || msg.includes('begin'))) {
    return `Here's how to get the most out of the Insight Engine:

1. **Load a dataset** — click **Sources** in the top right, or pick one of the quick-start cards on the landing page. Each dataset has a different theme (happiness, environment, economy, etc.).

2. **Pick a variable** — the left sidebar shows all available variables. Click one, or search by name. The charts will update instantly.

3. **Explore the tabs** — **Explorer** for deep-dive charts, **Simulator** for "what if" scenarios, **Compare** for side-by-side country analysis, **Discover** for hidden gems, and more.

4. **Ask me anything** — click the **Guide** button (or this panel) anytime. I can explain charts, numbers, methodology, or help you interpret what you're seeing.

5. **Export** — hit the **Export** button in the header to download reports, CSVs, or chart images.`;
  }

  if (msg.includes('data') && (msg.includes('source') || msg.includes('from') || msg.includes('where'))) {
    return `The Insight Engine pulls from several trusted public sources:

* **World Bank Open Data** — the backbone. 120+ development indicators covering economy, health, education, environment, governance, and more. Updated regularly.
* **UNDP Human Development Index** — composite scores for life expectancy, education, and income.
* **World Happiness Report (UN SDSN)** — survey-based wellbeing data.
* **Yale Environmental Performance Index** — ecosystem and environmental health.
* **Institute for Economics & Peace** — peace, conflict, and security metrics.
* **Open-Meteo** — real climate data (temperature, precipitation) for capital cities.
* **Reporters Without Borders, Transparency International, WIPO, IMD** — press freedom, corruption, innovation, digital competitiveness.

All data is fetched live from APIs where possible, or served from curated built-in datasets. You can also upload your own CSV or JSON.`;
  }

  if (msg.includes('method') || msg.includes('how') || msg.includes('calculated') || msg.includes('algorithm')) {
    return `Most of the heavy lifting in this app is done with classic, well-understood statistical methods:

* **Pearson correlation** — measures linear relationships. It's the standard "r" value you see in the correlations section.
* **Z-scores** — for outlier detection. (value − mean) ÷ standard deviation.
* **Percentiles** — rank-based positioning. Simple sorting and division.
* **Linear regression** — the trend line in scatter plots. Least-squares fitting.
* **Normalization** — scaling everything to 0–100 so different units can be compared in radar charts and decision frameworks.

Nothing here is exotic or opaque. The goal is transparency: you should be able to understand *how* every number was produced, not just trust a black box. That's why every chart has an **Explain** button.`;
  }

  // Fallback
  return `Great question! Let me break that down for you.

The Insight Engine analyzes ${varName} and ${dataset.length ? dataset.length + ' data points' : 'the loaded dataset'} to find patterns, relationships, and outliers. Every chart and number is built from straightforward statistics — correlations, distributions, rankings — and designed to be readable without a PhD.

If you're looking at something specific, just tell me the name of the chart or section (like "Network Diagram" or "Correlations"), and I'll walk you through exactly what it means, how to read it, and how it was constructed.

You can also click the **Explain** button next to any chart for instant context.`;
}

// === CORE ===
async function init() {
  showStatus('Initializing...', 10);
  await loadDefaultDataset();
  dataset = DATASET; variableDefs = VARIABLE_DEFS;
  categories = [...new Set(variableDefs.map(v => v.category))];
  variableDefs.forEach(v => weights[v.key] = 1);
  showStatus('Processing...', 40);
  lucide.createIcons(); initTabs(); initExplorer();
  initDecisionFramework(); initBenchmark();
  initSimulatorUI(); initCompareUI();
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
  const tc = document.getElementById('tab-' + tab); if (tc) tc.classList.remove('hidden');
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  const tbtn = document.getElementById('tab-btn-' + tab); if (tbtn) tbtn.classList.add('active');
  if (tab === 'outliers') renderOutliers();
  if (tab === 'decisions') calculateDecisionScores();
  if (tab === 'discover') renderGemDiscovery();
  if (tab === 'compare') renderCompareResults();
  lucide.createIcons();
  pushURLState();
}

// === URL STATE ===
function pushURLState() {
  const state = { tab: activeTab, var: selectedVar, cat: activeCategory, corr: corrFilter, peers: peerMode, compare: compareCountries };
  const hash = btoa(JSON.stringify(state)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  history.replaceState(null, '', '#' + hash);
}
function restoreFromURL() {
  try {
    const hash = location.hash.slice(1); if (!hash) return;
    const state = JSON.parse(atob(hash.replace(/-/g, '+').replace(/_/g, '/')));
    if (state.tab && document.getElementById('tab-btn-' + state.tab)) switchTab(state.tab);
    if (state.cat) selectCategory(state.cat);
    if (state.corr) setCorrFilter(state.corr);
    if (state.peers) setPeerMode(state.peers);
    if (state.compare) { compareCountries = state.compare; renderCompareResults(); }
    if (state.var) setTimeout(() => selectVariable(state.var), 300);
  } catch (e) { /* ignore */ }
}
function shareSession() {
  pushURLState();
  navigator.clipboard.writeText(location.href).then(() => { showStatus('Share link copied!', 100); });
}

// === EXPLORER ===
function initExplorer() { renderCategoryGrid(); renderVariableList(); }
function renderCategoryGrid() {
  const cont = document.getElementById('categoryGrid'); if (!cont) return;
  cont.innerHTML = categories.map(cat => `
    <button onclick="selectCategory('${cat}')" class="cat-tile ${activeCategory === cat ? 'active' : ''}" id="cat-${cat.replace(/[^a-zA-Z]/g, '')}">
      <i data-lucide="folder" class="w-3.5 h-3.5"></i>${cat}
    </button>
  `).join(''); lucide.createIcons();
}
function selectCategory(cat) {
  if (activeCategory === cat) { clearCategoryFilter(); return; }
  activeCategory = cat; const vs = document.getElementById('varSearch'); if (vs) vs.value = '';
  renderCategoryGrid(); renderVariableList();
}
function clearCategoryFilter() {
  activeCategory = null; const vs = document.getElementById('varSearch'); if (vs) vs.value = '';
  renderCategoryGrid(); renderVariableList();
}
function renderVariableList() {
  const searchEl = document.getElementById('varSearch');
  const search = searchEl ? searchEl.value.toLowerCase().trim() : '';
  const filtered = variableDefs.filter(v => {
    const ms = v.name.toLowerCase().includes(search) || v.category.toLowerCase().includes(search);
    const mc = !activeCategory || v.category === activeCategory;
    return ms && mc;
  });
  const vc = document.getElementById('varCount'); if (vc) vc.textContent = filtered.length + ' available';
  const listEl = document.getElementById('variableList');
  const clearWrap = document.getElementById('clearCatWrap');
  const shouldShow = activeCategory !== null || search.length > 0;
  if (shouldShow) {
    if (listEl) {
      listEl.classList.remove('hidden');
      listEl.innerHTML = filtered.map(v => `
        <button onclick="selectVariable('${v.key}')" class="variable-item w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-xl ${selectedVar === v.key ? 'active' : 'border-transparent'}">
          <div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${selectedVar === v.key ? 'bg-brand-500/20' : 'bg-slate-800/50'}">
            <i data-lucide="${v.icon}" class="w-4 h-4 ${selectedVar === v.key ? 'text-brand-400' : 'text-slate-500'}"></i>
          </div>
          <div class="min-w-0">
            <div class="text-sm font-medium ${selectedVar === v.key ? 'text-white' : 'text-slate-300'} truncate">${v.name}</div>
            <div class="text-[0.65rem] text-slate-500">${v.category} · ${v.unit}</div>
          </div>
        </button>
      `).join('');
    }
    if (clearWrap) clearWrap.classList.toggle('hidden', activeCategory === null);
  } else { if (listEl) { listEl.classList.add('hidden'); listEl.innerHTML = ''; } if (clearWrap) clearWrap.classList.add('hidden'); }
  lucide.createIcons();
}
function filterVariables() { renderVariableList(); }

// === PEER MODE ===
function setPeerMode(mode) {
  peerMode = mode;
  document.querySelectorAll('.peer-toggle').forEach(el => el.classList.remove('active'));
  const el = document.getElementById('peer' + (mode === 'global' ? 'Global' : 'Regional'));
  if (el) el.classList.add('active');
  if (selectedVar) updateExplorer();
  pushURLState();
}
function getPeerData(country) {
  if (peerMode === 'global') return dataset;
  const d = dataset.find(x => x.country === country);
  if (!d || !d.region) return dataset;
  return dataset.filter(x => x.region === d.region);
}

// === VARIABLE SELECTION ===
function selectVariable(key) {
  selectedVar = key;
  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('resultsArea').classList.remove('hidden');
  const pc = document.getElementById('peerToggleContainer'); if (pc) pc.style.display = 'flex';
  renderVariableList(); updateExplorer(); pushURLState();
}
function updateExplorer() {
  const v = variableDefs.find(d => d.key === selectedVar); if (!v) return;
  const values = vals(selectedVar);
  const corrs = getCorrelations(selectedVar);
  const hc = document.getElementById('heroCategory'); if (hc) hc.textContent = v.category;
  const ht = document.getElementById('heroType'); if (ht) ht.textContent = v.unit;
  const hn = document.getElementById('heroName'); if (hn) hn.textContent = v.name;
  const hd = document.getElementById('heroDesc'); if (hd) hd.textContent = v.desc;
  const hm = document.getElementById('heroMean'); if (hm) hm.textContent = M.mean(values).toFixed(1);
  const hs = document.getElementById('heroStd'); if (hs) hs.textContent = M.std(values).toFixed(2);
  const hr = document.getElementById('heroRange'); if (hr) hr.textContent = Math.min(...values).toFixed(1) + '-' + Math.max(...values).toFixed(1);
  renderRiskOpportunity(v, corrs);
  renderInsightBanners(v, corrs);
  renderDistribution(values, v);
  renderNetworkGraph(v, corrs);
  renderCorrelationBars(corrs);
  initScatterSelect(corrs); updateScatterPlot();
  renderInsightCards(v, corrs);
  renderHeatmap();
  generateNarrative(v, corrs);
}

// === NARRATIVE ===
function generateNarrative(v, corrs) {
  const panel = document.getElementById('narrativePanel');
  const textEl = document.getElementById('narrativeText');
  if (!panel || !textEl) return;
  panel.classList.remove('hidden');
  const strongest = corrs[0];
  const neg = corrs.filter(c => c.r < -0.3).sort((a, b) => a.r - b.r)[0];
  const pos = corrs.filter(c => c.r > 0.5).sort((a, b) => b.r - a.r)[0];
  const cross = corrs.find(c => Math.abs(c.r) >= 0.5 && c.category !== v.category);
  const topCountry = [...dataset].sort((a, b) => (b[v.key] || 0) - (a[v.key] || 0))[0];
  const bottomCountry = [...dataset].sort((a, b) => (a[v.key] || 0) - (b[v.key] || 0))[0];
  let narrative = `${v.name} (${v.category}) varies widely. `;
  if (topCountry && topCountry[v.key] != null && bottomCountry && bottomCountry[v.key] != null) {
    narrative += `${topCountry.country} leads with ${topCountry[v.key].toFixed(1)} ${v.unit}, while ${bottomCountry.country} records ${bottomCountry[v.key].toFixed(1)} ${v.unit}. `;
  }
  if (strongest) {
    narrative += `Its ${strongest.r >= 0 ? 'strongest positive' : 'strongest negative'} link is with ${strongest.name} (${corrStrength(strongest.r)}, r=${strongest.r.toFixed(2)}). `;
  }
  if (cross) {
    narrative += `Notably, ${v.name.toLowerCase()} shows a ${corrStrength(cross.r)} cross-domain relationship with ${cross.name} (${cross.category}), suggesting interconnected policy levers. `;
  }
  if (neg) {
    narrative += `There is a risk signal: higher ${v.name.toLowerCase()} is associated with lower ${neg.name.toLowerCase()} (r=${neg.r.toFixed(2)}). `;
  }
  if (pos) {
    narrative += `An opportunity emerges: ${v.name.toLowerCase()} and ${pos.name.toLowerCase()} move together (r=${pos.r.toFixed(2)}), suggesting coordinated investment may yield dual returns.`;
  }
  textEl.textContent = narrative;
}

// === RISK / OPPORTUNITY / BANNERS ===
function renderRiskOpportunity(v, corrs) {
  const cont = document.getElementById('riskOpportunityBanner'); if (!cont) return;
  const risks = corrs.filter(c => c.r < -0.3).sort((a, b) => a.r - b.r);
  const opps = corrs.filter(c => c.r > 0.5).sort((a, b) => b.r - a.r);
  let html = '';
  if (risks.length > 0) {
    const r = risks[0];
    html += `<div class="glass-risk rounded-xl p-4 flex items-start gap-3 fade-in"><div class="w-10 h-10 rounded-lg bg-red-500/15 flex items-center justify-center flex-shrink-0"><i data-lucide="shield-alert" class="w-5 h-5 text-red-400"></i></div><div><div class="text-xs text-red-400 font-semibold mb-0.5">RISK FACTOR</div><div class="text-sm font-semibold text-white">${v.name} ↔ ${r.name}</div><div class="text-xs text-slate-400 mt-1">Higher ${v.name.toLowerCase()} linked to lower ${r.name.toLowerCase()}.</div></div></div>`;
  }
  if (opps.length > 0) {
    const o = opps[0];
    html += `<div class="glass-success rounded-xl p-4 flex items-start gap-3 fade-in"><div class="w-10 h-10 rounded-lg bg-emerald-500/15 flex items-center justify-center flex-shrink-0"><i data-lucide="trending-up" class="w-5 h-5 text-emerald-400"></i></div><div><div class="text-xs text-emerald-400 font-semibold mb-0.5">OPPORTUNITY</div><div class="text-sm font-semibold text-white">${v.name} ↔ ${o.name}</div><div class="text-xs text-slate-400 mt-1">Strong positive link.</div></div></div>`;
  }
  cont.innerHTML = html; lucide.createIcons();
}
function renderInsightBanners(v, corrs) {
  const cont = document.getElementById('insightBanners'); if (!cont) return;
  if (!corrs.length) { cont.innerHTML = ''; return; }
  const strongest = corrs[0]; const neg = corrs.filter(c => c.r < 0); const strong = corrs.filter(c => Math.abs(c.r) >= 0.5);
  let html = `<div class="insight-card glass-light rounded-xl p-4 flex items-start gap-3 fade-in"><div class="w-10 h-10 rounded-lg ${strongest.r >= 0 ? 'bg-brand-500/15' : 'bg-rose-500/15'} flex items-center justify-center"><i data-lucide="${strongest.r >= 0 ? 'trending-up' : 'trending-down'}" class="w-5 h-5 ${strongest.r >= 0 ? 'text-brand-400' : 'text-rose-400'}"></i></div><div><div class="text-xs text-slate-500 mb-0.5">Strongest Connection</div><div class="text-sm font-semibold text-white">${v.name} → ${strongest.name}</div><div class="text-xs text-slate-400 mt-1">${corrStrength(strongest.r)} ${strongest.r >= 0 ? 'positive' : 'negative'} (r=${strongest.r.toFixed(3)}).</div></div></div>`;
  if (neg.length > 0) {
    const n = neg.sort((a, b) => a.r - b.r)[0];
    html += `<div class="insight-card glass-light rounded-xl p-4 flex items-start gap-3 fade-in"><div class="w-10 h-10 rounded-lg bg-rose-500/15 flex items-center justify-center"><i data-lucide="arrow-down" class="w-5 h-5 text-rose-400"></i></div><div><div class="text-xs text-slate-500 mb-0.5">Inverse Relationship</div><div class="text-sm font-semibold text-white">${v.name} ↯ ${n.name}</div><div class="text-xs text-slate-400 mt-1">As ${v.name.toLowerCase()} rises, ${n.name.toLowerCase()} tends to fall (r=${n.r.toFixed(3)}).</div></div></div>`;
  }
  const cross = corrs.find(c => Math.abs(c.r) >= 0.5 && c.category !== v.category);
  if (cross) {
    html += `<div class="insight-card glass-light rounded-xl p-4 flex items-start gap-3 fade-in"><div class="w-10 h-10 rounded-lg bg-amber-500/15 flex items-center justify-center"><i data-lucide="zap" class="w-5 h-5 text-amber-400"></i></div><div><div class="text-xs text-slate-500 mb-0.5">Cross-Domain Insight</div><div class="text-sm font-semibold text-white">${v.name} ↔ ${cross.name}</div><div class="text-xs text-slate-400 mt-1">${v.category} ↔ ${cross.category}: hidden relationship!</div></div></div>`;
  }
  html += `<div class="insight-card glass-light rounded-xl p-4 flex items-start gap-3 fade-in"><div class="w-10 h-10 rounded-lg bg-purple-500/15 flex items-center justify-center"><i data-lucide="hash" class="w-5 h-5 text-purple-400"></i></div><div><div class="text-xs text-slate-500 mb-0.5">Summary</div><div class="text-sm font-semibold text-white">${strong.length} strong connections</div><div class="text-xs text-slate-400 mt-1">${strong.length} of ${corrs.length} variables show |r| >= 0.5.</div></div></div>`;
  cont.innerHTML = html; lucide.createIcons();
}

// === DISTRIBUTION CHART ===
function renderDistribution(values, v) {
  const mn = Math.min(...values), mx = Math.max(...values);
  const bins = 12, bw = (mx - mn) / bins || 1;
  const hist = new Array(bins).fill(0);
  values.forEach(val => { let idx = Math.floor((val - mn) / bw); if (idx >= bins) idx = bins - 1; hist[idx]++; });
  const labels = hist.map((_, i) => (mn + i * bw).toFixed(0));
  if (charts.distribution) charts.distribution.destroy();
  const el = document.getElementById('distributionChart'); if (!el) return;
  charts.distribution = new Chart(el, {
    type: 'bar', data: { labels, datasets: [{ data: hist, backgroundColor: 'rgba(6,182,212,0.3)', borderColor: 'rgba(6,182,212,0.7)', borderWidth: 1, borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { color: 'rgba(148,163,184,0.05)' }, ticks: { color: '#64748b', font: { size: 10 } } }, y: { grid: { color: 'rgba(148,163,184,0.05)' }, ticks: { color: '#64748b', font: { size: 10 } } } } }
  });
}

// === NETWORK GRAPH ===
function renderNetworkGraph(v, corrs) {
  const canvas = document.getElementById('networkCanvas'); if (!canvas) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;
  canvas.width = rect.width * 2; canvas.height = rect.height * 2;
  canvas.style.width = rect.width + 'px'; canvas.style.height = rect.height + 'px';
  const ctx = canvas.getContext('2d'); ctx.scale(2, 2);
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);
  const centerNode = { x: w / 2, y: h / 2, label: v.name, color: '#22d3ee' };
  const nodes = corrs.slice(0, 12).map((c, i) => {
    const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const dist = 60 + Math.abs(c.r) * 60;
    return { x: w / 2 + Math.cos(angle) * dist, y: h / 2 + Math.sin(angle) * dist, label: c.name, r: c.r, color: c.r >= 0 ? '#22d3ee' : '#f43f5e', category: c.category };
  });
  nodes.forEach(node => {
    ctx.beginPath(); ctx.moveTo(centerNode.x, centerNode.y); ctx.lineTo(node.x, node.y);
    ctx.strokeStyle = node.r >= 0 ? `rgba(34,211,238,${Math.abs(node.r) * 0.5})` : `rgba(244,63,94,${Math.abs(node.r) * 0.5})`;
    ctx.lineWidth = Math.abs(node.r) * 3; ctx.stroke();
  });
  ctx.beginPath(); ctx.arc(centerNode.x, centerNode.y, 20, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(6,182,212,0.25)'; ctx.fill(); ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = '500 9px Inter'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(centerNode.label.slice(0, 12), centerNode.x, centerNode.y);
  nodes.forEach(node => {
    ctx.beginPath(); ctx.arc(node.x, node.y, 8 + Math.abs(node.r) * 6, 0, Math.PI * 2);
    ctx.fillStyle = node.r >= 0 ? `rgba(34,211,238,${0.15 + Math.abs(node.r) * 0.3})` : `rgba(244,63,94,${0.15 + Math.abs(node.r) * 0.3})`;
    ctx.fill(); ctx.strokeStyle = node.color; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = '#94a3b8'; ctx.font = '400 8px Inter';
    ctx.fillText(node.label.slice(0, 14), node.x, node.y + 18);
  });
}

// === CORRELATION BARS ===
function renderCorrelationBars(corrs) {
  let filtered = corrs;
  if (corrFilter === 'positive') filtered = corrs.filter(c => c.r > 0);
  if (corrFilter === 'negative') filtered = corrs.filter(c => c.r < 0);
  const el = document.getElementById('correlationBars'); if (!el) return;
  el.innerHTML = filtered.slice(0, 20).map((c, i) => `
    <div class="flex items-center gap-3 fade-in" style="animation-delay:${i * 0.03}s">
      <div class="w-36 sm:w-44 flex-shrink-0 flex items-center gap-2"><i data-lucide="${c.icon}" class="w-3.5 h-3.5 text-slate-500"></i><span class="text-xs font-medium text-slate-300 truncate">${c.name}</span></div>
      <div class="flex-1 h-7 rounded-md bg-slate-800/50 relative overflow-hidden">
        <div class="corr-bar h-full rounded-md opacity-70" style="width:${Math.abs(c.r) * 100}%;background:${c.r >= 0 ? 'linear-gradient(90deg,#22d3ee,#0891b2)' : 'linear-gradient(90deg,#f43f5e,#be123c)'}"></div>
        <div class="absolute inset-0 flex items-center justify-end pr-2"><span class="text-[0.65rem] font-mono ${c.r >= 0 ? 'text-brand-300' : 'text-rose-300'} font-medium">${c.r >= 0 ? '+' : ''}${c.r.toFixed(3)}</span></div>
      </div>
      <span class="text-[0.6rem] text-slate-500 w-20 text-right hidden sm:block">${corrStrength(c.r)} ${c.r >= 0 ? 'positive' : 'negative'}</span>
    </div>
  `).join(''); lucide.createIcons();
}
function setCorrFilter(f) {
  corrFilter = f;
  ['filterAll', 'filterPos', 'filterNeg'].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    const isActive = (id === 'filterAll' && f === 'all') || (id === 'filterPos' && f === 'positive') || (id === 'filterNeg' && f === 'negative');
    el.className = isActive ? 'px-3 py-1 rounded-md text-xs bg-brand-500/20 text-brand-300 border border-brand-500/30' : 'px-3 py-1 rounded-md text-xs bg-slate-800/50 text-slate-400 border border-slate-700/50 hover:border-slate-600';
  });
  renderCorrelationBars(getCorrelations(selectedVar));
  pushURLState();
}

// === SCATTER PLOT ===
function initScatterSelect(corrs) {
  const el = document.getElementById('scatterVarSelect'); if (el) el.innerHTML = corrs.map(c => `<option value="${c.key}">${c.name} (r=${c.r.toFixed(3)})</option>`).join('');
}
function updateScatterPlot() {
  const v1 = selectedVar, v2El = document.getElementById('scatterVarSelect'); if (!v2El) return;
  const v2 = v2El.value; if (!v1 || !v2) return;
  const d1 = variableDefs.find(v => v.key === v1), d2 = variableDefs.find(v => v.key === v2);
  const data = dataset.map(d => ({ x: d[v1], y: d[v2], label: d.country })).filter(p => p.x != null && p.y != null);
  if (charts.scatter) charts.scatter.destroy();
  const el = document.getElementById('scatterChart'); if (!el) return;
  charts.scatter = new Chart(el, {
    type: 'scatter', data: { datasets: [{ data, backgroundColor: 'rgba(6,182,212,0.5)', borderColor: 'rgba(148,163,184,0.2)', borderWidth: 1, pointRadius: 5, pointHoverRadius: 7 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${ctx.raw.label}: (${d1.name}=${ctx.raw.x?.toFixed(1)}, ${d2.name}=${ctx.raw.y?.toFixed(1)})` } } }, scales: { x: { title: { display: true, text: `${d1.name} (${d1.unit})`, color: '#94a3b8', font: { size: 11 } }, grid: { color: 'rgba(148,163,184,0.05)' }, ticks: { color: '#64748b', font: { size: 10 } } }, y: { title: { display: true, text: `${d2.name} (${d2.unit})`, color: '#94a3b8', font: { size: 11 } }, grid: { color: 'rgba(148,163,184,0.05)' }, ticks: { color: '#64748b', font: { size: 10 } } } } }
  });
}

// === HEATMAP ===
function renderHeatmap() {
  const canvas = document.getElementById('heatmapCanvas'); if (!canvas) return;
  const n = Math.min(20, variableDefs.length);
  const vars = variableDefs.slice(0, n);
  const cellSize = 28, padding = 120;
  const width = n * cellSize + padding, height = n * cellSize + padding;
  canvas.width = width * 2; canvas.height = height * 2;
  canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
  const ctx = canvas.getContext('2d'); ctx.scale(2, 2);
  ctx.clearRect(0, 0, width, height);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const r = i === j ? 1 : M.pearson(vals(vars[i].key), vals(vars[j].key));
      const intensity = Math.abs(r); const hue = r >= 0 ? 190 : 350;
      ctx.fillStyle = `hsla(${hue}, 80%, 50%, ${0.05 + intensity * 0.45})`;
      ctx.fillRect(padding + j * cellSize, padding + i * cellSize, cellSize - 1, cellSize - 1);
      if (Math.abs(r) > 0.5) { ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '400 7px Inter'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(r.toFixed(2), padding + j * cellSize + cellSize / 2, padding + i * cellSize + cellSize / 2); }
    }
  }
  ctx.fillStyle = '#94a3b8'; ctx.font = '400 8px Inter'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) { ctx.fillText(vars[i].name.slice(0, 18), padding - 6, padding + i * cellSize + cellSize / 2); }
  ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  for (let j = 0; j < n; j++) { ctx.save(); ctx.translate(padding + j * cellSize + cellSize / 2, padding - 4); ctx.rotate(-Math.PI / 4); ctx.fillText(vars[j].name.slice(0, 18), 0, 0); ctx.restore(); }
}

// === INSIGHT CARDS ===
function renderInsightCards(v, corrs) {
  const cont = document.getElementById('insightCards'); if (!cont) return;
  const top = corrs.filter(c => Math.abs(c.r) >= 0.3).slice(0, 8);
  let html = '';
  top.forEach((c, i) => {
    const isCross = c.category !== v.category;
    const practical = getPracticalInsight(v.key, c.key, c.r); if (!practical) return;
    html += `<div class="insight-card glass-light rounded-xl p-4 fade-in ${isCross ? 'border border-amber-500/20' : ''}" style="animation-delay:${i * 0.05}s">
      <div class="flex items-center justify-between mb-2"><div class="flex items-center gap-2"><i data-lucide="${c.icon}" class="w-4 h-4 ${c.r >= 0 ? 'text-brand-400' : 'text-rose-400'}"></i><span class="text-sm font-semibold text-white">${c.name}</span></div><div class="flex items-center gap-2">${isCross ? '<span class="text-[0.6rem] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">Cross-domain</span>' : ''}<span class="text-xs font-mono ${c.r >= 0 ? 'text-brand-300' : 'text-rose-300'}">${c.r >= 0 ? '+' : ''}${c.r.toFixed(3)}</span></div></div>
      <div class="text-xs text-slate-400 leading-relaxed">${practical}</div>
      <button onclick="selectVariable('${c.key}')" class="mt-3 flex items-center gap-1 text-[0.65rem] font-medium text-brand-400 hover:text-brand-300 transition-colors"><i data-lucide="arrow-right" class="w-3 h-3"></i>Explore ${c.name}</button>
    </div>`;
  });
  cont.innerHTML = html; lucide.createIcons();
}
function getPracticalInsight(vk, ck, r) {
  const v = variableDefs.find(x => x.key === vk), c = variableDefs.find(x => x.key === ck);
  if (!v || !c) return null;
  if (r >= 0.7) return `Very strong positive: when ${v.name.toLowerCase()} improves, ${c.name.toLowerCase()} follows.`;
  if (r >= 0.5) return `Moderate positive: ${v.name.toLowerCase()} and ${c.name.toLowerCase()} move together.`;
  if (r >= 0.3) return `Weak positive trend between ${v.name.toLowerCase()} and ${c.name.toLowerCase()}.`;
  if (r <= -0.7) return `Strong inverse: higher ${v.name.toLowerCase()} linked to lower ${c.name.toLowerCase()}.`;
  if (r <= -0.5) return `Moderate inverse: ${v.name.toLowerCase()} and ${c.name.toLowerCase()} oppose.`;
  if (r <= -0.3) return `Weak negative trend.`;
  return null;
}

// === DECISIONS ===
function initDecisionFramework() {
  const cont = document.getElementById('weightSliders'); if (!cont) return;
  cont.innerHTML = variableDefs.map(v => `
    <div class="flex items-center gap-3">
      <div class="w-8 h-8 rounded-lg bg-slate-800/50 flex items-center justify-center flex-shrink-0"><i data-lucide="${v.icon}" class="w-4 h-4 text-slate-500"></i></div>
      <div class="flex-1"><div class="flex items-center justify-between mb-1"><span class="text-xs text-slate-300">${v.name}</span><span class="text-xs font-mono text-brand-300" id="weight-val-${v.key}">1</span></div>
      <input type="range" min="0" max="10" value="1" class="slider-track w-full" id="weight-${v.key}" oninput="updateWeight('${v.key}', this.value)"></div>
    </div>
  `).join(''); lucide.createIcons(); calculateDecisionScores();
}
function updateWeight(key, val) {
  weights[key] = parseInt(val);
  const el = document.getElementById('weight-val-' + key); if (el) el.textContent = val;
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const bar = document.getElementById('weightTotalBar'), txt = document.getElementById('weightTotalText');
  if (bar) bar.style.width = Math.min(100, total) + '%'; if (txt) txt.textContent = total + ' / 100';
  calculateDecisionScores();
}
function resetWeights() {
  variableDefs.forEach(v => { weights[v.key] = 1; const el = document.getElementById('weight-' + v.key); if (el) el.value = 1; const vl = document.getElementById('weight-val-' + v.key); if (vl) vl.textContent = '1'; });
  const bar = document.getElementById('weightTotalBar'), txt = document.getElementById('weightTotalText');
  if (bar) bar.style.width = '100%'; if (txt) txt.textContent = '100%';
  calculateDecisionScores();
}
function calculateDecisionScores() {
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const scores = dataset.map(d => {
    let score = 0;
    for (let v of variableDefs) {
      const val = d[v.key]; if (val == null) continue;
      const arr = vals(v.key); const norm = M.normalize(val, arr); const w = weights[v.key] / totalWeight;
      if (v.higherIsBetter === true) score += norm * w; else if (v.higherIsBetter === false) score += (1 - norm) * w; else score += norm * w;
    }
    return { country: d.country, score };
  }).sort((a, b) => b.score - a.score);
  renderDecisionResults(scores.slice(0, 10));
  renderRadarChart(scores.slice(0, 3));
}
function renderDecisionResults(top) {
  const el = document.getElementById('decisionResults'); if (!el) return;
  el.innerHTML = top.map((s, i) => `
    <div class="flex items-center gap-3 fade-in" style="animation-delay:${i * 0.05}s">
      <div class="w-6 text-center text-xs font-bold text-slate-500">${i + 1}</div>
      <div class="flex-1"><div class="flex items-center justify-between mb-1"><span class="text-sm font-medium text-white">${s.country}</span><span class="text-xs font-mono text-brand-300">${Math.round(s.score * 100)}%</span></div>
      <div class="w-full h-2 rounded-full bg-slate-800 overflow-hidden"><div class="h-full bg-gradient-to-r from-brand-600 to-brand-400 rounded-full" style="width:${Math.round(s.score * 100)}%"></div></div></div>
    </div>
  `).join('');
}
function renderRadarChart(top3) {
  const canvas = document.getElementById('radarChart'); if (!canvas) return;
  const rect = canvas.parentElement.getBoundingClientRect(); if (rect.width < 10 || rect.height < 10) return;
  canvas.width = rect.width * 2; canvas.height = rect.height * 2;
  canvas.style.width = rect.width + 'px'; canvas.style.height = rect.height + 'px';
  const ctx = canvas.getContext('2d'); ctx.scale(2, 2);
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, rad = Math.min(cx, cy) - 50;
  const n = Math.min(8, variableDefs.length);
  const selectedVars = variableDefs.slice(0, n);
  const colors = ['#22d3ee', '#f59e0b', '#f43f5e'];
  for (let i = 1; i <= 5; i++) { ctx.beginPath(); ctx.arc(cx, cy, rad * i / 5, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(148,163,184,0.1)'; ctx.lineWidth = 1; ctx.stroke(); }
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + i * (2 * Math.PI) / n;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad); ctx.strokeStyle = 'rgba(148,163,184,0.1)'; ctx.stroke();
    ctx.fillStyle = '#94a3b8'; ctx.font = '500 8px Inter'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lx = cx + Math.cos(a) * (rad + 18), ly = cy + Math.sin(a) * (rad + 18); ctx.fillText(selectedVars[i].name.slice(0, 10), lx, ly);
  }
  top3.forEach((s, si) => {
    const country = dataset.find(d => d.country === s.country);
    const pts = selectedVars.map((v, i) => {
      const a = -Math.PI / 2 + i * (2 * Math.PI) / n;
      const arr = vals(v.key); const norm = country && country[v.key] != null ? M.normalize(country[v.key], arr) : 0;
      return { x: cx + Math.cos(a) * rad * norm, y: cy + Math.sin(a) * rad * norm };
    });
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y)); ctx.closePath();
    ctx.fillStyle = colors[si] + '18'; ctx.fill(); ctx.strokeStyle = colors[si]; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = colors[si]; ctx.font = '500 10px Inter'; ctx.textAlign = 'left'; ctx.fillText(s.country, 20, 20 + si * 16);
  });
}

// === BENCHMARK ===
function initBenchmark() {
  const cont = document.getElementById('benchmarkInputs'); if (!cont) return;
  cont.innerHTML = variableDefs.map(v => `
    <div><label class="block text-[0.65rem] text-slate-500 mb-1">${v.name} (${v.unit})</label>
    <input type="number" id="bench-${v.key}" class="w-full px-3 py-2 rounded-lg bg-slate-800/50 border border-slate-700/50 text-sm text-white focus:outline-none focus:border-brand-500/50" placeholder="e.g. ${Math.round(M.mean(vals(v.key)))}"></div>
  `).join('');
  const sel = document.getElementById('benchmarkCountrySelect'); if (sel) sel.innerHTML = '<option value="">-- Pick a country proxy --</option>' + dataset.map(d => `<option value="${d.country}">${d.country}</option>`).join('');
}
function fillBenchmarkFromCountry() {
  const cEl = document.getElementById('benchmarkCountrySelect'); if (!cEl) return;
  const c = cEl.value; if (!c) return;
  const d = dataset.find(x => x.country === c);
  variableDefs.forEach(v => { const el = document.getElementById('bench-' + v.key); if (el && d && d[v.key] != null) el.value = d[v.key]; });
}
function calculateBenchmark() {
  const user = { country: 'You' };
  variableDefs.forEach(v => { const el = document.getElementById('bench-' + v.key); if (!el) return; const val = parseFloat(el.value); if (!isNaN(val)) user[v.key] = val; });
  const results = document.getElementById('benchmarkResults'); if (results) results.classList.remove('hidden');
  const pb = document.getElementById('percentileBars');
  if (pb) {
    pb.innerHTML = variableDefs.map((v, i) => {
      if (user[v.key] == null) return '';
      const data = getPeerData('You');
      const p = M.percentile(user[v.key], vals(v.key, data));
      const color = p > 75 ? 'bg-emerald-500' : p > 50 ? 'bg-brand-500' : p > 25 ? 'bg-amber-500' : 'bg-red-500';
      const peerLabel = peerMode === 'regional' ? ' (regional)' : ' (global)';
      return `<div class="flex items-center gap-3 fade-in" style="animation-delay:${i * 0.03}s"><div class="w-32 sm:w-40 flex-shrink-0 flex items-center gap-2"><i data-lucide="${v.icon}" class="w-3.5 h-3.5 text-slate-500"></i><span class="text-xs text-slate-300 truncate">${v.name}</span></div><div class="flex-1 h-6 rounded-md bg-slate-800/50 relative overflow-hidden"><div class="h-full ${color} opacity-70 rounded-md" style="width:${p}%"></div><div class="absolute inset-0 flex items-center justify-end pr-2"><span class="text-[0.65rem] font-mono text-white font-medium">${p.toFixed(0)}th percentile${peerLabel}</span></div></div></div>`;
    }).join('');
  }
  let best = null, bestDiff = Infinity;
  for (let d of dataset) {
    let diff = 0, count = 0;
    for (let v of variableDefs) {
      if (user[v.key] != null && d[v.key] != null) { const arr = vals(v.key); diff += Math.abs(M.normalize(user[v.key], arr) - M.normalize(d[v.key], arr)); count++; }
    }
    if (count > 0 && diff / count < bestDiff) { bestDiff = diff / count; best = d; }
  }
  const cm = document.getElementById('closestMatch');
  if (cm) {
    cm.innerHTML = `<div class="flex items-center gap-4"><div class="w-12 h-12 rounded-xl bg-brand-500/20 flex items-center justify-center"><i data-lucide="map-pin" class="w-6 h-6 text-brand-400"></i></div><div><div class="text-sm text-slate-500">Your profile most closely matches</div><div class="text-lg font-bold text-white">${best ? best.country : 'N/A'}</div><div class="text-xs text-slate-400">Similarity: ${best ? Math.max(0, 100 - bestDiff * 100).toFixed(0) : 0}%</div></div><button onclick="switchTab('explorer')" class="ml-auto px-3 py-1.5 rounded-lg bg-brand-600/80 text-xs text-white hover:bg-brand-500 transition-colors">Explore Data</button></div>`;
  }
  const priorities = variableDefs.map(v => ({ key: v.key, name: v.name, percentile: user[v.key] != null ? M.percentile(user[v.key], vals(v.key)) : 50, higherIsBetter: v.higherIsBetter, icon: v.icon })).filter(v => v.higherIsBetter !== null).sort((a, b) => { const aScore = a.higherIsBetter ? a.percentile : 100 - a.percentile; const bScore = b.higherIsBetter ? b.percentile : 100 - b.percentile; return aScore - bScore; }).slice(0, 5);
  const pa = document.getElementById('priorityActions');
  if (pa) {
    pa.innerHTML = priorities.map(p => {
      const isLow = p.higherIsBetter ? p.percentile < 50 : p.percentile > 50;
      const action = p.higherIsBetter ? (p.percentile < 30 ? 'Critical gap -- prioritize' : p.percentile < 50 ? 'Below average -- improve' : 'Solid foundation') : (p.percentile > 70 ? 'Critical risk -- reduce' : p.percentile > 50 ? 'Above average risk -- monitor' : 'Manageable level');
      return `<div class="flex items-center gap-3 p-3 rounded-lg ${isLow ? 'glass-risk' : 'glass-success'}"><i data-lucide="${p.icon}" class="w-4 h-4 ${isLow ? 'text-red-400' : 'text-emerald-400'}"></i><div class="flex-1"><div class="text-xs font-medium text-white">${p.name}: ${p.percentile.toFixed(0)}th percentile</div><div class="text-[0.65rem] text-slate-400">${action}</div></div></div>`;
    }).join('');
  }
  lucide.createIcons();
}

// === OUTLIERS ===
function renderOutliers() {
  const outliers = findOutliers();
  const cont = document.getElementById('outlierList'); if (!cont) return;
  cont.innerHTML = outliers.slice(0, 12).map((o, i) => `
    <div class="insight-card glass-light rounded-xl p-4 fade-in" style="animation-delay:${i * 0.05}s">
      <div class="flex items-center gap-3 mb-3"><div class="w-10 h-10 rounded-lg bg-amber-500/15 flex items-center justify-center"><i data-lucide="alert-circle" class="w-5 h-5 text-amber-400"></i></div><div><div class="text-sm font-bold text-white">${o.country}</div><div class="text-[0.65rem] text-amber-400">${o.deviations.length} anomalous metric${o.deviations.length > 1 ? 's' : ''}</div></div></div>
      <div class="flex flex-wrap gap-2 mb-3">${o.deviations.slice(0, 3).map(d => `<span class="text-[0.65rem] px-2 py-0.5 rounded-full ${d.z > 0 ? 'bg-brand-500/15 text-brand-300' : 'bg-rose-500/15 text-rose-300'}">${d.name}: ${d.z > 0 ? '+' : ''}${d.z.toFixed(1)}σ</span>`).join('')}</div>
      <div class="text-xs text-slate-400 leading-relaxed">${getOutlierExplanation(o.country, o.deviations)}</div>
    </div>
  `).join(''); lucide.createIcons();
}
function findOutliers() {
  const outliers = [];
  const keys = variableDefs.map(v => v.key);
  for (let k of keys) {
    const arr = vals(k); if (arr.length < 5) continue;
    const m = M.mean(arr), s = M.std(arr); if (s === 0) continue;
    for (let d of dataset) {
      if (d[k] == null) continue;
      const z = (d[k] - m) / s;
      if (Math.abs(z) > CONFIG.outlierZScore) {
        const existing = outliers.find(o => o.country === d.country);
        const vdef = variableDefs.find(v => v.key === k);
        if (existing) { existing.deviations.push({ key: k, z, name: vdef.name, value: d[k] }); }
        else { outliers.push({ country: d.country, deviations: [{ key: k, z, name: vdef.name, value: d[k] }] }); }
      }
    }
  }
  return outliers.map(o => ({ ...o, deviations: o.deviations.sort((a, b) => Math.abs(b.z) - Math.abs(a.z)) })).sort((a, b) => Math.abs(b.deviations[0].z) - Math.abs(a.deviations[0].z));
}
function getOutlierExplanation(country, deviations) {
  const top = deviations[0]; const v = variableDefs.find(x => x.key === top.key); if (!v) return '';
  const direction = top.z > 0 ? 'much higher' : 'much lower';
  let explanation = `${country} is ${direction} than expected in ${v.name} (${top.value.toFixed(1)} ${v.unit}). `;
  if (country === 'United States' && top.key === 'health_expenditure_pct_gdp') explanation += 'Despite high spending, outcomes lag.';
  else if (top.key === 'co2_per_capita' && top.z > 0) explanation += 'High carbon intensity signals fossil fuel dependency.';
  else if (top.key === 'gini_index' && top.z > 0) explanation += 'Extreme inequality erodes social cohesion.';
  else if (top.key === 'intentional_homicides' && top.z > 0) explanation += 'Elevated violence signals social stress.';
  else if (top.key === 'women_in_parliament' && top.z < 0) explanation += 'Low female political representation limits policy diversity.';
  else if (top.key === 'internet_users_pct' && top.z < 0) explanation += 'Low connectivity limits economic opportunity.';
  else explanation += 'Investigate whether driven by policy, geography, culture, or data anomaly.';
  return explanation;
}

// === SIMULATOR ===
function initSimulatorUI() {
  const sel = document.getElementById('simVariable'); if (!sel) return;
  sel.innerHTML = variableDefs.map(v => `<option value="${v.key}">${v.name}</option>`).join('');
  initSimulator();
}
function initSimulator() {
  const sel = document.getElementById('simVariable'); if (!sel) return;
  const key = sel.value; const v = variableDefs.find(x => x.key === key); if (!v) return;
  const values = vals(key); const mean = M.mean(values);
  document.getElementById('simLabel').textContent = v.name;
  document.getElementById('simSlider').value = 0;
  document.getElementById('simValue').textContent = '0% change (from ' + mean.toFixed(1) + ')';
  runSimulation(0);
}
function runSimulation(pctChange) {
  const sel = document.getElementById('simVariable'); if (!sel) return;
  const key = sel.value; const v = variableDefs.find(x => x.key === key); if (!v) return;
  const values = vals(key); const mean = M.mean(values);
  const newValue = mean * (1 + pctChange / 100);
  document.getElementById('simValue').textContent = (pctChange >= 0 ? '+' : '') + pctChange + '% (' + newValue.toFixed(1) + ')';
  const corrs = getCorrelations(key);
  const affected = corrs.filter(c => Math.abs(c.r) >= 0.3).map(c => {
    const cValues = vals(c.key); const cMean = M.mean(cValues); const projectedChange = cMean * (c.r * pctChange / 100);
    return { ...c, projected: cMean + projectedChange, delta: projectedChange };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  document.getElementById('simAffectedCount').textContent = affected.length;
  const results = document.getElementById('simResults');
  if (results) {
    results.innerHTML = affected.slice(0, 15).map(a => `
      <div class="flex items-center justify-between p-2 rounded-lg ${a.delta > 0 ? 'bg-emerald-500/8' : 'bg-rose-500/8'}">
        <div class="flex items-center gap-2"><i data-lucide="${a.icon}" class="w-3.5 h-3.5 text-slate-500"></i><span class="text-xs text-slate-300">${a.name}</span></div>
        <div class="text-xs font-mono ${a.delta > 0 ? 'text-emerald-300' : 'text-rose-300'}">${a.delta > 0 ? '+' : ''}${a.delta.toFixed(1)} (${(a.r * 100).toFixed(0)}% correlation)</div>
      </div>
    `).join(''); lucide.createIcons();
  }
  renderSimChart(v, affected.slice(0, 10));
}
function renderSimChart(v, affected) {
  if (charts.simChart) charts.simChart.destroy();
  const el = document.getElementById('simChart'); if (!el) return;
  charts.simChart = new Chart(el, {
    type: 'bar', data: { labels: affected.map(a => a.name.slice(0, 20)), datasets: [{ label: 'Projected Change', data: affected.map(a => a.delta), backgroundColor: affected.map(a => a.delta >= 0 ? 'rgba(34,211,238,0.4)' : 'rgba(244,63,94,0.4)'), borderColor: affected.map(a => a.delta >= 0 ? 'rgba(34,211,238,0.7)' : 'rgba(244,63,94,0.7)'), borderWidth: 1, borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { color: 'rgba(148,163,184,0.05)' }, ticks: { color: '#64748b', font: { size: 9 }, maxRotation: 45 } }, y: { grid: { color: 'rgba(148,163,184,0.05)' }, ticks: { color: '#64748b', font: { size: 10 } } } } }
  });
}

// === GEM DISCOVERY ===
function renderGemDiscovery() {
  const cont = document.getElementById('gemList'); if (!cont) return;
  const gems = findHiddenGems();
  cont.innerHTML = gems.slice(0, 15).map((g, i) => `
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
  `).join(''); lucide.createIcons();
}
function findHiddenGems() {
  const gems = [];
  for (let i = 0; i < variableDefs.length; i++) {
    for (let j = i + 1; j < variableDefs.length; j++) {
      const v1 = variableDefs[i], v2 = variableDefs[j];
      if (v1.category === v2.category) continue;
      const r = M.pearson(vals(v1.key), vals(v2.key));
      if (Math.abs(r) < 0.3) continue;
      const expectedR = 0.1; const surprise = (Math.abs(r) - expectedR) / 0.15;
      let explanation = `A ${corrStrength(r)} ${r >= 0 ? 'positive' : 'negative'} correlation between ${v1.category.toLowerCase()} (${v1.name.toLowerCase()}) and ${v2.category.toLowerCase()} (${v2.name.toLowerCase()}). `;
      if (r >= 0.6) explanation += `This suggests ${v1.name.toLowerCase()} may be a leading indicator for ${v2.name.toLowerCase()}.`;
      else if (r <= -0.4) explanation += `This inverse relationship hints at policy trade-offs between these domains.`;
      else explanation += `While not dominant, this connection could reveal hidden structural linkages.`;
      gems.push({ v1, v2, r, surprise, explanation });
    }
  }
  return gems.sort((a, b) => b.surprise - a.surprise);
}

// === COMPARE ===
function initCompareUI() {
  const sel = document.getElementById('compareSelect'); if (!sel) return;
  sel.innerHTML = '<option value="">+ Add country...</option>' + dataset.map(d => `<option value="${d.country}">${d.country}</option>`).join('');
}
function addCompareCountry(country) {
  if (!country || compareCountries.includes(country)) return;
  compareCountries.push(country);
  renderCompareTags();
  if (compareCountries.length >= 2) renderCompareResults();
  pushURLState();
}
function removeCompareCountry(country) {
  compareCountries = compareCountries.filter(c => c !== country);
  renderCompareTags();
  if (compareCountries.length < 2) {
    document.getElementById('compareResults').classList.add('hidden');
    document.getElementById('compareEmpty').classList.remove('hidden');
  } else { renderCompareResults(); }
  pushURLState();
}
function renderCompareTags() {
  const cont = document.getElementById('compareTags'); if (!cont) return;
  cont.innerHTML = compareCountries.map(c => `
    <span class="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-brand-500/15 text-brand-300 text-xs border border-brand-500/20">
      ${c}<button onclick="removeCompareCountry('${c}')" class="ml-1 hover:text-white"><i data-lucide="x" class="w-3 h-3"></i></button>
    </span>
  `).join(''); lucide.createIcons();
}
function renderCompareResults() {
  if (compareCountries.length < 2) return;
  document.getElementById('compareResults').classList.remove('hidden');
  document.getElementById('compareEmpty').classList.add('hidden');
  const n = Math.min(8, variableDefs.length);
  const vars = variableDefs.slice(0, n);
  const colors = ['#22d3ee', '#f59e0b', '#f43f5e', '#a78bfa', '#34d399'];
  const radarCanvas = document.getElementById('compareRadarCanvas');
  if (radarCanvas) {
    const rect = radarCanvas.parentElement.getBoundingClientRect();
    if (rect.width >= 10 && rect.height >= 10) {
      radarCanvas.width = rect.width * 2; radarCanvas.height = rect.height * 2;
      radarCanvas.style.width = rect.width + 'px'; radarCanvas.style.height = rect.height + 'px';
      const ctx = radarCanvas.getContext('2d'); ctx.scale(2, 2);
      const w = rect.width, h = rect.height, cx = w / 2, cy = h / 2, rad = Math.min(cx, cy) - 40;
      ctx.clearRect(0, 0, w, h);
      for (let i = 1; i <= 5; i++) { ctx.beginPath(); ctx.arc(cx, cy, rad * i / 5, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(148,163,184,0.1)'; ctx.lineWidth = 1; ctx.stroke(); }
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + i * (2 * Math.PI) / n;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad); ctx.strokeStyle = 'rgba(148,163,184,0.1)'; ctx.stroke();
        ctx.fillStyle = '#94a3b8'; ctx.font = '500 8px Inter'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(vars[i].name.slice(0, 10), cx + Math.cos(a) * (rad + 16), cy + Math.sin(a) * (rad + 16));
      }
      compareCountries.forEach((cname, ci) => {
        const country = dataset.find(d => d.country === cname);
        const pts = vars.map((v, i) => {
          const a = -Math.PI / 2 + i * (2 * Math.PI) / n;
          const arr = vals(v.key); const norm = country && country[v.key] != null ? M.normalize(country[v.key], arr) : 0;
          return { x: cx + Math.cos(a) * rad * norm, y: cy + Math.sin(a) * rad * norm };
        });
        ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y)); ctx.closePath();
        ctx.fillStyle = colors[ci % colors.length] + '12'; ctx.fill(); ctx.strokeStyle = colors[ci % colors.length]; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = colors[ci % colors.length]; ctx.font = '500 10px Inter'; ctx.textAlign = 'left'; ctx.fillText(cname, 15, 18 + ci * 16);
      });
    }
  }
  const table = document.getElementById('compareTable');
  if (table) {
    const keys = variableDefs.slice(0, 12).map(v => v.key);
    let html = '<table class="text-xs w-full"><thead><tr class="border-b border-slate-700/50">';
    html += '<th class="px-2 py-2 text-left text-slate-400 font-medium">Indicator</th>';
    compareCountries.forEach(c => { html += `<th class="px-2 py-2 text-right text-slate-400 font-medium">${c}</th>`; });
    html += '</tr></thead><tbody>';
    variableDefs.slice(0, 12).forEach(v => {
      html += '<tr class="border-t border-slate-800/30">';
      html += `<td class="px-2 py-1.5 text-slate-300">${v.name}</td>`;
      compareCountries.forEach(cname => {
        const d = dataset.find(x => x.country === cname);
        const val = d && d[v.key] != null ? d[v.key].toFixed(1) : '-';
        html += `<td class="px-2 py-1.5 text-right text-white font-mono">${val}</td>`;
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    table.innerHTML = html;
  }
  const diffCanvas = document.getElementById('compareHeatmapCanvas');
  if (diffCanvas) {
    const keys = variableDefs.slice(0, 15).map(v => v.key);
    const cellSize = 36, padding = 100;
    const width = compareCountries.length * cellSize + padding;
    const height = keys.length * cellSize + 30;
    diffCanvas.width = width * 2; diffCanvas.height = height * 2;
    diffCanvas.style.width = width + 'px'; diffCanvas.style.height = height + 'px';
    const ctx = diffCanvas.getContext('2d'); ctx.scale(2, 2);
    ctx.clearRect(0, 0, width, height);
    const maxVal = dataset.map(d => keys.map(k => d[k] || 0).filter(v => v != null)).flat();
    const globalMax = Math.max(...maxVal) || 1;
    keys.forEach((k, i) => {
      const v = variableDefs.find(x => x.key === k);
      compareCountries.forEach((c, j) => {
        const d = dataset.find(x => x.country === c);
        const val = d && d[k] != null ? d[k] : 0;
        const intensity = val / globalMax;
        ctx.fillStyle = `hsla(190, 80%, 50%, ${0.05 + intensity * 0.5})`;
        ctx.fillRect(padding + j * cellSize, i * cellSize, cellSize - 1, cellSize - 1);
        if (intensity > 0.3) { ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '400 8px Inter'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(val.toFixed(0), padding + j * cellSize + cellSize / 2, i * cellSize + cellSize / 2); }
      });
      ctx.fillStyle = '#94a3b8'; ctx.font = '400 9px Inter'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(v.name.slice(0, 22), padding - 6, i * cellSize + cellSize / 2);
    });
    compareCountries.forEach((c, j) => {
      ctx.fillStyle = '#94a3b8'; ctx.font = '500 9px Inter'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(c, padding + j * cellSize + cellSize / 2, height - 4);
    });
  }
}

// === EXPORT ===
function exportInsights(format) {
  if (!selectedVar) { showStatus('Select a variable first', 100); return; }
  const v = variableDefs.find(d => d.key === selectedVar);
  const corrs = getCorrelations(selectedVar);
  if (format === 'txt') {
    let text = `Insight Engine — Analysis Report\n${'='.repeat(50)}\n\nSelected: ${v.name} (${v.category})\n${v.desc}\nMean: ${M.mean(vals(selectedVar)).toFixed(2)} | Std: ${M.std(vals(selectedVar)).toFixed(2)}\n\nCorrelations:\n${'-'.repeat(50)}\n`;
    corrs.forEach((c, i) => { text += `${i + 1}. ${c.name} (r=${c.r >= 0 ? '+' : ''}${c.r.toFixed(3)}) — ${corrStrength(c.r)}\n`; });
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `insight-${v.key}-report.txt`; a.click();
  } else if (format === 'csv') {
    let csv = 'Variable,Correlation,Strength,Category\n';
    corrs.forEach(c => { csv += `"${c.name}",${c.r.toFixed(4)},"${corrStrength(c.r)}","${c.category}"\n`; });
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `insight-${v.key}-correlations.csv`; a.click();
  } else if (format === 'png') {
    ['distributionChart', 'scatterChart', 'networkCanvas', 'heatmapCanvas'].forEach(id => {
      const canvas = document.getElementById(id); if (!canvas) return;
      const a = document.createElement('a'); a.href = canvas.toDataURL('image/png'); a.download = `insight-${v.key}-${id}.png`; a.click();
    });
  }
  document.getElementById('exportMenu').classList.remove('show');
}

// === MODALS & UTILS ===
function showDatasetModal() {
  const modal = document.getElementById('datasetModal'); if (!modal) return;
  modal.classList.remove('hidden'); modal.classList.add('flex');
  const keys = ['country', 'region', 'income', ...variableDefs.map(v => v.key)];
  const thead = document.getElementById('datasetThead');
  if (thead) thead.innerHTML = '<tr class="border-b border-slate-700/50">' + keys.map(k => { const v = k === 'country' ? { name: 'Country' } : k === 'region' ? { name: 'Region' } : k === 'income' ? { name: 'Income' } : variableDefs.find(d => d.key === k); return `<th class="px-2 py-2 text-left text-slate-400 font-medium">${v ? v.name : k}</th>`; }).join('') + '</tr>';
  const tbody = document.getElementById('datasetTbody');
  if (tbody) tbody.innerHTML = dataset.map(d => '<tr class="border-t border-slate-800/30 hover:bg-slate-800/20">' + keys.map(k => { const val = d[k]; return `<td class="px-2 py-1.5 text-slate-300 ${k === 'country' ? 'font-medium text-white' : ''}">${typeof val === 'number' ? (val >= 1000 ? val.toLocaleString(undefined, { maximumFractionDigits: 0 }) : val.toFixed(1)) : val || '-'}</td>`; }).join('') + '</tr>').join('');
}
function closeDatasetModal() { const modal = document.getElementById('datasetModal'); if (!modal) return; modal.classList.add('hidden'); modal.classList.remove('flex'); }
function handleFileUpload(event) {
  const file = event.target.files[0]; if (!file) return;
  showStatus('Reading file...', 30); const reader = new FileReader();
  reader.onload = function (e) {
    try {
      let data; if (file.name.endsWith('.json')) data = JSON.parse(e.target.result); else if (file.name.endsWith('.csv')) data = parseCSV(e.target.result); else { showStatus('Use .json or .csv', 100); return; }
      loadCustomDataset(data); showStatus(`Loaded ${data.length} records`, 100);
    } catch (err) { showStatus('Error: ' + err.message, 100); }
  }; reader.readAsText(file);
}
function parseCSV(text) {
  const lines = text.trim().split('\n'); const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => { const obj = {}; const values = line.split(','); headers.forEach((h, i) => { const val = values[i] ? values[i].trim().replace(/^"|"$/g, '') : ''; obj[h] = isNaN(val) || val === '' ? val : parseFloat(val); }); return obj; });
}
function loadCustomDataset(data) {
  if (!Array.isArray(data) || data.length === 0) return;
  DATASET.length = 0; data.forEach(d => DATASET.push(d));
  const keys = Object.keys(data[0]).filter(k => k !== 'country');
  VARIABLE_DEFS.length = 0; keys.forEach(k => { VARIABLE_DEFS.push({ key: k, name: k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()), unit: 'units', category: 'Custom', desc: 'User-uploaded', icon: 'circle', higherIsBetter: null }); });
  init();
}
window.addEventListener('resize', () => { if (selectedVar) { const corrs = getCorrelations(selectedVar); const v = variableDefs.find(d => d.key === selectedVar); } });
document.addEventListener('DOMContentLoaded', init);
// Force deploy Fri May  8 07:19:24 UTC 2026

// Deploy timestamp: Fri May  8 07:21:55 UTC 2026
// force deploy 1778227178
