// === app_v35.js — Bootstrap that loads v34 + coastline patch ===
(function() {
  var SCRIPTS = [
    '/app_v34.js',      // Main application
    '/globe_patch.js'   // Coastline overlay patch
  ];
  
  var loaded = 0;
  function onLoad() {
    loaded++;
    if (loaded === SCRIPTS.length) {
      console.log('app_v35: all scripts loaded');
    }
  }
  
  SCRIPTS.forEach(function(src) {
    var s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = onLoad;
    s.onerror = function() {
      console.warn('app_v35: failed to load ' + src);
      onLoad(); // Don't block
    };
    document.head.appendChild(s);
  });
})();
