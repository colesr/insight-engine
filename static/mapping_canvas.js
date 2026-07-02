// === Mapping Canvas — sandbox mind-map ===
// Loaded after app_v30.js + globe_patch.js. Overrides the stub mapping functions
// in app_v30.js with a complete implementation: double-click add, drag, edit,
// #tag parsing, connections, pan, localStorage persistence, and a shareToMapping
// API that other parts of the platform call from "Share to Mapping" buttons.

(function() {
  'use strict';

  // ---- Storage keys (kept compatible with old app_v30 keys for migration) ----
  var STORAGE_CARDS = 'gie-mapping-cards';
  var STORAGE_CONN  = 'gie-mapping-connections';
  var STORAGE_PAN   = 'gie-mapping-pan';

  // ---- State ----
  var cards = readJSON(STORAGE_CARDS, []);
  var connections = readJSON(STORAGE_CONN, []);
  var pan = readJSON(STORAGE_PAN, { x: 0, y: 0 });

  // Migrate legacy cards (old shape used `text` field, no body/tags/sourceType)
  cards.forEach(function(c) {
    if (c.text != null && c.body == null) c.body = c.text;
    if (c.body == null) c.body = '';
    if (!c.tags) c.tags = parseTags(c.body);
    if (!c.id) c.id = makeId();
    if (!c.color) c.color = '#06b6d4';
    if (!c.title) c.title = '';
    if (!c.sourceType) c.sourceType = 'manual';
  });

  // ---- Interaction state ----
  var dragState = null;       // { id, startX, startY, origX, origY }
  var panState = null;        // { startX, startY, origPanX, origPanY }
  var connectFrom = null;     // id of source card while wiring a connection
  var connectTimer = null;

  // ===== Helpers =====
  function readJSON(key, fallback) {
    try {
      var v = JSON.parse(localStorage.getItem(key) || 'null');
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_CARDS, JSON.stringify(cards));
      localStorage.setItem(STORAGE_CONN, JSON.stringify(connections));
      localStorage.setItem(STORAGE_PAN, JSON.stringify(pan));
    } catch (e) { /* quota? ignore */ }
  }

  function parseTags(text) {
    if (!text) return [];
    var matches = String(text).match(/#[A-Za-z][A-Za-z0-9_-]*/g) || [];
    var lower = matches.map(function(m) { return m.slice(1).toLowerCase(); });
    var seen = {};
    var out = [];
    lower.forEach(function(t) { if (!seen[t]) { seen[t] = true; out.push(t); } });
    return out;
  }

  function makeId() {
    return 'card_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function $(id) { return document.getElementById(id); }

  // ===== Rendering =====
  function render() {
    renderCards();
    renderLines();
    var hint = $('mappingEmptyHint');
    if (hint) hint.classList.toggle('hidden', cards.length > 0);
    var count = $('mappingCardCount');
    if (count) count.textContent = cards.length + ' card' + (cards.length === 1 ? '' : 's');
    applyPanTransform();
  }

  function renderCards() {
    var c = $('mappingCardsContainer');
    if (!c) return;
    c.innerHTML = cards.map(function(card) {
      var titleStr = card.title ? escapeHtml(card.title) : '&nbsp;';
      var tagsHtml = (card.tags && card.tags.length)
        ? '<div class="mapping-card-tags">' + card.tags.map(function(t) { return '<span class="mapping-tag">#' + escapeHtml(t) + '</span>'; }).join('') + '</div>'
        : '';
      return '<div class="mapping-card" id="' + card.id + '" style="left:' + card.x + 'px;top:' + card.y + 'px;border-left-color:' + escapeHtml(card.color) + '" data-id="' + card.id + '">' +
        '<div class="mapping-card-header">' +
          '<div class="mapping-card-title">' + titleStr + '</div>' +
          '<div class="mapping-card-actions">' +
            '<button class="mapping-card-action connect" title="Connect to another card (click here, then click target)"><i data-lucide="link-2" class="w-3 h-3"></i></button>' +
            '<button class="mapping-card-action delete" title="Delete card"><i data-lucide="x" class="w-3 h-3"></i></button>' +
          '</div>' +
        '</div>' +
        '<div class="mapping-card-body" contenteditable="true" spellcheck="false" data-placeholder="Type here…">' + escapeHtml(card.body) + '</div>' +
        tagsHtml +
      '</div>';
    }).join('');
    if (window.lucide && typeof lucide.createIcons === 'function') try { lucide.createIcons(); } catch (e) {}
  }

  function renderLines() {
    var svg = $('mappingLines');
    if (!svg) return;
    var defs = '<defs><marker id="mappingArrow" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto"><path d="M0,0 L9,3.5 L0,7 L2.5,3.5 Z" fill="rgba(34,211,238,0.6)"/></marker></defs>';
    var paths = '';
    var pos = {};
    cards.forEach(function(card) {
      var el = document.getElementById(card.id);
      if (el) {
        pos[card.id] = {
          cx: card.x + el.offsetWidth / 2,
          cy: card.y + el.offsetHeight / 2,
          w: el.offsetWidth,
          h: el.offsetHeight
        };
      }
    });
    connections.forEach(function(conn) {
      var a = pos[conn.from];
      var b = pos[conn.to];
      if (!a || !b) return;
      var dx = b.cx - a.cx;
      var dy = b.cy - a.cy;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var offset = Math.min(70, dist * 0.3);
      paths += '<path d="M' + a.cx + ',' + a.cy +
        ' C' + (a.cx + offset) + ',' + a.cy +
        ' ' + (b.cx - offset) + ',' + b.cy +
        ' ' + b.cx + ',' + b.cy +
        '" stroke="rgba(34,211,238,0.5)" stroke-width="1.5" fill="none" stroke-dasharray="5 4" marker-end="url(#mappingArrow)" />';
    });
    svg.innerHTML = defs + paths;
  }

  function applyPanTransform() {
    var vp = $('mappingViewport');
    if (vp) vp.style.transform = 'translate(' + pan.x + 'px,' + pan.y + 'px)';
  }

  // ===== Mutators =====
  function addCard(opts) {
    opts = opts || {};
    var canvas = $('mappingCanvas');
    var rect = canvas ? canvas.getBoundingClientRect() : { width: 800, height: 500 };
    var x = (opts.x != null) ? opts.x : (rect.width / 2 - 100 - pan.x + (Math.random() - 0.5) * 80);
    var y = (opts.y != null) ? opts.y : (rect.height / 2 - 40 - pan.y + (Math.random() - 0.5) * 80);
    var body = opts.body != null ? opts.body : '';
    var parsedTags = parseTags(body);
    var extraTags = (opts.tags || []).map(function(t) { return String(t).toLowerCase().replace(/^#/, ''); });
    var merged = parsedTags.concat(extraTags);
    var seen = {};
    var tags = [];
    merged.forEach(function(t) { if (t && !seen[t]) { seen[t] = true; tags.push(t); } });
    var card = {
      id: makeId(),
      x: x, y: y,
      title: opts.title || '',
      body: body,
      tags: tags,
      color: opts.color || '#06b6d4',
      sourceType: opts.sourceType || 'manual'
    };
    cards.push(card);
    save();
    render();
    return card;
  }

  function deleteCard(id) {
    cards = cards.filter(function(c) { return c.id !== id; });
    connections = connections.filter(function(c) { return c.from !== id && c.to !== id; });
    save();
    render();
  }

  function clearAll() {
    if (cards.length === 0 && connections.length === 0) return;
    if (!confirm('Clear ' + cards.length + ' card(s) and ' + connections.length + ' connection(s)?')) return;
    cards = [];
    connections = [];
    pan = { x: 0, y: 0 };
    save();
    render();
  }

  function fit() {
    var canvas = $('mappingCanvas');
    if (!canvas || cards.length === 0) {
      if (pan.x !== 0 || pan.y !== 0) {
        pan = { x: 0, y: 0 };
        applyPanTransform();
        save();
      }
      return;
    }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    cards.forEach(function(c) {
      var el = document.getElementById(c.id);
      var w = el ? el.offsetWidth : 200;
      var h = el ? el.offsetHeight : 80;
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + w);
      maxY = Math.max(maxY, c.y + h);
    });
    var rect = canvas.getBoundingClientRect();
    var cx = (minX + maxX) / 2;
    var cy = (minY + maxY) / 2;
    var newX = rect.width / 2 - cx;
    var newY = rect.height / 2 - cy;
    if (pan.x !== newX || pan.y !== newY) {
      pan.x = newX;
      pan.y = newY;
      applyPanTransform();
      save();
    }
  }

  // ===== Events =====
  function getCanvasPos(e) {
    var canvas = $('mappingCanvas');
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onCanvasMouseDown(e) {
    var canvas = $('mappingCanvas');
    if (!canvas) return;
    if (e.target.closest('.mapping-card-action')) return; // handled by click
    var cardEl = e.target.closest('.mapping-card');
    var pos = getCanvasPos(e);
    if (cardEl) {
      var id = cardEl.getAttribute('data-id');
      if (connectFrom) {
        completeConnect(id);
        e.preventDefault();
        return;
      }
      // If clicking inside the body, leave it alone (editing)
      if (e.target.classList.contains('mapping-card-body')) return;
      var card = cards.find(function(c) { return c.id === id; });
      if (!card) return;
      dragState = {
        id: id,
        startX: pos.x, startY: pos.y,
        origX: card.x, origY: card.y
      };
      cardEl.classList.add('dragging');
      e.preventDefault();
      return;
    }
    // Empty space
    if (connectFrom) {
      cancelConnect();
      return;
    }
    panState = { startX: pos.x, startY: pos.y, origPanX: pan.x, origPanY: pan.y };
    canvas.classList.add('panning');
    e.preventDefault();
  }

  function onDocMouseMove(e) {
    if (!dragState && !panState) return;
    var pos = getCanvasPos(e);
    if (dragState) {
      var card = cards.find(function(c) { return c.id === dragState.id; });
      if (!card) return;
      card.x = dragState.origX + (pos.x - dragState.startX);
      card.y = dragState.origY + (pos.y - dragState.startY);
      var el = document.getElementById(dragState.id);
      if (el) { el.style.left = card.x + 'px'; el.style.top = card.y + 'px'; }
      renderLines();
    } else if (panState) {
      pan.x = panState.origPanX + (pos.x - panState.startX);
      pan.y = panState.origPanY + (pos.y - panState.startY);
      applyPanTransform();
    }
  }

  function onDocMouseUp() {
    if (dragState) {
      var el = document.getElementById(dragState.id);
      if (el) el.classList.remove('dragging');
      save();
      dragState = null;
    }
    if (panState) {
      var canvas = $('mappingCanvas');
      if (canvas) canvas.classList.remove('panning');
      save();
      panState = null;
    }
  }

  function onCanvasDoubleClick(e) {
    if (e.target.closest('.mapping-card')) return; // double-click on card → ignore (let body editing flow)
    var pos = getCanvasPos(e);
    var card = addCard({
      x: pos.x - pan.x - 85,
      y: pos.y - pan.y - 22,
      body: '',
      sourceType: 'manual'
    });
    // Focus body for typing
    setTimeout(function() {
      var el = document.getElementById(card.id);
      if (!el) return;
      var body = el.querySelector('.mapping-card-body');
      if (body) body.focus();
    }, 30);
  }

  function onCanvasClick(e) {
    var btn = e.target.closest('.mapping-card-action');
    if (!btn) return;
    var cardEl = btn.closest('.mapping-card');
    if (!cardEl) return;
    var id = cardEl.getAttribute('data-id');
    if (btn.classList.contains('delete')) {
      deleteCard(id);
    } else if (btn.classList.contains('connect')) {
      startConnect(id);
    }
    e.stopPropagation();
    e.preventDefault();
  }

  function onCanvasBlur(e) {
    if (!e.target.classList.contains('mapping-card-body')) return;
    var cardEl = e.target.closest('.mapping-card');
    if (!cardEl) return;
    var id = cardEl.getAttribute('data-id');
    var card = cards.find(function(c) { return c.id === id; });
    if (!card) return;
    var newBody = e.target.innerText;
    if (newBody === card.body) return;
    card.body = newBody;
    card.tags = parseTags(newBody);
    save();
    render();
  }

  function startConnect(fromId) {
    if (connectFrom === fromId) { cancelConnect(); return; }
    cancelConnect();
    connectFrom = fromId;
    var canvas = $('mappingCanvas');
    if (canvas) canvas.classList.add('connecting');
    var el = document.getElementById(fromId);
    if (el) el.classList.add('connection-source');
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = setTimeout(function() {
      if (connectFrom) cancelConnect();
    }, 10000);
  }

  function completeConnect(toId) {
    if (!connectFrom) return;
    if (connectFrom !== toId) {
      var exists = connections.find(function(c) { return c.from === connectFrom && c.to === toId; });
      if (!exists) {
        connections.push({ from: connectFrom, to: toId });
        save();
      }
    }
    cancelConnect();
    render();
  }

  function cancelConnect() {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    if (connectFrom) {
      var el = document.getElementById(connectFrom);
      if (el) el.classList.remove('connection-source');
    }
    var canvas = $('mappingCanvas');
    if (canvas) canvas.classList.remove('connecting');
    connectFrom = null;
  }

  // ===== Init =====
  function init() {
    var canvas = $('mappingCanvas');
    if (!canvas) return false;
    if (canvas._mappingWired) return true;
    canvas._mappingWired = true;
    canvas.addEventListener('mousedown', onCanvasMouseDown);
    canvas.addEventListener('dblclick', onCanvasDoubleClick);
    canvas.addEventListener('click', onCanvasClick);
    canvas.addEventListener('blur', onCanvasBlur, true);
    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);
    render();
    return true;
  }

  // ===== Public API (overrides app_v30 stubs) =====
  window.initMapping = function() { init(); };
  window.renderMappingCards = function() { renderCards(); renderLines(); };
  window.renderMappingLines = renderLines;
  window.mappingFit = fit;
  window.mappingClearAll = clearAll;

  // Generic share entry — called from anywhere in the app
  window.shareToMapping = function(opts) {
    opts = opts || {};
    var autoTags = [];
    if (opts.sourceType) autoTags.push(opts.sourceType);
    opts.tags = (opts.tags || []).concat(autoTags);
    var card = addCard(opts);
    showShareToast(opts.title || opts.sourceType || 'Card');
    return card;
  };

  // URI-encoded JSON variant so inline onclick attributes never struggle with quote escaping
  window.shareToMappingURI = function(encoded) {
    try {
      var opts = JSON.parse(decodeURIComponent(encoded));
      window.shareToMapping(opts);
    } catch (e) {
      console.warn('shareToMappingURI failed:', e);
    }
  };

  function showShareToast(label) {
    var existing = document.getElementById('mappingShareToast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.id = 'mappingShareToast';
    toast.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%) translateY(20px);background:rgba(15,23,42,0.92);border:1px solid rgba(34,211,238,0.3);color:#cbd5e1;font-size:12px;padding:10px 16px;border-radius:10px;z-index:200;backdrop-filter:blur(12px);opacity:0;transition:opacity .25s,transform .25s;display:flex;align-items:center;gap:8px;pointer-events:none;box-shadow:0 8px 30px rgba(0,0,0,0.35)';
    toast.innerHTML =
      '<span style="color:#22d3ee;font-size:14px">●</span>' +
      '<span>Added <strong style="color:#67e8f9">' + escapeHtml(label) + '</strong> to Mapping</span>';
    document.body.appendChild(toast);
    requestAnimationFrame(function() {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(-50%) translateY(0)';
    });
    setTimeout(function() {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(20px)';
      setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 280);
    }, 2400);
  }

  // ===== Boot =====
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(init, 50);
  } else {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(init, 50); });
  }
  // In case the canvas DOM isn't available right away (script-order edge cases)
  var retries = 0;
  var retryId = setInterval(function() {
    if (init() || ++retries > 60) clearInterval(retryId);
  }, 250);

  console.log('mapping_canvas: module loaded (' + cards.length + ' card(s), ' + connections.length + ' connection(s) restored)');
})();
