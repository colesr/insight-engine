// === app_v35.js — Bootstrap that loads the main app + coastline patch ===
(function() {
  var base = '/static';
  // Try v31 first (154.9KB), fall back to v30 (154.6KB)
  var primaryVersion = base + '/app_v31.js';
  var fallbackVersion = base + '/app_v30.js';
  var patchScript = base + '/globe_patch.js';
  
  console.log('app_v35: booting, trying v31...');
  
  function loadScript(src, callback) {
    var s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = function() { console.log('app_v35: loaded ' + src); callback(true); };
    s.onerror = function() { 
      console.warn('app_v35: failed ' + src); 
      callback(false); 
    };
    document.head.appendChild(s);
  }
  
  function loadPatch() {
    loadScript(patchScript, function() {
      console.log('app_v35: patch loaded, all done');
    });
  }
  
  loadScript(primaryVersion, function(ok) {
    if (ok) { loadPatch(); return; }
    console.log('app_v35: v31 failed, trying v30...');
    loadScript(fallbackVersion, function(ok2) {
      if (ok2) { loadPatch(); }
      else { console.error('app_v35: all versions failed!'); }
    });
  });
})();
