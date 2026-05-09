// === Minimal shim: catch init() crash from runSimulation null reference ===
// The simulator tab HTML is hidden, so runSimulation can't find its DOM elements.
// This shim wraps runSimulation to silently ignore null element errors during init.

(function() {
  // Wait for app_v30.js to define these functions, then patch
  var _attempts = 0;
  function patchWhenReady() {
    _attempts++;
    if (typeof runSimulation === 'function') {
      var orig = runSimulation;
      window.runSimulation = function(val) {
        try {
          return orig(val);
        } catch(e) {
          // Silently ignore null DOM errors during init
          console.warn('runSimulation patched:', e.message);
        }
      };
      
      var origInitSim = initSimulator;
      if (typeof origInitSim === 'function') {
        window.initSimulator = function() {
          try { return origInitSim(); } 
          catch(e) { console.warn('initSimulator patched:', e.message); }
        };
      }
      
      var origInitSimUI = initSimulatorUI;
      if (typeof origInitSimUI === 'function') {
        window.initSimulatorUI = function() {
          try { return origInitSimUI(); } 
          catch(e) { console.warn('initSimulatorUI patched:', e.message); }
        };
      }
      
      console.log('shim: patched runSimulation/initSimulator/initSimulatorUI');
    } else if (_attempts < 100) {
      setTimeout(patchWhenReady, 30);
    }
  }
  patchWhenReady();
})();
