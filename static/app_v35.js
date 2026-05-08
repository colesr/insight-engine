// === app_v35.js — Bootstrap that loads v34 + coastline patch ===
(function() {
  // Paths relative to the static mount point
  var base = '/static';
  var SCRIPTS = [
    base + '/app_v34.js',
    base + '/globe_patch.js'
  ];
  
  console.log('app_v35: booting, loading ' + SCRIPTS.length + ' scripts...');
  
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
  
  function loadAll(idx) {
    if (idx >= SCRIPTS.length) {
      console.log('app_v35: all scripts loaded');
      return;
    }
    loadScript(SCRIPTS[idx], function(ok) {
      loadAll(idx + 1);
    });
  }
  
  loadAll(0);
})();
