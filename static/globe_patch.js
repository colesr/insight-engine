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
  var arcLines = [];      // global similarity arcs
  var pinnedArcs = [];    // country-focused arcs (when a dot is pinned)
  var pingTimerId = null;
  var pingIdx = 0;
  var startTime = Date.now();
  var raycastFrame = 0;
  var globeRadius = 100;

  // Time scrub state — index into timeSeries (0 = 30d ago, 29 = now)
  var currentTimeIdx = 29;
  // Category filter state
  var activeCategories = {};

  function waitAndOverride() {
    window.openNewsGlobe = function() {
      console.log('globe_standalone: opening');
      var overlay = document.getElementById('globeOverlay');
      if (!overlay) return;
      overlay.classList.add('open');

      if (!globeInitialized) {
        var statusEl = document.querySelector('#globeLoading .globe-status');
        if (statusEl) statusEl.textContent = 'Fetching live coverage from GDELT…';
        fetchGlobeData().then(function(data) {
          setTimeout(function() { renderGlobe(data); }, 50);
        });
      }
    };

    window.closeNewsGlobe = function() {
      console.log('globe_standalone: closing');
      var overlay = document.getElementById('globeOverlay');
      if (overlay) overlay.classList.remove('open');
      // Reset interactive state so reopening is clean
      hoveredMesh = null;
      pinnedMesh = null;
      closeDetailPanel();
      hideFocusedArcs();
      var tt = document.getElementById('globeTooltip');
      if (tt) {
        tt.style.opacity = '0';
        tt.classList.remove('pinned');
      }
    };

    window.initGlobe = function() {
      // no-op — we handle rendering in openNewsGlobe
    };

    // Expose interactive helpers used by inline onclick / oninput in index.html
    window.toggleGlobeCat = toggleGlobeCat;
    window.onGlobeTimeScrub = onGlobeTimeScrub;
    window.closeGlobeDetail = function() {
      closeDetailPanel();
      if (pinnedMesh) {
        pinnedMesh = null;
        hideFocusedArcs();
      }
    };

    window.shareCurrentGlobeCountry = function() {
      if (!pinnedMesh) return;
      var d = pinnedMesh.userData;
      var ts = (d.timeSeries && d.timeSeries[currentTimeIdx]) || { sentiment: d.sentiment, articles: d.articles };
      var cls = sentimentClassification(ts.sentiment);
      var topCats = Object.keys(d.categories || {})
        .map(function(k) { return { k: k, v: d.categories[k] }; })
        .sort(function(a, b) { return b.v - a.v; })
        .slice(0, 2)
        .map(function(p) { return p.k + ' ' + Math.round(p.v * 100) + '%'; })
        .join(', ');
      var topHeadline = (d.headlines && d.headlines[0]) ? d.headlines[0].title : '';
      var sign = ts.sentiment >= 0 ? '+' : '';
      var body = d.name + ': ' + cls.label.toLowerCase() + ' coverage (' + sign + ts.sentiment.toFixed(2) +
        '), ' + ts.articles + ' articles. Top mix: ' + topCats + '.' +
        (topHeadline ? ' Latest: "' + topHeadline + '"' : '');
      var slug = d.name.toLowerCase().replace(/\s+/g, '-');
      var payload = {
        sourceType: 'globe',
        title: d.name + ' — Global Trends',
        body: body,
        tags: ['globe', 'sentiment', slug],
        color: cls.color
      };
      if (typeof window.shareToMapping === 'function') {
        window.shareToMapping(payload);
      } else {
        console.warn('shareToMapping unavailable');
      }
    };

    console.log('globe_standalone: functions overridden');
  }

  function fetchGlobeData() {
    return fetch('/api/news/globe', { cache: 'no-store' })
      .then(function(resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function(data) {
        if (data && Array.isArray(data.countries) && data.countries.length) return data;
        throw new Error('empty or malformed response');
      })
      .catch(function(e) {
        console.warn('globe: live fetch failed, using offline fallback:', e && e.message);
        return { countries: FALLBACK_COUNTRIES, total_articles: 847, live_count: 0, total_count: FALLBACK_COUNTRIES.length, source: 'offline' };
      });
  }

  // Used only if /api/news/globe is unreachable (e.g. backend down).
  // Sentiment values here are in the -1..+1 range; the normalization step below
  // detects scale by absolute magnitude.
  var FALLBACK_COUNTRIES = [
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
    { name: 'Canada', lat: 56, lon: -106, sentiment: 0.52, articles: 35 },
    { name: 'Mexico', lat: 23, lon: -102, sentiment: -0.35, articles: 28 },
    { name: 'South Korea', lat: 36, lon: 128, sentiment: 0.08, articles: 31 },
    { name: 'Israel', lat: 31, lon: 35, sentiment: -0.72, articles: 52 },
    { name: 'Ukraine', lat: 49, lon: 32, sentiment: -0.68, articles: 45 }
  ];

  function articleSize(articles) {
    return 1.0 + Math.log10(Math.max(1, articles)) * 0.85;
  }
  function articlePulseAmp(articles) {
    return 0.04 + Math.min(0.06, Math.log10(Math.max(1, articles)) * 0.013);
  }

  function parseSeendateMinsAgo(seendate) {
    if (!seendate) return null;
    var m = String(seendate).match(/(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?/);
    if (!m) return null;
    try {
      var d = new Date(Date.UTC(+m[1], (+m[2]) - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
      var mins = Math.round((Date.now() - d.getTime()) / 60000);
      return mins > 0 ? mins : 1;
    } catch (e) { return null; }
  }

  function renderGlobe(globeData) {
    var container = document.getElementById('globeContainer');
    if (!container || !window.THREE) {
      console.error('globe_standalone: container or THREE missing');
      return;
    }
    globeData = globeData || { countries: FALLBACK_COUNTRIES };

    globeInitialized = true;
    var THREE = window.THREE;

    // Hide loading
    var loading = document.getElementById('globeLoading');
    if (loading) loading.classList.add('hidden');

    var W = container.clientWidth || window.innerWidth;
    var H = container.clientHeight || window.innerHeight;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, W / H, 1, 2000);
    camera.position.set(0, 0, 320);

    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    renderer.domElement.style.cursor = 'grab';

    globeGroup = new THREE.Group();
    scene.add(globeGroup);
    window.globeGroup = globeGroup;

    var ambient = new THREE.AmbientLight(0x334466, 1.2);
    scene.add(ambient);
    var dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight.position.set(5, 3, 5);
    scene.add(dirLight);
    var backLight = new THREE.DirectionalLight(0x4488aa, 0.3);
    backLight.position.set(-5, -3, -5);
    scene.add(backLight);

    var R = 100;
    globeRadius = R;
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

    var glowGeo = new THREE.SphereGeometry(R * 1.02, 64, 64);
    var glowMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.04,
      side: THREE.BackSide
    });
    atmosphereGlow = new THREE.Mesh(glowGeo, glowMat);
    globeGroup.add(atmosphereGlow);

    addGridLines(globeGroup, R);
    addSentimentDots(globeGroup, R, globeData.countries);
    addSentimentArcs(globeGroup, R);
    addStarfield(scene);
    loadCoastlines(globeGroup, R);

    var countEl = document.getElementById('globeArticleCount');
    if (countEl) {
      var total = globeData.total_articles || 0;
      var live = globeData.live_count || 0;
      var totalC = globeData.total_count || (globeData.countries || []).length;
      var fmt = total.toLocaleString();
      if (live > 0) {
        countEl.innerHTML = '<span style="color:#22d3ee">●</span> ' + fmt + ' articles · ' + live + '/' + totalC + ' live from RSS';
      } else if (globeData.source === 'offline') {
        countEl.textContent = fmt + ' articles · offline mode';
      } else {
        countEl.textContent = fmt + ' articles · simulated';
      }
    }

    raycaster = new THREE.Raycaster();
    mouseVec = new THREE.Vector2(2, 2);

    var rotSpeed = { v: 0.001 };
    function animate() {
      animId = requestAnimationFrame(animate);
      var t = (Date.now() - startTime) / 1000;

      globeGroup.rotation.y += rotSpeed.v;

      // Dot pulse + hover/pin scale + category dim
      for (var i = 0; i < dotMeshes.length; i++) {
        var d = dotMeshes[i];
        var ud = d.userData;
        var pulse = 1 + ud.pulseAmp * Math.sin(t * 1.6 + ud.pulsePhase);
        var hoverFactor = (d === hoveredMesh || d === pinnedMesh) ? 1.45 : 1;
        // sizeMult lets the time scrubber change displayed dot size relative to geometry size
        var sizeMult = ud.currentBaseSize / ud.geometryBaseSize;
        var target = pulse * hoverFactor * sizeMult;
        d.scale.x += (target - d.scale.x) * 0.2;
        d.scale.y = d.scale.x;
        d.scale.z = d.scale.x;
        if (d.material) {
          var baseOp = (d === hoveredMesh || d === pinnedMesh) ? 1.0 : 0.85;
          if (ud.catDimmed) baseOp *= 0.18;
          d.material.opacity = baseOp;
        }
      }

      // Atmosphere shimmer
      if (atmosphereGlow && atmosphereGlow.material) {
        atmosphereGlow.material.opacity = 0.04 + 0.018 * Math.sin(t * 0.8);
      }

      // Starfield twinkle
      for (var j = 0; j < starGroups.length; j++) {
        var phase = j * 1.7;
        starGroups[j].material.opacity = 0.45 + 0.3 * Math.sin(t * (0.4 + j * 0.15) + phase);
      }

      // Global similarity arcs gentle pulse
      for (var a = 0; a < arcLines.length; a++) {
        var arc = arcLines[a];
        if (arc.visible) {
          arc.material.opacity = arc.userData.baseOpacity + 0.05 * Math.sin(t * 0.7 + arc.userData.phase);
        }
      }

      // Country-focused arcs pulse (when a dot is pinned)
      for (var pa = 0; pa < pinnedArcs.length; pa++) {
        var farc = pinnedArcs[pa];
        farc.material.opacity = farc.userData.baseOpacity + 0.08 * Math.sin(t * 1.0 + farc.userData.phase);
      }

      // Pings
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

    // ---- Pointer interaction ----
    var isDragging = false, prevX = 0, prevY = 0, dragDelta = 0;

    function W_curr() { return container.clientWidth || window.innerWidth; }
    function H_curr() { return container.clientHeight || window.innerHeight; }

    function setMouseFromCanvas(x, y) {
      mouseVec.x = (x / W_curr()) * 2 - 1;
      mouseVec.y = -(y / H_curr()) * 2 + 1;
    }

    function updateHover() {
      if (!raycaster || !dotMeshes.length) return;
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
          if (pinnedMesh === hit) {
            // Toggle off
            pinnedMesh = null;
            closeDetailPanel();
            hideFocusedArcs();
          } else {
            pinnedMesh = hit;
            openDetailPanel(hit);
            showFocusedArcs(hit, globeRadius);
          }
        } else {
          if (pinnedMesh) {
            pinnedMesh = null;
            closeDetailPanel();
            hideFocusedArcs();
          }
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

    function onResize() {
      var w = W_curr();
      var h = H_curr();
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    window.addEventListener('resize', onResize);

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

    var camDir = camera.position.clone().sub(globeGroup.position).normalize();
    var dotDir = worldPos.clone().sub(globeGroup.position).normalize();
    var facing = dotDir.dot(camDir);

    if (facing < -0.05) {
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
    var ts = d.timeSeries[currentTimeIdx] || { sentiment: d.sentiment, articles: d.articles };
    var sent = ts.sentiment;
    var arts = ts.articles;
    var cls = sentimentClassification(sent);

    var country = document.getElementById('globeCountry');
    var sentEl = document.getElementById('globeSentiment');
    if (country) country.textContent = d.name;
    if (sentEl) {
      var sign = sent >= 0 ? '+' : '';
      var barW = Math.round(Math.abs(sent) * 100);
      var pinTag = (target === pinnedMesh)
        ? '<span style="color:#22d3ee;margin-left:auto;font-size:0.75em">● pinned</span>'
        : '';
      sentEl.innerHTML =
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">' +
          '<span style="color:' + cls.color + ';font-weight:600">' + cls.label + '</span>' +
          '<span style="color:#475569">·</span>' +
          '<span style="color:#94a3b8;font-family:JetBrains Mono,monospace">' + sign + sent.toFixed(2) + '</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:6px;font-size:0.7rem">' +
          '<span style="color:#94a3b8">' + arts + ' articles</span>' +
          pinTag +
        '</div>' +
        '<div style="margin-top:6px;height:3px;border-radius:3px;background:#1e293b;overflow:hidden;width:140px;position:relative">' +
          '<div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:#334155"></div>' +
          '<div style="height:100%;width:' + (barW/2) + '%;background:' + cls.color + ';transition:width .25s ease;' +
                (sent >= 0 ? 'margin-left:50%' : 'margin-left:' + (50 - barW/2) + '%') +
                '"></div>' +
        '</div>';
    }
  }

  function addGridLines(group, R) {
    var THREE = window.THREE;
    var lineMat = new THREE.LineBasicMaterial({ color: 0x1e3a5f, transparent: true, opacity: 0.25 });

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

  // Deterministic pseudo-random in [0,1] from integer seed
  function rng(seed) {
    var x = Math.sin(seed * 9999.123) * 10000;
    return x - Math.floor(x);
  }

  function synthesizeExtendedData(d, idx) {
    // Categories: distribution biased by country index, sums to 1
    var rawCats = [
      rng(idx * 7 + 1) + 0.25,
      rng(idx * 11 + 3) + 0.25,
      rng(idx * 13 + 5) + 0.15,
      rng(idx * 17 + 9) + 0.2
    ];
    // Bias: countries with strong negative sentiment get more "conflict" weight
    if (d.sentiment < -0.4) rawCats[3] += 0.6;
    var sum = rawCats.reduce(function(a, b) { return a + b; }, 0);
    var categories = {
      politics: rawCats[0] / sum,
      economy: rawCats[1] / sum,
      climate: rawCats[2] / sum,
      conflict: rawCats[3] / sum
    };

    // 30-day time series ending at current sentiment
    var timeSeries = [];
    var startSent = d.sentiment * 0.3 + (rng(idx * 31) - 0.5) * 0.4;
    var startArts = Math.max(2, Math.round(d.articles * (0.5 + rng(idx * 41) * 0.5)));
    for (var t = 0; t < 30; t++) {
      var progress = t / 29;
      // Interpolate from start to current, with noise
      var sent = startSent + (d.sentiment - startSent) * progress;
      sent += (rng(idx * 101 + t * 13) - 0.5) * 0.18;
      sent = Math.max(-1, Math.min(1, sent));
      var arts = Math.round(startArts + (d.articles - startArts) * progress + (rng(idx * 201 + t * 17) - 0.5) * d.articles * 0.2);
      arts = Math.max(1, arts);
      timeSeries.push({ sentiment: sent, articles: arts });
    }
    // Pin the most recent entry to the canonical "now" values
    timeSeries[29] = { sentiment: d.sentiment, articles: d.articles };

    // Headlines (5 per country)
    var positiveTemplates = [
      'New trade pact set to boost {country} exports',
      '{country} economy outperforms forecasts',
      'Renewable energy project launched across {country}',
      '{country} tech sector reports record growth',
      'International praise for {country} climate policy',
      'Tourism in {country} rebounds beyond pre-pandemic levels',
      'Major investment announced in {country} infrastructure'
    ];
    var negativeTemplates = [
      'Tensions rise in {country} amid escalating crisis',
      '{country} faces backlash over recent policy shift',
      'Economic concerns grow in {country}',
      'Reports of unrest emerge from {country}',
      'Trade dispute weighs on {country} markets',
      '{country} hit by extreme weather events',
      'Political deadlock continues in {country}'
    ];
    var neutralTemplates = [
      '{country} holds talks with regional partners',
      'Mixed signals from {country} central bank',
      'Researchers analyze {country} labor trends',
      '{country} reviews trade policy update',
      'Cultural exchange program continues in {country}',
      'Officials in {country} announce planning review'
    ];
    var sources = ['Reuters', 'AP', 'BBC', 'AFP', 'Bloomberg', 'WSJ', 'FT', 'Al Jazeera', 'NHK', 'DW'];

    var headlines = [];
    for (var h = 0; h < 5; h++) {
      var sentVar = (rng(idx * 50 + h * 7) - 0.5) * 0.35;
      var hSent = Math.max(-1, Math.min(1, d.sentiment + sentVar));
      var pool;
      if (hSent > 0.15) pool = positiveTemplates;
      else if (hSent < -0.15) pool = negativeTemplates;
      else pool = neutralTemplates;
      var template = pool[Math.floor(rng(idx * 60 + h * 11) * pool.length)];
      var title = template.replace('{country}', d.name);
      var source = sources[Math.floor(rng(idx * 70 + h * 13) * sources.length)];
      var minsAgo = Math.round(rng(idx * 80 + h * 17) * 480 + 5);
      headlines.push({ title: title, source: source, minsAgo: minsAgo, sentiment: hSent });
    }
    headlines.sort(function(a, b) { return a.minsAgo - b.minsAgo; });

    return { categories: categories, timeSeries: timeSeries, headlines: headlines };
  }

  function addSentimentDots(group, R, countries) {
    var THREE = window.THREE;
    var src = (countries && countries.length) ? countries : FALLBACK_COUNTRIES;
    // Normalize sentiment to -1..+1 (backend uses -80..+80, fallback uses -1..+1)
    var maxArticles = 1;
    var data = src.map(function(c) {
      var s = Number(c.sentiment) || 0;
      if (Math.abs(s) > 1.5) s = s / 80;
      s = Math.max(-1, Math.min(1, s));
      var arts = Math.max(1, Number(c.articles) || 0);
      if (arts > maxArticles) maxArticles = arts;
      return Object.assign({}, c, { sentiment: s, articles: arts });
    });

    data.forEach(function(d, idx) {
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

      var size = articleSize(d.articles);

      var dotGeo = new THREE.SphereGeometry(size, 12, 12);
      var dotMat = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.85
      });
      var dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.set(x, y, z);

      // Synthesize categories + timeSeries (still derived). Use real GDELT
      // headlines if the backend provided them; otherwise synthesize.
      var ext = synthesizeExtendedData(d, idx);
      var hasLive = Array.isArray(d.headlines) && d.headlines.length > 0;
      var headlines = ext.headlines;
      if (hasLive) {
        headlines = d.headlines.map(function(h) {
          var mins = parseSeendateMinsAgo(h.seendate);
          if (mins == null) mins = Math.round(Math.random() * 240 + 5);
          var t = Number(h.tone) || 0;
          return {
            title: String(h.title || '(untitled)').slice(0, 160),
            source: String(h.source || 'unknown'),
            minsAgo: mins,
            sentiment: Math.max(-1, Math.min(1, t / 10)),
            url: h.url || ''
          };
        }).slice(0, 5);
      }
      dot.userData = {
        name: d.name,
        lat: d.lat,
        lon: d.lon,
        sentiment: d.sentiment,
        articles: d.articles,
        geometryBaseSize: size,
        currentBaseSize: size,
        pulsePhase: Math.random() * Math.PI * 2,
        pulseAmp: articlePulseAmp(d.articles),
        label: cls.label,
        labelColor: cls.color,
        categories: ext.categories,
        timeSeries: ext.timeSeries,
        headlines: headlines,
        liveHeadlines: hasLive,
        catDimmed: false
      };
      group.add(dot);
      dotMeshes.push(dot);

      if (d.articles > maxArticles * 0.4) {
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

    var liveCount = data.filter(function(d) { return Array.isArray(d.headlines) && d.headlines.length; }).length;
    console.log('globe_standalone: ' + data.length + ' sentiment dots added (' + liveCount + ' with live headlines)');
  }

  function addSentimentArcs(group, R) {
    var THREE = window.THREE;
    if (!dotMeshes.length) return;
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
      var line = buildArc(pair.a.position, pair.b.position, R, pair.avgSent > 0 ? 0x22d3ee : 0xf43f5e, 0.13);
      line.userData = { baseOpacity: 0.13, phase: idx * 0.4 };
      group.add(line);
      arcLines.push(line);
    });

    console.log('globe_standalone: ' + arcLines.length + ' sentiment arcs added');
  }

  function buildArc(p1Vec, p2Vec, R, color, baseOpacity) {
    var THREE = window.THREE;
    var p1 = p1Vec.clone();
    var p2 = p2Vec.clone();
    var mid = p1.clone().add(p2).multiplyScalar(0.5);
    var midDist = mid.length();
    if (midDist < 1) midDist = 1;
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
    var mat = new THREE.LineBasicMaterial({
      color: color,
      transparent: true,
      opacity: baseOpacity
    });
    return new THREE.Line(geo, mat);
  }

  function showFocusedArcs(dot, R) {
    hideFocusedArcs();
    // Hide the global similarity arcs
    for (var a = 0; a < arcLines.length; a++) arcLines[a].visible = false;

    var sent = dot.userData.sentiment;
    var others = dotMeshes
      .filter(function(m) { return m !== dot; })
      .map(function(m) { return { mesh: m, delta: Math.abs(m.userData.sentiment - sent) }; })
      .sort(function(a, b) { return a.delta - b.delta; })
      .slice(0, 8);

    var color = sent > 0.15 ? 0x22d3ee : (sent < -0.15 ? 0xf43f5e : 0x94a3b8);

    others.forEach(function(o, idx) {
      var line = buildArc(dot.position, o.mesh.position, R, color, 0.4);
      line.userData = { baseOpacity: 0.4, phase: idx * 0.4 };
      globeGroup.add(line);
      pinnedArcs.push(line);
    });
  }

  function hideFocusedArcs() {
    for (var a = 0; a < arcLines.length; a++) arcLines[a].visible = true;
    for (var i = 0; i < pinnedArcs.length; i++) {
      globeGroup.remove(pinnedArcs[i]);
      pinnedArcs[i].geometry.dispose();
      pinnedArcs[i].material.dispose();
    }
    pinnedArcs = [];
  }

  function addStarfield(parentScene) {
    var THREE = window.THREE;
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
    setTimeout(function() { spawnPing(top[0]); }, 700);
  }

  function spawnPing(dot) {
    if (!dot || !globeGroup) return;
    var THREE = window.THREE;
    var size = dot.userData.geometryBaseSize;
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

  // ---- Category filter ----
  function toggleGlobeCat(cat) {
    if (activeCategories[cat]) {
      delete activeCategories[cat];
    } else {
      activeCategories[cat] = true;
    }
    // Update chip visual state
    var chips = document.querySelectorAll('.globe-cat-chip');
    chips.forEach(function(chip) {
      if (activeCategories[chip.getAttribute('data-cat')]) chip.classList.add('active');
      else chip.classList.remove('active');
    });
    applyCategoryFilter();
  }

  function applyCategoryFilter() {
    var activeKeys = Object.keys(activeCategories);
    for (var i = 0; i < dotMeshes.length; i++) {
      var ud = dotMeshes[i].userData;
      if (activeKeys.length === 0) {
        ud.catDimmed = false;
      } else {
        var maxShare = 0;
        for (var k = 0; k < activeKeys.length; k++) {
          var share = ud.categories[activeKeys[k]] || 0;
          if (share > maxShare) maxShare = share;
        }
        ud.catDimmed = maxShare < 0.22;
      }
    }
  }

  // ---- Time scrubber ----
  function onGlobeTimeScrub(val) {
    currentTimeIdx = parseInt(val, 10);
    if (isNaN(currentTimeIdx)) currentTimeIdx = 29;
    var labelEl = document.getElementById('globeTimeValue');
    if (labelEl) {
      var daysAgo = 29 - currentTimeIdx;
      labelEl.textContent = daysAgo === 0 ? 'Now' : (daysAgo + 'd ago');
    }
    updateDotsForTime(currentTimeIdx);
    if (pinnedMesh) populateDetailPanel(pinnedMesh);
  }

  function updateDotsForTime(idx) {
    var THREE = window.THREE;
    for (var i = 0; i < dotMeshes.length; i++) {
      var d = dotMeshes[i];
      var ts = d.userData.timeSeries[idx];
      if (!ts) continue;
      var color;
      if (ts.sentiment > 0.15) {
        color = new THREE.Color().setHSL(0.5, 0.8, 0.4 + ts.sentiment * 0.3);
      } else if (ts.sentiment < -0.15) {
        color = new THREE.Color().setHSL(0.95, 0.8, 0.4 + Math.abs(ts.sentiment) * 0.25);
      } else {
        color = new THREE.Color(0x94a3b8);
      }
      d.material.color = color;
      d.userData.currentBaseSize = 1.0 + (ts.articles / 150) * 3.5;
    }
  }

  // ---- Detail panel ----
  function openDetailPanel(dot) {
    var panel = document.getElementById('globeDetailPanel');
    if (!panel || !dot) return;
    panel.classList.add('open');
    populateDetailPanel(dot);
  }

  function closeDetailPanel() {
    var panel = document.getElementById('globeDetailPanel');
    if (panel) panel.classList.remove('open');
  }

  function populateDetailPanel(dot) {
    var d = dot.userData;
    var ts = d.timeSeries[currentTimeIdx] || { sentiment: d.sentiment, articles: d.articles };
    var sent = ts.sentiment;
    var articles = ts.articles;
    var cls = sentimentClassification(sent);

    var country = document.getElementById('gdpCountry');
    var label = document.getElementById('gdpLabel');
    var sentBar = document.getElementById('gdpSentBar');
    var sentVal = document.getElementById('gdpSentVal');
    var artNow = document.getElementById('gdpArticlesNow');

    if (country) country.textContent = d.name;
    if (label) {
      label.textContent = cls.label;
      label.style.color = cls.color;
    }
    if (sentBar) {
      var halfPct = Math.round(Math.abs(sent) * 100) / 2;
      sentBar.style.background = cls.color;
      sentBar.style.width = halfPct + '%';
      sentBar.style.left = (sent >= 0 ? '50%' : (50 - halfPct) + '%');
    }
    if (sentVal) {
      sentVal.textContent = (sent >= 0 ? '+' : '') + sent.toFixed(2);
      sentVal.style.color = cls.color;
    }
    if (artNow) {
      artNow.textContent = articles + ' articles';
    }

    renderTrendCanvas(d.timeSeries, currentTimeIdx);
    renderCategoryMix(d.categories);
    renderHeadlines(d.headlines);

    if (window.lucide) {
      try { lucide.createIcons(); } catch (e) {}
    }
  }

  function renderTrendCanvas(timeSeries, currentIdx) {
    var canvas = document.getElementById('gdpTrendCanvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W = canvas.width;
    var H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(51, 65, 85, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();

    var maxAbs = 0.5;
    for (var i = 0; i < timeSeries.length; i++) {
      if (Math.abs(timeSeries[i].sentiment) > maxAbs) maxAbs = Math.abs(timeSeries[i].sentiment);
    }

    ctx.beginPath();
    for (var i = 0; i < timeSeries.length; i++) {
      var x = (i / (timeSeries.length - 1)) * W;
      var y = H / 2 - (timeSeries[i].sentiment / maxAbs) * (H / 2 - 6);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Fill under curve
    ctx.lineTo(W, H / 2);
    ctx.lineTo(0, H / 2);
    ctx.closePath();
    ctx.fillStyle = 'rgba(34, 211, 238, 0.08)';
    ctx.fill();

    // Current marker
    if (currentIdx >= 0 && currentIdx < timeSeries.length) {
      var cx = (currentIdx / (timeSeries.length - 1)) * W;
      var cy = H / 2 - (timeSeries[currentIdx].sentiment / maxAbs) * (H / 2 - 6);
      ctx.beginPath();
      ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#22d3ee';
      ctx.fill();
      ctx.strokeStyle = 'rgba(15,23,42,0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  function renderCategoryMix(cats) {
    var container = document.getElementById('gdpCategoryMix');
    if (!container) return;
    var order = [
      { key: 'politics', label: 'Politics', color: '#22d3ee' },
      { key: 'economy',  label: 'Economy',  color: '#10b981' },
      { key: 'climate',  label: 'Climate',  color: '#84cc16' },
      { key: 'conflict', label: 'Conflict', color: '#f43f5e' }
    ];
    container.innerHTML = order.map(function(c) {
      var share = cats[c.key] || 0;
      var pct = Math.round(share * 100);
      return '<div class="globe-cat-bar">' +
        '<span style="width:60px">' + c.label + '</span>' +
        '<div class="globe-cat-bar-track"><div class="globe-cat-bar-fill" style="width:' + pct + '%;background:' + c.color + '"></div></div>' +
        '<span style="width:34px;text-align:right;color:#94a3b8;font-family:JetBrains Mono,monospace">' + pct + '%</span>' +
        '</div>';
    }).join('');
  }

  function renderHeadlines(headlines) {
    var container = document.getElementById('gdpHeadlines');
    if (!container) return;
    container.innerHTML = headlines.map(function(h) {
      var ago;
      if (h.minsAgo < 60) ago = h.minsAgo + 'm ago';
      else if (h.minsAgo < 1440) ago = Math.round(h.minsAgo / 60) + 'h ago';
      else ago = Math.round(h.minsAgo / 1440) + 'd ago';
      var sentColor = h.sentiment > 0.15 ? '#22d3ee' : (h.sentiment < -0.15 ? '#f43f5e' : '#94a3b8');
      var sign = h.sentiment >= 0 ? '+' : '';
      return '<div class="globe-headline-item">' +
        '<div class="globe-headline-title">' + escapeHtml(h.title) + '</div>' +
        '<div class="globe-headline-meta">' +
          '<span class="globe-headline-source">' + escapeHtml(h.source) + '</span>' +
          '<span style="color:' + sentColor + '">' + sign + h.sentiment.toFixed(2) + ' · ' + ago + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
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
  waitAndOverride();
  setTimeout(waitAndOverride, 500);
  setTimeout(waitAndOverride, 1500);

  console.log('globe_standalone: loaded');
})();

// === Digest View: sibling bridge to World Digest (contract/news_exchange.md) ===
// Adds a "Digest" toggle to the globe that slides in World Digest's clustered,
// LLM-written narrative fetched from /api/news/world-digest. Fully self-contained
// and best-effort: if the sibling hasn't published or is unreachable it shows a
// quiet notice and the globe is otherwise untouched.
(function() {
  'use strict';
  var PANEL_ID = 'worldDigestPanel';
  var injected = false;

  function ensureUI() {
    if (injected) return true;
    var overlay = document.getElementById('globeOverlay');
    if (!overlay) return false;
    var bar = overlay.querySelector('.globe-top-bar');
    if (!bar) return false;

    var btn = document.createElement('button');
    btn.id = 'worldDigestToggle';
    btn.textContent = 'Digest';
    btn.style.cssText = 'pointer-events:auto;cursor:pointer;font-size:11px;font-weight:600;color:#94a3b8;background:rgba(15,23,42,0.7);border:1px solid rgba(34,211,238,0.15);border-radius:999px;padding:6px 14px;margin-right:8px;transition:all .2s';
    btn.onmouseenter = function() { btn.style.color = '#22d3ee'; btn.style.borderColor = 'rgba(34,211,238,0.4)'; };
    btn.onmouseleave = function() { btn.style.color = '#94a3b8'; btn.style.borderColor = 'rgba(34,211,238,0.15)'; };
    btn.onclick = toggleDigest;
    var closeBtn = bar.querySelector('.globe-close');
    if (closeBtn && closeBtn.parentNode) closeBtn.parentNode.insertBefore(btn, closeBtn);
    else bar.appendChild(btn);

    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'globe-detail-panel';   // reuse the slide-in panel styling
    panel.style.left = '0';
    panel.style.right = 'auto';
    panel.style.borderLeft = 'none';
    panel.style.borderRight = '1px solid rgba(34,211,238,0.1)';
    panel.style.transform = 'translateX(-100%)';
    panel.setAttribute('data-open', '0');
    panel.innerHTML = '<div class="globe-detail-header"><div><div class="text-base font-bold text-white">World Digest</div><div class="text-xs mt-0.5 text-slate-400">State of the World &mdash; clustered narrative</div></div><button id="worldDigestClose" class="globe-close" style="width:30px;height:30px">&times;</button></div><div id="worldDigestBody" class="globe-detail-body"><div class="text-xs text-slate-500">Loading&hellip;</div></div>';
    overlay.appendChild(panel);
    var pc = panel.querySelector('#worldDigestClose');
    if (pc) pc.onclick = function() { panel.style.transform = 'translateX(-100%)'; panel.setAttribute('data-open', '0'); };

    injected = true;
    return true;
  }

  function toggleDigest() {
    if (!ensureUI()) return;
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    if (panel.getAttribute('data-open') === '1') {
      panel.style.transform = 'translateX(-100%)';
      panel.setAttribute('data-open', '0');
    } else {
      panel.style.transform = 'translateX(0)';
      panel.setAttribute('data-open', '1');
      loadDigest();
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function render(data) {
    var body = document.getElementById('worldDigestBody');
    if (!body) return;
    if (!data || data.stale || !data.clusters || !data.clusters.length) {
      body.innerHTML = '<div class="text-xs text-slate-500">World Digest hasn\'t published yet, or is unreachable. The globe is unaffected.</div>';
      return;
    }
    var html = '';
    if (data.narrative) {
      html += '<div class="globe-detail-section"><div class="globe-detail-title">Narrative</div>' +
        '<div class="text-xs text-slate-300" style="white-space:pre-wrap;line-height:1.5">' + esc(data.narrative).slice(0, 4000) + '</div></div>';
    }
    html += '<div class="globe-detail-section"><div class="globe-detail-title">Top stories</div><div class="flex flex-col gap-2">';
    data.clusters.slice(0, 12).forEach(function(c) {
      var src = (c.countries && c.countries.length ? c.countries : (c.regions || [])).join(', ');
      html += '<div class="globe-headline-item"><div class="globe-headline-title">' + esc(c.headline) + '</div>' +
        '<div class="globe-headline-meta"><span class="globe-headline-source">' + esc(src) + '</span>' +
        '<span>' + esc(c.outlets || 0) + ' outlets</span></div></div>';
    });
    html += '</div></div>';
    body.innerHTML = html;
  }

  function loadDigest() {
    var body = document.getElementById('worldDigestBody');
    if (body) body.innerHTML = '<div class="text-xs text-slate-500">Loading&hellip;</div>';
    fetch('/api/news/world-digest', { cache: 'no-store' })
      .then(function(r) { return r.json(); })
      .then(render)
      .catch(function() { render(null); });
  }

  window.toggleWorldDigest = toggleDigest;

  // The overlay ships in index.html, but the bar may settle after load; retry a
  // few times then give up quietly.
  var tries = 0;
  var t = setInterval(function() {
    tries++;
    if (ensureUI() || tries > 20) clearInterval(t);
  }, 500);

  console.log('globe_digest_view: loaded');
})();
