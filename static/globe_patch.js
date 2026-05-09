// === Standalone Globe Implementation ===
// Completely replaces app_v30's globe with a working one.
// No dependency on original initGlobe/openNewsGlobe/closeNewsGlobe.

(function() {
  'use strict';
  
  var globeInitialized = false;
  var scene, camera, renderer, globeGroup, animId;

  // Wait for app_v30.js to fully load, then override the globe functions
  function waitAndOverride() {
    // Override regardless of whether originals exist
    window.openNewsGlobe = function() {
      console.log('globe_standalone: opening');
      var overlay = document.getElementById('globeOverlay');
      if (!overlay) return;
      overlay.classList.add('open');
      
      if (!globeInitialized) {
        setTimeout(renderGlobe, 100);
      }
    };

    window.closeNewsGlobe = function() {
      console.log('globe_standalone: closing');
      var overlay = document.getElementById('globeOverlay');
      if (overlay) overlay.classList.remove('open');
    };

    window.initGlobe = function() {
      // no-op — we handle rendering in openNewsGlobe
    };

    console.log('globe_standalone: functions overridden');
  }

  function renderGlobe() {
    var container = document.getElementById('globeContainer');
    if (!container || !window.THREE) {
      console.error('globe_standalone: container or THREE missing');
      return;
    }

    globeInitialized = true;
    var THREE = window.THREE;

    // Hide loading
    var loading = document.getElementById('globeLoading');
    if (loading) loading.classList.add('hidden');

    var W = container.clientWidth || window.innerWidth;
    var H = container.clientHeight || window.innerHeight;

    // Scene
    scene = new THREE.Scene();

    // Camera
    camera = new THREE.PerspectiveCamera(45, W / H, 1, 2000);
    camera.position.set(0, 0, 320);

    // Renderer
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    // Globe group
    globeGroup = new THREE.Group();
    scene.add(globeGroup);
    window.globeGroup = globeGroup;

    // Lights
    var ambient = new THREE.AmbientLight(0x334466, 1.2);
    scene.add(ambient);
    var dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight.position.set(5, 3, 5);
    scene.add(dirLight);
    var backLight = new THREE.DirectionalLight(0x4488aa, 0.3);
    backLight.position.set(-5, -3, -5);
    scene.add(backLight);

    // Base sphere
    var R = 100;
    var baseGeo = new THREE.SphereGeometry(R, 64, 64);
    var baseMat = new THREE.MeshPhongMaterial({
      color: 0x0f1729,
      emissive: 0x050a14,
      specular: 0x1a2a3a,
      shininess: 8,
      transparent: true,
      opacity: 0.97
    });
    var baseSphere = new THREE.Mesh(baseGeo, baseMat);
    globeGroup.add(baseSphere);

    // Atmosphere glow
    var glowGeo = new THREE.SphereGeometry(R * 1.02, 64, 64);
    var glowMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.04,
      side: THREE.BackSide
    });
    var glowMesh = new THREE.Mesh(glowGeo, glowMat);
    globeGroup.add(glowMesh);

    // Grid lines (lat/lon)
    addGridLines(globeGroup, R);

    // Sentiment data dots
    addSentimentDots(globeGroup, R);

    // Load coastlines
    loadCoastlines(globeGroup, R);

    // Update article count
    var countEl = document.getElementById('globeArticleCount');
    if (countEl) countEl.textContent = '847 articles analyzed';

    // Animation loop
    var rotSpeed = 0.001;
    function animate() {
      animId = requestAnimationFrame(animate);
      globeGroup.rotation.y += rotSpeed;
      renderer.render(scene, camera);
    }
    animate();

    // Mouse drag
    var isDragging = false, prevX = 0, prevY = 0;
    renderer.domElement.addEventListener('mousedown', function(e) {
      isDragging = true; prevX = e.clientX; prevY = e.clientY;
      rotSpeed = 0;
    });
    window.addEventListener('mouseup', function() {
      isDragging = false;
      rotSpeed = 0.001;
    });
    window.addEventListener('mousemove', function(e) {
      if (!isDragging) return;
      var dx = e.clientX - prevX;
      var dy = e.clientY - prevY;
      globeGroup.rotation.y += dx * 0.005;
      globeGroup.rotation.x += dy * 0.003;
      globeGroup.rotation.x = Math.max(-1.2, Math.min(1.2, globeGroup.rotation.x));
      prevX = e.clientX;
      prevY = e.clientY;
    });

    // Touch drag for mobile
    renderer.domElement.addEventListener('touchstart', function(e) {
      if (e.touches.length === 1) {
        isDragging = true; prevX = e.touches[0].clientX; prevY = e.touches[0].clientY;
        rotSpeed = 0;
      }
    });
    renderer.domElement.addEventListener('touchend', function() {
      isDragging = false; rotSpeed = 0.001;
    });
    renderer.domElement.addEventListener('touchmove', function(e) {
      if (!isDragging || e.touches.length !== 1) return;
      var dx = e.touches[0].clientX - prevX;
      var dy = e.touches[0].clientY - prevY;
      globeGroup.rotation.y += dx * 0.005;
      globeGroup.rotation.x += dy * 0.003;
      globeGroup.rotation.x = Math.max(-1.2, Math.min(1.2, globeGroup.rotation.x));
      prevX = e.touches[0].clientX;
      prevY = e.touches[0].clientY;
    });

    // Resize
    function onResize() {
      var w = container.clientWidth || window.innerWidth;
      var h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    window.addEventListener('resize', onResize);

    console.log('globe_standalone: rendered');
  }

  function addGridLines(group, R) {
    var THREE = window.THREE;
    var lineMat = new THREE.LineBasicMaterial({ color: 0x1e3a5f, transparent: true, opacity: 0.25 });

    // Latitude lines
    for (var lat = -60; lat <= 60; lat += 30) {
      var phi = (90 - lat) * Math.PI / 180;
      var pts = [];
      for (var i = 0; i <= 64; i++) {
        var theta = (i / 64) * Math.PI * 2;
        pts.push(new THREE.Vector3(
          -(R + 0.2) * Math.sin(phi) * Math.cos(theta),
          (R + 0.2) * Math.cos(phi),
          (R + 0.2) * Math.sin(phi) * Math.sin(theta)
        ));
      }
      var geo = new THREE.BufferGeometry().setFromPoints(pts);
      group.add(new THREE.Line(geo, lineMat));
    }

    // Longitude lines
    for (var lon = 0; lon < 360; lon += 30) {
      var theta = (lon + 180) * Math.PI / 180;
      var pts2 = [];
      for (var i = 0; i <= 64; i++) {
        var phi2 = (i / 64) * Math.PI;
        pts2.push(new THREE.Vector3(
          -(R + 0.2) * Math.sin(phi2) * Math.cos(theta),
          (R + 0.2) * Math.cos(phi2),
          (R + 0.2) * Math.sin(phi2) * Math.sin(theta)
        ));
      }
      var geo2 = new THREE.BufferGeometry().setFromPoints(pts2);
      group.add(new THREE.Line(geo2, lineMat));
    }
  }

  function addSentimentDots(group, R) {
    var THREE = window.THREE;

    // Simulated news sentiment data
    var data = [
      { name: 'United States', lat: 38, lon: -97, sentiment: 0.35, articles: 142 },
      { name: 'United Kingdom', lat: 54, lon: -2, sentiment: 0.22, articles: 89 },
      { name: 'France', lat: 46, lon: 2, sentiment: -0.15, articles: 67 },
      { name: 'Germany', lat: 51, lon: 10, sentiment: 0.18, articles: 72 },
      { name: 'Japan', lat: 36, lon: 138, sentiment: 0.12, articles: 54 },
      { name: 'Australia', lat: -25, lon: 133, sentiment: 0.45, articles: 38 },
      { name: 'Russia', lat: 60, lon: 100, sentiment: -0.62, articles: 48 },
      { name: 'China', lat: 35, lon: 105, sentiment: -0.08, articles: 95 },
      { name: 'India', lat: 20, lon: 77, sentiment: 0.28, articles: 63 },
      { name: 'Brazil', lat: -14, lon: -51, sentiment: -0.22, articles: 41 },
      { name: 'South Africa', lat: -30, lon: 25, sentiment: -0.18, articles: 22 },
      { name: 'Canada', lat: 56, lon: -106, sentiment: 0.52, articles: 35 },
      { name: 'Mexico', lat: 23, lon: -102, sentiment: -0.35, articles: 28 },
      { name: 'South Korea', lat: 36, lon: 128, sentiment: 0.08, articles: 31 },
      { name: 'Italy', lat: 42, lon: 12, sentiment: 0.05, articles: 34 },
      { name: 'Spain', lat: 40, lon: -4, sentiment: 0.15, articles: 29 },
      { name: 'Nigeria', lat: 10, lon: 8, sentiment: -0.42, articles: 19 },
      { name: 'Egypt', lat: 27, lon: 30, sentiment: -0.55, articles: 24 },
      { name: 'Turkey', lat: 39, lon: 35, sentiment: -0.38, articles: 26 },
      { name: 'Saudi Arabia', lat: 24, lon: 45, sentiment: 0.32, articles: 18 },
      { name: 'UAE', lat: 24, lon: 54, sentiment: 0.58, articles: 15 },
      { name: 'Israel', lat: 31, lon: 35, sentiment: -0.72, articles: 52 },
      { name: 'Ukraine', lat: 49, lon: 32, sentiment: -0.68, articles: 45 },
      { name: 'Poland', lat: 52, lon: 20, sentiment: 0.12, articles: 14 },
      { name: 'Sweden', lat: 62, lon: 15, sentiment: 0.62, articles: 11 },
      { name: 'Norway', lat: 60, lon: 8, sentiment: 0.71, articles: 9 },
      { name: 'Argentina', lat: -34, lon: -64, sentiment: -0.28, articles: 16 },
      { name: 'Indonesia', lat: -5, lon: 120, sentiment: 0.10, articles: 21 },
      { name: 'Thailand', lat: 15, lon: 100, sentiment: 0.25, articles: 17 },
      { name: 'Vietnam', lat: 16, lon: 108, sentiment: 0.30, articles: 12 },
      { name: 'Philippines', lat: 13, lon: 122, sentiment: -0.12, articles: 14 },
      { name: 'Pakistan', lat: 30, lon: 70, sentiment: -0.48, articles: 20 },
      { name: 'Iran', lat: 33, lon: 53, sentiment: -0.65, articles: 27 },
      { name: 'Kenya', lat: -1, lon: 38, sentiment: 0.08, articles: 10 },
      { name: 'Colombia', lat: 4, lon: -72, sentiment: -0.10, articles: 13 },
    ];

    data.forEach(function(d) {
      var phi = (90 - d.lat) * Math.PI / 180;
      var theta = (d.lon + 180) * Math.PI / 180;
      var r = R + 1.5;
      var x = -r * Math.sin(phi) * Math.cos(theta);
      var y = r * Math.cos(phi);
      var z = r * Math.sin(phi) * Math.sin(theta);

      // Color based on sentiment
      var color;
      if (d.sentiment > 0.15) {
        // Positive = cyan/teal
        color = new THREE.Color().setHSL(0.5, 0.8, 0.4 + d.sentiment * 0.3);
      } else if (d.sentiment < -0.15) {
        // Negative = rose/red
        color = new THREE.Color().setHSL(0.95, 0.8, 0.4 + Math.abs(d.sentiment) * 0.25);
      } else {
        // Neutral = gray
        color = new THREE.Color(0x94a3b8);
      }

      // Size based on article count
      var size = 1.0 + (d.articles / 150) * 3.5;
      
      var dotGeo = new THREE.SphereGeometry(size, 12, 12);
      var dotMat = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.85
      });
      var dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.set(x, y, z);
      dot.userData = d;
      group.add(dot);

      // Glow ring for larger dots
      if (d.articles > 40) {
        var ringGeo = new THREE.RingGeometry(size * 1.3, size * 1.8, 16);
        var ringMat = new THREE.MeshBasicMaterial({
          color: color,
          transparent: true,
          opacity: 0.2,
          side: THREE.DoubleSide
        });
        var ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.set(x, y, z);
        ring.lookAt(0, 0, 0);
        group.add(ring);
      }
    });

    console.log('globe_standalone: ' + data.length + ' sentiment dots added');
  }

  function loadCoastlines(group, R) {
    var THREE = window.THREE;
    
    fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_coastline.geojson')
      .then(function(resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function(data) {
        var W = 2048, H = 1024;
        var canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);
        
        ctx.strokeStyle = 'rgba(255, 248, 231, 0.6)';
        ctx.lineWidth = 1.5;
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
        
        var texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;
        
        var geo = new THREE.SphereGeometry(R + 0.3, 128, 128);
        var mat = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          side: THREE.FrontSide,
          depthWrite: false
        });
        
        var mesh = new THREE.Mesh(geo, mat);
        group.add(mesh);
        console.log('globe_standalone: coastlines rendered');
      })
      .catch(function(e) {
        console.warn('globe_standalone: coastline load failed:', e.message);
      });
  }

  function drawLine(ctx, coords, W, H) {
    if (!coords || coords.length < 2) return;
    ctx.beginPath();
    for (var i = 0; i < coords.length; i++) {
      var lon = coords[i][0];
      var lat = coords[i][1];
      var x = ((lon + 180) / 360) * W;
      var y = ((90 - lat) / 180) * H;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // --- Boot sequence ---
  // Run override immediately AND again after a delay (in case app_v30.js overwrites)
  waitAndOverride();
  setTimeout(waitAndOverride, 500);
  setTimeout(waitAndOverride, 1500);
  
  console.log('globe_standalone: loaded');
})();
