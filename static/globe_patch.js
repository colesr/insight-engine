// === Globe fix: close button, loading screen, coastline overlay ===
// This runs after app_v30.js and patches all globe functions.

(function() {
  console.log('globe_fix_v3: starting');

  // --- FIX 1: Force-hide loading screen when globe renders ---
  // Watch for canvas elements added to globeContainer
  function watchForGlobeRender() {
    var container = document.getElementById('globeContainer');
    if (!container) {
      setTimeout(watchForGlobeRender, 200);
      return;
    }
    
    var observer = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].type === 'childList' && mutations[i].addedNodes.length > 0) {
          var added = mutations[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            if (added[j].tagName === 'CANVAS' || (added[j].nodeType === 1 && added[j].querySelector && added[j].querySelector('canvas'))) {
              console.log('globe_fix_v3: canvas detected, hiding loading');
              hideLoading();
              return;
            }
          }
        }
      }
    });
    
    observer.observe(container, { childList: true, subtree: true });
    
    // Also check immediately in case canvas already rendered
    setTimeout(function() {
      if (container.querySelector('canvas')) {
        console.log('globe_fix_v3: canvas already present, hiding loading');
        hideLoading();
      }
    }, 500);
    
    // Fallback: hide loading after 3 seconds no matter what
    setTimeout(function() {
      hideLoading();
    }, 3000);
  }
  
  function hideLoading() {
    var loading = document.getElementById('globeLoading');
    if (loading && !loading.classList.contains('hidden')) {
      loading.classList.add('hidden');
      console.log('globe_fix_v3: loading hidden');
    }
  }

  // --- FIX 2: Override closeNewsGlobe to work with current DOM ---
  function overrideCloseGlobe() {
    window.closeNewsGlobe = function() {
      console.log('globe_fix_v3: closeNewsGlobe called');
      var overlay = document.getElementById('globeOverlay');
      if (overlay) {
        overlay.classList.remove('open');
      }
      // Also try calling any original if it still exists
      if (window._origCloseNewsGlobe) {
        try { window._origCloseNewsGlobe(); } catch(e) {}
      }
    };
    console.log('globe_fix_v3: closeNewsGlobe overridden');
  }

  // --- FIX 3: Patch initGlobe to hide loading when done ---
  function patchInitGlobe() {
    if (typeof initGlobe !== 'function') {
      setTimeout(patchInitGlobe, 100);
      return;
    }
    
    var _origInit = initGlobe;
    window.initGlobe = function() {
      console.log('globe_fix_v3: initGlobe called');
      try {
        _origInit();
        console.log('globe_fix_v3: original initGlobe completed');
      } catch(e) {
        console.error('globe_fix_v3: initGlobe error:', e.message);
      }
      
      // Hide loading after a delay
      setTimeout(hideLoading, 1500);
      setTimeout(hideLoading, 3000);
      
      // Add real coastline overlay after original init completes
      setTimeout(addRealCoastlines, 800);
    };
    console.log('globe_fix_v3: initGlobe patched');
  }

  // --- FIX 4: Patch openNewsGlobe to add .open class ---
  function patchOpenGlobe() {
    if (typeof openNewsGlobe !== 'function') {
      setTimeout(patchOpenGlobe, 100);
      return;
    }
    
    var _origOpen = openNewsGlobe;
    window.openNewsGlobe = function() {
      console.log('globe_fix_v3: openNewsGlobe called');
      _origOpen();
      var overlay = document.getElementById('globeOverlay');
      if (overlay) {
        overlay.classList.add('open');
      }
    };
    console.log('globe_fix_v3: openNewsGlobe patched');
  }

  // --- Coastline overlay (same as before) ---
  function addRealCoastlines() {
    if (!window.globeGroup) {
      console.log('globe_fix_v3: no globeGroup for coastlines');
      return;
    }
    
    fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_coastline.geojson')
      .then(function(resp) {
        if (!resp.ok) throw new Error('Failed to fetch coastlines');
        return resp.json();
      })
      .then(function(data) {
        var W = 2048, H = 1024;
        var canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);
        
        ctx.strokeStyle = 'rgba(255, 248, 231, 0.75)';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        var features = data.features || [];
        for (var i = 0; i < features.length; i++) {
          var geom = features[i].geometry;
          if (!geom) continue;
          
          if (geom.type === 'LineString') {
            drawCoastline(ctx, geom.coordinates, W, H);
          } else if (geom.type === 'MultiLineString') {
            for (var j = 0; j < geom.coordinates.length; j++) {
              drawCoastline(ctx, geom.coordinates[j], W, H);
            }
          }
        }
        
        var texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;
        
        var R = 100;
        var geo = new THREE.SphereGeometry(R + 0.4, 128, 128);
        var mat = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          side: THREE.FrontSide,
          depthWrite: false
        });
        
        var mesh = new THREE.Mesh(geo, mat);
        window.globeGroup.add(mesh);
        console.log('globe_fix_v3: coastlines added');
      })
      .catch(function(e) {
        console.error('globe_fix_v3: coastline load failed:', e);
      });
  }
  
  function drawCoastline(ctx, coords, W, H) {
    if (!coords || coords.length < 2) return;
    ctx.beginPath();
    var first = true;
    for (var i = 0; i < coords.length; i++) {
      var lon = coords[i][0];
      var lat = coords[i][1];
      var x = ((lon + 180) / 360) * W;
      var y = ((90 - lat) / 180) * H;
      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  // --- Main: apply all fixes ---
  function main() {
    overrideCloseGlobe();
    patchInitGlobe();
    patchOpenGlobe();
    watchForGlobeRender();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      setTimeout(main, 200); // Let app_v30.js functions register first
    });
  } else {
    setTimeout(main, 200);
  }
})();
