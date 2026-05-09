// === app_v35.js — Bootstrap: loads scripts synchronously, then calls init() ===
// This is loaded from index.html. It loads dataset_embed.js, app_v30.js, globe_patch.js
// in order, then calls init() once everything is ready.

(function() {
  var base = '/static';
  var SCRIPTS = [
    base + '/dataset_embed.js',   // Embedded dataset (196KB)
    base + '/app_v30.js',         // Main application v30 (154.6KB)
    base + '/globe_patch.js'      // Coastline overlay patch
  ];
  
  console.log('app_v35: booting, loading ' + SCRIPTS.length + ' scripts...');
  
  function loadScript(src, callback) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = function() {
      console.log('app_v35: OK  ' + src);
      callback(true);
    };
    s.onerror = function() { 
      console.warn('app_v35: FAIL ' + src); 
      callback(false);
    };
    document.head.appendChild(s);
  }
  
  function loadAll(idx) {
    if (idx >= SCRIPTS.length) {
      console.log('app_v35: all scripts loaded, calling init()');
      // Now call init() if it exists, with a brief delay for script evaluation
      setTimeout(function() {
        if (typeof init === 'function') {
          init();
        } else {
          console.error('app_v35: init() not found after loading all scripts!');
          // Fallback: try loadDefaultDataset directly
          if (typeof loadDefaultDataset === 'function') {
            loadDefaultDataset();
          }
        }
        // Also wire up dismissLanding for landing page buttons
        if (typeof dismissLanding !== 'function') {
          console.warn('app_v35: dismissLanding not defined, landing buttons may not work');
        }
        if (typeof lucide !== 'undefined') {
          lucide.createIcons();
        }
      }, 100);
      return;
    }
    loadScript(SCRIPTS[idx], function(ok) {
      if (!ok && idx === 1) {
        // app_v30.js failed, try app_v31.js as fallback
        console.log('app_v35: v30 failed, trying v31...');
        loadScript(base + '/app_v31.js', function(ok2) {
          if (ok2) console.log('app_v35: v31 loaded as fallback');
          else console.error('app_v35: both v30 and v31 failed!');
          loadAll(idx + 1);
        });
      } else {
        loadAll(idx + 1);
      }
    });
  }
  
  // Start loading immediately
  loadAll(0);

  // Also wire up dismissLanding immediately for early clicks
  // (before scripts load, store clicks and replay them)
  var pendingClicks = [];
  window.dismissLanding = function(datasetId) {
    if (typeof dismissLanding === 'function') {
      // Real function exists, call it
      window._realDismissLanding(datasetId);
    } else {
      // Not loaded yet, queue the click
      pendingClicks.push(datasetId);
    }
  };
  
  // After scripts load, replay pending clicks
  var origOnload = window.onload;
  window.addEventListener('load', function() {
    setTimeout(function() {
      if (typeof dismissLanding === 'function' && pendingClicks.length > 0) {
        window._realDismissLanding = dismissLanding;
        pendingClicks.forEach(function(id) { dismissLanding(id); });
        pendingClicks = [];
      }
    }, 500);
  });

})();
