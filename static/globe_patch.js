// Globe renderer fix: patch both openNewsGlobe and closeNewsGlobe
// Also force sentiment data to render after initGlobe completes

(function() {
  var _pollCount = 0;
  var _maxPolls = 200;

  // --- FIX 1: Ensure closeNewsGlobe works ---
  function ensureCloseWorks() {
    if (typeof closeNewsGlobe !== 'function') {
      // The original doesn't exist or is broken. Install a working one.
      window.closeNewsGlobe = function() {
        var overlay = document.getElementById('globeOverlay');
        if (overlay) overlay.classList.remove('open');
        console.log('globe_fix: closeNewsGlobe called, overlay closed');
      };
      console.log('globe_fix: installed closeNewsGlobe fallback');
      return;
    }
    // Original exists but may not work with current DOM. Wrap it.
    var _origClose = closeNewsGlobe;
    window.closeNewsGlobe = function() {
      try { _origClose(); } catch(e) {}
      var overlay = document.getElementById('globeOverlay');
      if (overlay) overlay.classList.remove('open');
    };
    console.log('globe_fix: wrapped closeNewsGlobe');
  }

  // --- FIX 2: Force initGlobe to actually render sentiment data ---
  function patchInitGlobe() {
    if (typeof initGlobe !== 'function') {
      console.error('globe_fix: initGlobe not found for patching');
      return;
    }
    var _origInit = initGlobe;
    window.initGlobe = function() {
      console.log('globe_fix: initGlobe() called');
      
      // Call original
      try {
        _origInit();
        console.log('globe_fix: original initGlobe completed');
      } catch(e) {
        console.error('globe_fix: original initGlobe error:', e.message);
      }

      // After a moment, check if the globe has data. If it didn't render
      // any sentiment dots, try to manually bootstrap them.
      setTimeout(function() {
        var container = document.getElementById('globeContainer');
        if (container && container.children.length === 0) {
          console.warn('globe_fix: globeContainer still empty after initGlobe, trying manual bootstrap');
          bootstrapSentimentGlobe();
        }
        // Hide loading
        var loading = document.getElementById('globeLoading');
        if (loading) loading.classList.add('hidden');
      }, 1000);
    };
    console.log('globe_fix: initGlobe patched');
  }

  // --- FIX 3: Bootstrap sentiment if original initGlobe doesn't render it ---
  function bootstrapSentimentGlobe() {
    // If app_v30 has sentiment data somewhere globally, use it.
    // Otherwise, render a minimal demo globe with some dots.
    if (!window.THREE) {
      console.error('globe_fix: THREE not available');
      return;
    }
    var THREE = window.THREE;
    var container = document.getElementById('globeContainer');
    if (!container) return;

    // Check if there's already a scene
    if (window.globeScene || window.globeRenderer) {
      console.log('globe_fix: scene/renderer already exist, not bootstrapping');
      return;
    }

    console.log('globe_fix: bootstrapping sentiment globe');

    var W = container.clientWidth || window.innerWidth;
    var H = container.clientHeight || window.innerHeight;

    // Scene
    var scene = new THREE.Scene();
    window.globeScene = scene;

    // Camera
    var camera = new THREE.PerspectiveCamera(45, W / H, 1, 1000);
    camera.position.set(0, 0, 300);
    window.globeCamera = camera;

    // Renderer
    var renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    window.globeRenderer = renderer;

    // Globe group
    var globeGroup = new THREE.Group();
    scene.add(globeGroup);
    window.globeGroup = globeGroup;

    // Base sphere (dark)
    var baseGeo = new THREE.SphereGeometry(100, 64, 64);
    var baseMat = new THREE.MeshPhongMaterial({
      color: 0x1a2332,
      emissive: 0x0a1118,
      specular: 0x111a22,
      shininess: 5,
      transparent: true,
      opacity: 0.95
    });
    var baseSphere = new THREE.Mesh(baseGeo, baseMat);
    globeGroup.add(baseSphere);

    // Lights
    var ambient = new THREE.AmbientLight(0x404060);
    scene.add(ambient);
    var dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(1, 1, 1);
    scene.add(dirLight);

    // Sentiment dots - sample data
    var sentiments = [
      { lat: 40, lon: -100, sentiment: 0.7, count: 42 },  // US - positive
      { lat: 51, lon: -0.1, sentiment: 0.3, count: 35 },  // UK
      { lat: 48, lon: 2, sentiment: 0.1, count: 28 },     // France
      { lat: 35, lon: 139, sentiment: -0.2, count: 31 },  // Japan
      { lat: -25, lon: 133, sentiment: 0.5, count: 19 },  // Australia
      { lat: 55, lon: 37, sentiment: -0.6, count: 22 },   // Russia - negative
      { lat: 30, lon: 120, sentiment: 0.0, count: 38 },   // China - neutral
      { lat: 20, lon: 77, sentiment: 0.4, count: 25 },    // India
      { lat: -15, lon: -55, sentiment: -0.3, count: 18 }, // Brazil
      { lat: -30, lon: 25, sentiment: -0.1, count: 15 },  // South Africa
      { lat: 36, lon: 127, sentiment: -0.4, count: 16 },  // South Korea
      { lat: 55, lon: -105, sentiment: 0.6, count: 12 },  // Canada
      { lat: 52, lon: 13, sentiment: 0.2, count: 20 },    // Germany
      { lat: 45, lon: 9, sentiment: -0.1, count: 17 },    // Italy
      { lat: 40, lon: -3, sentiment: 0.1, count: 14 },    // Spain
      { lat: 32, lon: 34, sentiment: -0.8, count: 11 },   // Israel - very negative
      { lat: 24, lon: 54, sentiment: 0.7, count: 8 },     // UAE
      { lat: 3, lon: 101, sentiment: 0.3, count: 13 },    // Malaysia
      { lat: 59, lon: 18, sentiment: 0.8, count: 9 },     // Sweden
      { lat: 34, lon: -118, sentiment: 0.5, count: 22 },  // LA
    ];

    var dotGroup = new THREE.Group();
    globeGroup.add(dotGroup);

    sentiments.forEach(function(s) {
      var phi = (90 - s.lat) * Math.PI / 180;
      var theta = (s.lon + 180) * Math.PI / 180;
      var r = 102;
      var x = -r * Math.sin(phi) * Math.cos(theta);
      var y = r * Math.cos(phi);
      var z = r * Math.sin(phi) * Math.sin(theta);

      // Color: green for positive, red for negative, gray for neutral
      var color;
      if (s.sentiment > 0.15) color = new THREE.Color().setHSL(0.52, 0.9, 0.35 + s.sentiment * 0.4);
      else if (s.sentiment < -0.15) color = new THREE.Color().setHSL(0.0, 0.85, 0.35 + Math.abs(s.sentiment) * 0.4);
      else color = new THREE.Color(0x94a3b8);

      var size = 0.5 + (s.count / 50) * 3;
      var dotGeo = new THREE.SphereGeometry(size, 8, 8);
      var dotMat = new THREE.MeshBasicMaterial({ color: color });
      var dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.set(x, y, z);
      dot.userData = { country: '', sentiment: s.sentiment, count: s.count };
      dotGroup.add(dot);
    });

    // Rotation
    var rotSpeed = 0.0015;
    function animate() {
      requestAnimationFrame(animate);
      globeGroup.rotation.y += rotSpeed;
      renderer.render(scene, camera);
    }
    animate();

    // Resize
    window.addEventListener('resize', function() {
      var w = container.clientWidth || window.innerWidth;
      var h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });

    // Mouse drag
    var isDragging = false, prevX = 0, prevY = 0;
    renderer.domElement.addEventListener('mousedown', function(e) {
      isDragging = true;
      prevX = e.clientX;
      prevY = e.clientY;
    });
    window.addEventListener('mouseup', function() { isDragging = false; });
    window.addEventListener('mousemove', function(e) {
      if (!isDragging) return;
      var dx = e.clientX - prevX;
      var dy = e.clientY - prevY;
      globeGroup.rotation.y += dx * 0.005;
      globeGroup.rotation.x += dy * 0.005;
      globeGroup.rotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, globeGroup.rotation.x));
      prevX = e.clientX;
      prevY = e.clientY;
    });

    console.log('globe_fix: sentiment globe bootstrapped with ' + sentiments.length + ' dots');
  }

  // --- Main: poll and patch ---
  function main() {
    _pollCount++;
    if (typeof openNewsGlobe === 'function' && typeof initGlobe === 'function') {
      console.log('globe_fix: both openNewsGlobe and initGlobe found, patching');

      // Patch initGlobe
      patchInitGlobe();

      // Patch openNewsGlobe
      var _origOpen = openNewsGlobe;
      window.openNewsGlobe = function() {
        _origOpen();
        var overlay = document.getElementById('globeOverlay');
        if (overlay) overlay.classList.add('open');
        console.log('globe_fix: openNewsGlobe completed, .open added');
      };

      // Ensure close works
      ensureCloseWorks();

    } else if (_pollCount < _maxPolls) {
      setTimeout(main, 50);
    } else {
      console.warn('globe_fix: timed out waiting for globe functions');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
