// === Standalone Globe Implementation ===
// Completely replaces app_v30's globe with a working one.
// No dependency on original initGlobe/openNewsGlobe/closeNewsGlobe.

(function() {
  'use strict';

  var globeInitialized = false;
  var scene, camera, renderer, globeGroup, animId;

  // Enhanced-UI state
  var raycaster, mouseVec;
  var dotMeshes = [];
  var hoveredMesh = null;
  var pinnedMesh = null;
  var pings = [];
  var starGroups = [];
  var atmosphereGlow = null;
  var arcLines = [];
  var pingTimerId = null;
  var pingIdx = 0;
  var startTime = Date.now();
  var raycastFrame = 0;

  function waitAndOverride() {
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
      // Reset interactive state so reopening is clean
      hoveredMesh = null;
      pinnedMesh = null;
      var tt = document.getElementById('globeTooltip');
      if (tt) {
        tt.style.opacity = '0';
        tt.classList.remove('pinned');
      }
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
    renderer.domElement.style.cursor = 'grab';

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

    // Atmosphere glow (kept reference for shimmer animation)
    var glowGeo = new THREE.SphereGeometry(R * 1.02, 64, 64);
    var glowMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.04,
      side: THREE.BackSide
    });
    atmosphereGlow = new THREE.Mesh(glowGeo, glowMat);
    globeGroup.add(atmosphereGlow);

    // Grid lines (lat/lon)
    addGridLines(globeGroup, R);

    // Sentiment data dots (also populates dotMeshes)
    addSentimentDots(globeGroup, R);

    // Sentiment-similarity arcs (uses dotMeshes positions)
    addSentimentArcs(globeGroup, R);

    // Background starfield (added to scene, not globeGroup — doesn't rotate with globe)
    addStarfield(scene);

    // Load coastlines
    loadCoastlines(globeGroup, R);

    // Update article count
    var countEl = document.getElementById('globeArticleCount');
    if (countEl) countEl.textContent = '847 articles analyzed';

    // Raycaster for hover/click
    raycaster = new THREE.Raycaster();
    mouseVec = new THREE.Vector2(2, 2); // start outside [-1,1] so no hover until user moves mouse

    // Animation
    var rotSpeed = { v: 0.001 };
    function animate() {
      animId = requestAnimationFrame(animate);
      var t = (Date.now() - startTime) / 1000;

      globeGroup.rotation.y += rotSpeed.v;

      // Dot pulse + hover/pin scale
      for (var i = 0; i < dotMeshes.length; i++) {
        var d = dotMeshes[i];
        var ud = d.userData;
        var pulse = 1 + ud.pulseAmp * Math.sin(t * 1.6 + ud.pulsePhase);
        var hoverFactor = (d === hoveredMesh || d === pinnedMesh) ? 1.45 : 1;
        var target = pulse * hoverFactor;
        // smooth lerp toward target scale
        d.scale.x += (target - d.scale.x) * 0.2;
        d.scale.y = d.scale.x;
        d.scale.z = d.scale.x;
        if (d.material) {
          d.material.opacity = (d === hoveredMesh || d === pinnedMesh) ? 1.0 : 0.85;
        }
      }

      // Atmosphere shimmer
      if (atmosphereGlow && atmosphereGlow.material) {
        atmosphereGlow.material.opacity = 0.04 + 0.018 * Math.sin(t * 0.8);
      }

      // Starfield twinkle (4 groups out of phase)
      for (var j = 0; j < starGroups.length; j++) {
        var phase = j * 1.7;
        starGroups[j].material.opacity = 0.45 + 0.3 * Math.sin(t * (0.4 + j * 0.15) + phase);
      }

      // Sentiment arcs gentle pulse
      for (var a = 0; a < arcLines.length; a++) {
        var arc = arcLines[a];
        arc.material.opacity = arc.userData.baseOpacity + 0.05 * Math.sin(t * 0.7 + arc.userData.phase);
      }

      // Pings expand & fade
      for (var k = pings.length - 1; k >= 0; k--) {
        var p = pings[k];
        var age = t - p.startTime;
        if (age > p.duration) {
          globeGroup.remove(p.mesh);
          p.mesh.geometry.dispose();
          p.mesh.material.dispose();
          pings.splice(k, 1);
          continue;
        }
        var prog = age / p.duration;
        var s = 1 + prog * 4.5;
        p.mesh.scale.set(s, s, s);
        p.mesh.material.opacity = (1 - prog) * 0.55;
      }

      // Periodic raycast so hover stays accurate as globe spins under a still cursor
      raycastFrame = (raycastFrame + 1) % 3;
      if (raycastFrame === 0 && !isDragging) {
        updateHover();
      }

      updateTooltip();

      renderer.render(scene, camera);
    }

    // ---- Pointer interaction (mouse + touch) ----
    var isDragging = false, prevX = 0, prevY = 0, dragDelta = 0;

    function W_curr() { return container.clientWidth || window.innerWidth; }
    function H_curr() { return container.clientHeight || window.innerHeight; }

    function setMouseFromCanvas(x, y) {
      mouseVec.x = (x / W_curr()) * 2 - 1;
      mouseVec.y = -(y / H_curr()) * 2 + 1;
    }

    function updateHover() {
      if (!raycaster || !dotMeshes.length) return;
      // Skip if mouse not yet over canvas
      if (mouseVec.x < -1 || mouseVec.x > 1 || mouseVec.y < -1 || mouseVec.y > 1) {
        if (hoveredMesh) {
          hoveredMesh = null;
          renderer.domElement.style.cursor = 'grab';
        }
        return;
      }
      raycaster.setFromCamera(mouseVec, camera);
      var hits = raycaster.intersectObjects(dotMeshes);
      var newHover = hits.length > 0 ? hits[0].object : null;
      if (newHover !== hoveredMesh) {
        hoveredMesh = newHover;
        renderer.domElement.style.cursor = newHover ? 'pointer' : 'grab';
      }
    }

    function onPointerDown(x, y) {
      isDragging = true; prevX = x; prevY = y; dragDelta = 0;
      rotSpeed.v = 0;
      renderer.domElement.style.cursor = 'grabbing';
    }

    function onPointerMove(x, y) {
      setMouseFromCanvas(x, y);
      if (isDragging) {
        var dx = x - prevX;
        var dy = y - prevY;
        dragDelta += Math.abs(dx) + Math.abs(dy);
        globeGroup.rotation.y += dx * 0.005;
        globeGroup.rotation.x += dy * 0.003;
        globeGroup.rotation.x = Math.max(-1.2, Math.min(1.2, globeGroup.rotation.x));
        prevX = x; prevY = y;
      } else {
        updateHover();
      }
    }

    function onPointerUp(x, y) {
      var clickedNotDragged = isDragging && dragDelta < 6;
      isDragging = false;
      rotSpeed.v = 0.001;
      renderer.domElement.style.cursor = hoveredMesh ? 'pointer' : 'grab';
      if (clickedNotDragged) {
        setMouseFromCanvas(x, y);
        raycaster.setFromCamera(mouseVec, camera);
        var hits = raycaster.intersectObjects(dotMeshes);
        if (hits.length > 0) {
          var hit = hits[0].object;
          pinnedMesh = (pinnedMesh === hit) ? null : hit;
        } else {
          pinnedMesh = null;
        }
      }
    }

    renderer.domElement.addEventListener('mousedown', function(e) {
      var rect = renderer.domElement.getBoundingClientRect();
      onPointerDown(e.clientX - rect.left, e.clientY - rect.top);
    });
    window.addEventListener('mouseup', function(e) {
      var rect = renderer.domElement.getBoundingClientRect();
      onPointerUp(e.clientX - rect.left, e.clientY - rect.top);
    });
    window.addEventListener('mousemove', function(e) {
      var rect = renderer.domElement.getBoundingClientRect();
      onPointerMove(e.clientX - rect.left, e.clientY - rect.top);
    });

    // Touch
    renderer.domElement.addEventListener('touchstart', function(e) {
      if (e.touches.length === 1) {
        var rect = renderer.domElement.getBoundingClientRect();
        onPointerDown(e.touches[0].clientX - rect.left, e.touches[0].clientY - rect.top);
      }
    });
    renderer.domElement.addEventListener('touchend', function() {
      onPointerUp(prevX, prevY);
    });
    renderer.domElement.addEventListener('touchmove', function(e) {
      if (e.touches.length !== 1) return;
      var rect = renderer.domElement.getBoundingClientRect();
      onPointerMove(e.touches[0].clientX - rect.left, e.touches[0].clientY - rect.top);
    });

    // Resize
    function onResize() {
      var w = W_curr();
      var h = H_curr();
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    window.addEventListener('resize', onResize);

    // Start sonar-like pings on top countries
    schedulePings(R);

    animate();

    console.log('globe_standalone: rendered with enhanced UI');
  }

  // ---- Tooltip positioning + content ----
  function updateTooltip() {
    var tt = document.getElementById('globeTooltip');
    if (!tt || !camera || !globeGroup) return;
    var target = pinnedMesh || hoveredMesh;
    if (!target) {
      tt.style.opacity = '0';
      tt.classList.remove('pinned');
      return;
    }

    var THREE = window.THREE;
    var worldPos = new THREE.Vector3();
    target.getWorldPosition(worldPos);

    // Visibility: dot must be on the side of the globe facing the camera
    var camDir = camera.position.clone().sub(globeGroup.position).normalize();
    var dotDir = worldPos.clone().sub(globeGroup.position).normalize();
    var facing = dotDir.dot(camDir);

    if (facing < -0.05) {
      // Dot is on the back side of the globe: hide tooltip cleanly. Pin state persists,
      // tooltip reappears when the dot rotates back to the front.
      tt.style.opacity = '0';
      return;
    }

    var projected = worldPos.clone().project(camera);
    var sx = (projected.x * 0.5 + 0.5) * window.innerWidth;
    var sy = (-projected.y * 0.5 + 0.5) * window.innerHeight;

    tt.style.position = 'fixed';
    tt.style.left = (sx + 14) + 'px';
    tt.style.top = (sy - 8) + 'px';
    tt.style.pointerEvents = 'none';
    tt.style.zIndex = '95';
    tt.style.transition = 'opacity 0.18s ease';
    tt.style.opacity = '1';

    if (target === pinnedMesh) tt.classList.add('pinned');
    else tt.classList.remove('pinned');

    var d = target.userData;
    var country = document.getElementById('globeCountry');
    var sentEl = document.getElementById('globeSentiment');
    if (country) country.textContent = d.name;
    if (sentEl) {
      var sign = d.sentiment >= 0 ? '+' : '';
      var barW = Math.round(Math.abs(d.sentiment) * 100);
      var pinIcon = (target === pinnedMesh)
        ? '<span style="color:#22d3ee;margin-left:auto;font-size:0.75em">● pinned</span>'
        : '';
      sentEl.innerHTML =
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">' +
          '<span style="color:' + d.labelColor + ';font-weight:600">' + d.label + '</span>' +
          '<span style="color:#475569">·</span>' +
          '<span style="color:#94a3b8;font-family:JetBrains Mono,monospace">' + sign + d.sentiment.toFixed(2) + '</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:6px;font-size:0.7rem">' +
          '<span style="color:#94a3b8">' + d.articles + ' articles</span>' +
          pinIcon +
        '</div>' +
        '<div style="margin-top:6px;height:3px;border-radius:3px;background:#1e293b;overflow:hidden;width:140px;position:relative">' +
          '<div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:#334155"></div>' +
          '<div style="height:100%;width:' + (barW/2) + '%;background:' + d.labelColor + ';transition:width .25s ease;' +
                (d.sentiment >= 0 ? 'margin-left:50%' : 'margin-left:' + (50 - barW/2) + '%') +
                '"></div>' +
        '</div>';
    }
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

  function sentimentClassification(s) {
    if (s > 0.5)  return { label: 'Very Positive', color: '#22d3ee' };
    if (s > 0.15) return { label: 'Positive',      color: '#06b6d4' };
    if (s > -0.15) return { label: 'Neutral',       color: '#94a3b8' };
    if (s > -0.5) return { label: 'Negative',      color: '#f43f5e' };
    return        { label: 'Very Negative', color: '#dc2626' };
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

      var cls = sentimentClassification(d.sentiment);
      var color;
      if (d.sentiment > 0.15) {
        color = new THREE.Color().setHSL(0.5, 0.8, 0.4 + d.sentiment * 0.3);
      } else if (d.sentiment < -0.15) {
        color = new THREE.Color().setHSL(0.95, 0.8, 0.4 + Math.abs(d.sentiment) * 0.25);
      } else {
        color = new THREE.Color(0x94a3b8);
      }

      var size = 1.0 + (d.articles / 150) * 3.5;

      var dotGeo = new THREE.SphereGeometry(size, 12, 12);
      var dotMat = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.85
      });
      var dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.set(x, y, z);
      dot.userData = {
        name: d.name,
        lat: d.lat,
        lon: d.lon,
        sentiment: d.sentiment,
        articles: d.articles,
        baseSize: size,
        pulsePhase: Math.random() * Math.PI * 2,
        pulseAmp: 0.04 + (d.articles / 200) * 0.05,
        label: cls.label,
        labelColor: cls.color
      };
      group.add(dot);
      dotMeshes.push(dot);

      // Static glow ring for very active countries (kept from original)
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

  function addSentimentArcs(group, R) {
    var THREE = window.THREE;
    if (!dotMeshes.length) return;
    // Find pairs of countries with similar sentiment (same sign, small delta)
    var pairs = [];
    for (var i = 0; i < dotMeshes.length; i++) {
      for (var j = i + 1; j < dotMeshes.length; j++) {
        var s1 = dotMeshes[i].userData.sentiment;
        var s2 = dotMeshes[j].userData.sentiment;
        var delta = Math.abs(s1 - s2);
        if (delta > 0.12) continue;
        var sameSign = (s1 > 0.2 && s2 > 0.2) || (s1 < -0.2 && s2 < -0.2);
        if (!sameSign) continue;
        pairs.push({ a: dotMeshes[i], b: dotMeshes[j], delta: delta, avgSent: (s1 + s2) / 2 });
      }
    }
    pairs.sort(function(a, b) { return a.delta - b.delta; });
    pairs = pairs.slice(0, 22);

    pairs.forEach(function(pair, idx) {
      var p1 = pair.a.position.clone();
      var p2 = pair.b.position.clone();
      var mid = p1.clone().add(p2).multiplyScalar(0.5);
      var midDist = mid.length();
      if (midDist < 1) return;
      // Push midpoint outward to make the arc bend outward from globe surface
      mid.multiplyScalar((R * 1.55) / midDist);

      var pts = [];
      for (var k = 0; k <= 28; k++) {
        var t = k / 28;
        var inv = 1 - t;
        pts.push(new THREE.Vector3(
          inv * inv * p1.x + 2 * inv * t * mid.x + t * t * p2.x,
          inv * inv * p1.y + 2 * inv * t * mid.y + t * t * p2.y,
          inv * inv * p1.z + 2 * inv * t * mid.z + t * t * p2.z
        ));
      }
      var geo = new THREE.BufferGeometry().setFromPoints(pts);
      var color = pair.avgSent > 0 ? 0x22d3ee : 0xf43f5e;
      var mat = new THREE.LineBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.13
      });
      var line = new THREE.Line(geo, mat);
      line.userData = { baseOpacity: 0.13, phase: idx * 0.4 };
      group.add(line);
      arcLines.push(line);
    });

    console.log('globe_standalone: ' + arcLines.length + ' sentiment arcs added');
  }

  function addStarfield(parentScene) {
    var THREE = window.THREE;
    // 4 separate point groups so each can twinkle out of phase with the others
    for (var g = 0; g < 4; g++) {
      var verts = [];
      var STARS_PER_GROUP = 60;
      for (var i = 0; i < STARS_PER_GROUP; i++) {
        var u = Math.random();
        var v = Math.random();
        var theta = 2 * Math.PI * u;
        var phi = Math.acos(2 * v - 1);
        var r = 700 + Math.random() * 250;
        verts.push(
          r * Math.sin(phi) * Math.cos(theta),
          r * Math.sin(phi) * Math.sin(theta),
          r * Math.cos(phi)
        );
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      var mat = new THREE.PointsMaterial({
        color: g % 2 === 0 ? 0xffffff : 0xa5f3fc,
        size: 1.5,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.5
      });
      var pts = new THREE.Points(geo, mat);
      parentScene.add(pts);
      starGroups.push(pts);
    }
  }

  function schedulePings(R) {
    if (pingTimerId) clearInterval(pingTimerId);
    if (!dotMeshes.length) return;
    var sorted = dotMeshes.slice().sort(function(a, b) {
      return b.userData.articles - a.userData.articles;
    });
    var top = sorted.slice(0, 5);
    pingIdx = 0;
    pingTimerId = setInterval(function() {
      spawnPing(top[pingIdx % top.length]);
      pingIdx++;
    }, 2400);
    // Spawn one shortly after init so the feature is visible right away
    setTimeout(function() { spawnPing(top[0]); }, 700);
  }

  function spawnPing(dot) {
    if (!dot || !globeGroup) return;
    var THREE = window.THREE;
    var size = dot.userData.baseSize;
    var ringGeo = new THREE.RingGeometry(size * 1.2, size * 1.5, 28);
    var color = dot.material.color.clone();
    var ringMat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide
    });
    var ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.copy(dot.position);
    ring.lookAt(0, 0, 0);
    globeGroup.add(ring);
    pings.push({
      mesh: ring,
      startTime: (Date.now() - startTime) / 1000,
      duration: 1.6
    });
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
