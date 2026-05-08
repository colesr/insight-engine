// Globe patch — adds real coastline texture from Natural Earth GeoJSON
// Monkey-patches initGlobe to add a GeoJSON texture overlay

(function() {
  var _pollCount = 0;
  var _maxPolls = 200; // ~10 seconds at 50ms

  function pollForInitGlobe() {
    _pollCount++;
    if (window.initGlobe) {
      console.log('globe_patch: found initGlobe, patching...');
      patchInitGlobe();
    } else if (_pollCount < _maxPolls) {
      setTimeout(pollForInitGlobe, 50);
    } else {
      console.warn('globe_patch: initGlobe not found after ' + _maxPolls + ' polls, giving up');
    }
  }

  function patchInitGlobe() {
    var originalInitGlobe = window.initGlobe;
    
    window.initGlobe = function() {
      // Call original first
      if (originalInitGlobe) originalInitGlobe();
      
      // Then add coastline overlay
      addRealCoastlines();
    };
  }
  
  function addRealCoastlines() {
    if (!window.globeGroup) return;
    
    fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_coastline.geojson')
      .then(function(resp) {
        if (!resp.ok) throw new Error('Failed to fetch coastline data');
        return resp.json();
      })
      .then(function(data) {
        // Create canvas texture
        var W = 2048, H = 1024;
        var canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);
        
        // Draw coastlines in warm gold
        ctx.strokeStyle = 'rgba(255, 248, 231, 0.75)';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        var features = data.features || [];
        for (var i = 0; i < features.length; i++) {
          var geom = features[i].geometry;
          if (!geom) continue;
          
          if (geom.type === 'LineString') {
            drawLine(ctx, geom.coordinates, W, H);
          } else if (geom.type === 'MultiLineString') {
            for (var j = 0; j < geom.coordinates.length; j++) {
              drawLine(ctx, geom.coordinates[j], W, H);
            }
          }
        }
        
        // Create texture and overlay sphere
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
        console.log('globe_patch: coastline overlay added');
      })
      .catch(function(e) {
        console.error('globe_patch: coastline load failed:', e);
      });
  }
  
  function drawLine(ctx, coords, W, H) {
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

  // Start polling for initGlobe
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pollForInitGlobe);
  } else {
    pollForInitGlobe();
  }
})();
