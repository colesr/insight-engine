// Client-side coastline texture loader — fetches Natural Earth GeoJSON and renders to canvas texture
let globeCoastlineTexture = null;
let globeCoastlineMesh = null;

async function loadCoastlineTexture() {
  if (globeCoastlineTexture) return globeCoastlineTexture;
  
  try {
    // Fetch Natural Earth 1:110m coastline GeoJSON (CORS-enabled CDN)
    const resp = await fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_coastline.geojson');
    if (!resp.ok) throw new Error('Failed to fetch coastline data');
    const data = await resp.json();
    
    // Create canvas for equirectangular texture
    const W = 2048, H = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    
    // Transparent background
    ctx.clearRect(0, 0, W, H);
    
    // Draw coastlines
    ctx.strokeStyle = 'rgba(255, 248, 231, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    const features = data.features || [];
    for (const feature of features) {
      const geom = feature.geometry;
      if (!geom) continue;
      
      if (geom.type === 'LineString') {
        drawLineString(ctx, geom.coordinates, W, H);
      } else if (geom.type === 'MultiLineString') {
        for (const line of geom.coordinates) {
          drawLineString(ctx, line, W, H);
        }
      }
    }
    
    // Create Three.js texture
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    globeCoastlineTexture = texture;
    return texture;
  } catch (e) {
    console.error('Coastline texture load failed:', e);
    return null;
  }
}

function drawLineString(ctx, coords, W, H) {
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

async function addCoastlineOverlay(radius) {
  if (!globeGroup) return;
  // Remove existing
  if (globeCoastlineMesh) {
    globeGroup.remove(globeCoastlineMesh);
    globeCoastlineMesh = null;
  }
  
  const texture = await loadCoastlineTexture();
  if (!texture) return;
  
  const geo = new THREE.SphereGeometry(radius + 0.3, 128, 128);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
    depthWrite: false
  });
  
  globeCoastlineMesh = new THREE.Mesh(geo, mat);
  globeGroup.add(globeCoastlineMesh);
}
