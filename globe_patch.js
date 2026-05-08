// Globe patch — adds real coastline texture from Natural Earth GeoJSON
// This file is loaded AFTER app_v34.js and monkey-patches initGlobe

(function() {
  const originalInitGlobe = window.initGlobe;
  
  window.initGlobe = function() {
    // Call original first
    if (originalInitGlobe) originalInitGlobe();
    
    // Then add coastline overlay
    addRealCoastlines();
  };
  
  async function addRealCoastlines() {
    if (!window.globeGroup) return;
    
    try {
      console.log('Loading Natural Earth coastlines...');
      const resp = await fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_coastline.geojson');
      if (!resp.ok) throw new Error('Failed to fetch coastline data');
      const data = await resp.json();
      
      // Create canvas texture
      const W = 2048, H = 1024;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, W, H);
      
      // Draw coastlines in warm gold
      ctx.strokeStyle = 'rgba(255, 248, 231, 0.75)';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      
      const features = data.features || [];
      for (const feature of features) {
        const geom = feature.geometry;
        if (!geom) continue;
        
        if (geom.type === 'LineString') {
          drawLine(ctx, geom.coordinates, W, H);
        } else if (geom.type === 'MultiLineString') {
          for (const line of geom.coordinates) {
            drawLine(ctx, line, W, H);
          }
        }
      }
      
      // Create texture and overlay sphere
      const texture = new THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;
      
      const R = 100;
      const geo = new THREE.SphereGeometry(R + 0.4, 128, 128);
      const mat = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        side: THREE.FrontSide,
        depthWrite: false
      });
      
      const mesh = new THREE.Mesh(geo, mat);
      window.globeGroup.add(mesh);
      console.log('Coastline overlay added');
      
    } catch (e) {
      console.error('Coastline load failed:', e);
    }
  }
  
  function drawLine(ctx, coords, W, H) {
    if (!coords || coords.length < 2) return;
    ctx.beginPath();
    let first = true;
    for (const [lon, lat] of coords) {
      const x = ((lon + 180) / 360) * W;
      const y = ((90 - lat) / 180) * H;
      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
})();
