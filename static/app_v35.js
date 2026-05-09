// === app_v35.js — Bootstrap: dataset embed → app v30 → coastline patch ===
(function() {
  var base = '/static';
  var SCRIPTS = [
    base + '/dataset_embed.js',   // Embedded dataset (196KB)
    base + '/app_v30.js',         // App v30 (154.6KB — last known-good)
    base + '/globe_patch.js'      // Coastline overlay
  ];
  
  console.log('app_v35: booting, loading ' + SCRIPTS.length + ' scripts...');
  
  function loadScript(src, next) {
    var s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = function() { console.log('app_v35: OK  ' + src); next(); };
    s.onerror = function() { 
      console.warn('app_v35: FAIL ' + src); 
      next(); // continue anyway (degraded)
    };
    document.head.appendChild(s);
  }
  
  function loadAll(idx) {
    if (idx >= SCRIPTS.length) {
      console.log('app_v35: all scripts loaded');
      return;
    }
    loadScript(SCRIPTS[idx], function() { loadAll(idx + 1); });
  }
  
  loadAll(0);
})();
