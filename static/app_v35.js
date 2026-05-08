// === app_v35.js — Bootstrap that loads the main app + coastline patch ===
(function() {
  var base = '/static';
  // Try v32 first (158KB - likely before the syntax error was introduced)
  // Fall back to v33 (162KB) if v32 doesn't work
  var primaryVersion = base + '/app_v32.js';
  var fallbackVersion = base + '/app_v33.js';
  var patchScript = base + '/globe_patch.js';
  
  console.log('app_v35: booting, trying v32...');
  
  function loadScript(src, callback) {
    var s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = function() { console.log('app_v35: loaded ' + src); callback(true); };
    s.onerror = function() { 
      console.warn('app_v35: failed to load ' + src); 
      callback(false); 
    };
    document.head.appendChild(s);
  }
  
  loadScript(primaryVersion, function(ok) {
    if (!ok) {
      console.log('app_v35: v32 failed, trying v33...');
      loadScript(fallbackVersion, function(ok2) {
        if (!ok2) {
          console.error('app_v35: all app versions failed!');
        }
        // Load patch regardless
        loadScript(patchScript, function() {
          console.log('app_v35: patch loaded');
        });
      });
    } else {
      // Load patch after app
      loadScript(patchScript, function() {
        console.log('app_v35: all done');
      });
    }
  });
})();
