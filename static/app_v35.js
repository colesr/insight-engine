// === app_v35.js — Bootstrap that loads the main app + coastline patch ===
(function() {
  var base = '/static';
  // Load order: dataset, app, patch
  var SCRIPTS = [
    base + '/dataset_embed.js',   // Embedded dataset (needed for fallback)
    base + '/app_v31.js',         // Main application v31 (154.9KB)
    base + '/globe_patch.js'      // Coastline overlay patch
  ];
  
  console.log('app_v35: booting, loading ' + SCRIPTS.length + ' scripts...');
  
  function loadScript(src, callback) {
    var s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = function() { console.log('app_v35: OK  ' + src); callback(true); };
    s.onerror = function() { 
      console.warn('app_v35: FAIL ' + src); 
      callback(false); 
    };
    document.head.appendChild(s);
  }
  
  function loadAll(idx) {
    if (idx >= SCRIPTS.length) {
      console.log('app_v35: all scripts loaded');
      return;
    }
    var src = SCRIPTS[idx];
    loadScript(src, function(ok) {
      if (!ok && idx === 1) {
        // v31 failed, try v30
        console.log('app_v35: v31 failed, trying v30...');
        loadScript(base + '/app_v30.js', function(ok2) {
          if (ok2) console.log('app_v35: v30 loaded as fallback');
          // Continue to patch regardless
          loadAll(idx + 1);
        });
      } else {
        loadAll(idx + 1);
      }
    });
  }
  
  loadAll(0);
})();
