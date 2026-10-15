// SPDX-License-Identifier: Apache-2.0
// KriyaDot landing hero: a cute procedural 3D blob pet (ported from the
// KriyaDot companion-pet geometry: displaced icosahedron body, 8 capsule
// arms, big eyes, blush) floating over the hero gradient with mouse
// parallax and soft particles. Reduced-motion renders one static frame.
import * as THREE from './assets/vendor/three.module.min.js';

(function () {
  var canvas = document.getElementById('pet-canvas');
  if (!canvas) return;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  } catch (e) {
    return; // WebGL unavailable — the CSS gradient hero still shows.
  }
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
  camera.position.set(0, 0.6, 7.4);

  // ---- lights (clay look: soft key + teal rim + violet fill) ----
  scene.add(new THREE.HemisphereLight(0xc4b5fd, 0x141428, 0.85));
  var key = new THREE.DirectionalLight(0xfff4e0, 1.9);
  key.position.set(3.5, 5, 4);
  scene.add(key);
  var rim = new THREE.DirectionalLight(0x2dd4bf, 1.1);
  rim.position.set(-4, 1.5, -3);
  scene.add(rim);
  var fill = new THREE.DirectionalLight(0xe879f9, 0.5);
  fill.position.set(-2, -2, 4);
  scene.add(fill);

  // ---- deterministic pseudo-random for the clay displacement ----
  function rand(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function clayMaterial(color, roughness) {
    return new THREE.MeshStandardMaterial({
      color: color, roughness: roughness == null ? 0.62 : roughness, metalness: 0.05,
    });
  }

  // ---- the pet ----
  var pet = new THREE.Group();
  var BODY = 0x4256c8;

  var bodyGeo = new THREE.IcosahedronGeometry(1, 4);
  var pos = bodyGeo.attributes.position;
  var rnd = rand(20261010);
  var v = new THREE.Vector3();
  for (var i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    var d = 1 + (rnd() - 0.5) * 0.16;
    v.multiplyScalar(d);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  bodyGeo.computeVertexNormals();
  var body = new THREE.Mesh(bodyGeo, clayMaterial(BODY));
  pet.add(body);

  // Eight stubby arms arranged radially (no tools on the landing pet —
  // clean cute silhouette).
  var arms = [];
  var armMat = clayMaterial(0x3a4cb2);
  for (var a = 0; a < 8; a++) {
    var ang = (a / 8) * Math.PI * 2;
    var arm = new THREE.Group();
    var seg = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.3, 6, 12), armMat);
    seg.position.y = 0.22;
    arm.add(seg);
    arm.position.set(Math.cos(ang) * 0.88, -0.08 + (a % 2) * 0.32, Math.sin(ang) * 0.88);
    arm.rotation.z = -Math.cos(ang) * 1.35;
    arm.rotation.x = Math.sin(ang) * 1.35;
    pet.add(arm);
    arms.push(arm);
  }

  // Big eyes: white spheres + dark pupils, sitting proud of the clay surface.
  var eyes = [];
  var whiteMat = clayMaterial(0xffffff, 0.35);
  var pupilMat = new THREE.MeshStandardMaterial({ color: 0x23203a, roughness: 0.25 });
  [-1, 1].forEach(function (side) {
    var white = new THREE.Mesh(new THREE.SphereGeometry(0.155, 18, 14), whiteMat);
    white.position.set(side * 0.3, 0.02, 0.9);
    var pupil = new THREE.Mesh(new THREE.SphereGeometry(0.068, 14, 12), pupilMat);
    pupil.position.set(side * 0.3, 0.02, 1.02);
    pet.add(white); pet.add(pupil);
    eyes.push({ white: white, pupil: pupil });
  });
  // Blush.
  var blushMat = new THREE.MeshStandardMaterial({ color: 0xf9a8d4, roughness: 0.7 });
  [-1, 1].forEach(function (side) {
    var b = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), blushMat);
    b.scale.set(1.4, 0.8, 0.6);
    b.position.set(side * 0.52, -0.2, 0.78);
    pet.add(b);
  });

  pet.scale.setScalar(0.8);
  var PET_Y = 2.05; // floats above the headline
  pet.position.y = PET_Y;
  scene.add(pet);

  // ---- soft particles ----
  var P = 90;
  var pGeo = new THREE.BufferGeometry();
  var pPos = new Float32Array(P * 3);
  var prnd = rand(77);
  var palette = [0x2dd4bf, 0x8b5cf6, 0xe879f9, 0xffffff];
  var pCol = new Float32Array(P * 3);
  var tmpC = new THREE.Color();
  for (var p = 0; p < P; p++) {
    pPos[p * 3] = (prnd() - 0.5) * 12;
    pPos[p * 3 + 1] = (prnd() - 0.5) * 7;
    pPos[p * 3 + 2] = -2 - prnd() * 5;
    tmpC.setHex(palette[Math.floor(prnd() * palette.length)]);
    pCol[p * 3] = tmpC.r; pCol[p * 3 + 1] = tmpC.g; pCol[p * 3 + 2] = tmpC.b;
  }
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  var particles = new THREE.Points(pGeo, new THREE.PointsMaterial({
    size: 0.055, vertexColors: true, transparent: true, opacity: 0.75,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  scene.add(particles);

  // ---- mouse parallax ----
  var mx = 0, my = 0, tmx = 0, tmy = 0;
  window.addEventListener('pointermove', function (e) {
    tmx = (e.clientX / window.innerWidth - 0.5) * 2;
    tmy = (e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });

  function size() {
    var w = canvas.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Portrait phones: pull the camera back so the pet stays a cute
    // accent above the headline instead of swallowing it.
    if (camera.aspect < 0.8) { camera.position.set(0, 0.2, 11.5); camBaseY = 0.2; }
    else { camera.position.set(0, 0.6, 7.4); camBaseY = 0.6; }
    camera.updateProjectionMatrix();
  }
  var camBaseY = 0.6;
  window.addEventListener('resize', size);
  size();

  // ---- scroll-reactive page background ----
  // The canvas is fixed full-page: the pet belongs to the hero (drifts up
  // and settles as you scroll past), particles flow everywhere and surge
  // with scroll velocity, camera eases downward for parallax depth.
  var heroEl = document.getElementById('hero');
  var scrollY = 0, lastScrollY = window.scrollY || 0, scrollBoost = 0;
  window.addEventListener('scroll', function () {
    scrollY = window.scrollY || 0;
    scrollBoost = Math.min(Math.abs(scrollY - lastScrollY) * 0.012, 1.6);
    lastScrollY = scrollY;
  }, { passive: true });

  // ---- animation ----
  var clock = new THREE.Clock();
  var running = true;
  var blinkT = 0, nextBlink = 2.4;

  var last = performance.now();
  function animate(now) {
    if (!running) return;
    var dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    var t = clock.getElapsedTime();

    // Pet: idle motion + scroll-away drift (stays fully visible in hero,
    // floats up and gently shrinks as the hero leaves the viewport).
    var heroH = (heroEl && heroEl.offsetHeight) || window.innerHeight;
    var fade = Math.max(0, 1 - scrollY / (heroH * 0.85));
    var br2 = 1 + Math.sin(t * 2.1) * 0.028;
    body.scale.set(br2, 1 / Math.sqrt(br2), br2);
    pet.position.y = PET_Y + Math.sin(t * 1.7) * 0.09 + (1 - fade) * 2.2;
    pet.scale.setScalar(0.8 * (0.55 + 0.45 * fade));
    pet.visible = fade > 0.01;
    for (var i = 0; i < arms.length; i++) arms[i].rotation.y = Math.sin(t * 2.6 + i * 0.9) * 0.35;

    blinkT += dt;
    if (blinkT > nextBlink) { blinkT = 0; nextBlink = 2 + Math.random() * 3.5; }
    var blinkPhase = blinkT < 0.14 ? Math.sin((blinkT / 0.14) * Math.PI) : 0;
    eyes.forEach(function (e) {
      e.white.scale.set(1, 1 - blinkPhase * 0.92, 1);
      e.pupil.scale.set(1, 1 - blinkPhase * 0.92, 1);
    });

    // Parallax: lean toward the pointer.
    mx += (tmx - mx) * 0.045;
    my += (tmy - my) * 0.045;
    pet.rotation.y = mx * 0.35;
    pet.rotation.x = my * 0.18;

    // Particles drift upward, wrap around; scroll velocity gives them a
    // visible surge so the background feels alive while scrolling.
    scrollBoost = Math.max(0, scrollBoost - dt * 2.2);
    var rise = dt * (0.14 + scrollBoost * 0.55);
    var arr = pGeo.attributes.position.array;
    for (var p = 0; p < P; p++) {
      arr[p * 3 + 1] += rise;
      arr[p * 3] += Math.sin(t * 0.6 + p) * dt * 0.05;
      if (arr[p * 3 + 1] > 3.6) arr[p * 3 + 1] = -3.6;
    }
    pGeo.attributes.position.needsUpdate = true;

    // Gentle camera parallax with scroll — the world eases downward.
    camera.position.y += ((camBaseY - scrollY * 0.0011) - camera.position.y) * 0.06;

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  if (reduced) {
    // One static frame: mid-breath, eyes open, slight angle.
    var br3 = 1.014;
    body.scale.set(br3, 1 / Math.sqrt(br3), br3);
    pet.rotation.y = 0.18;
    renderer.render(scene, camera);
  } else {
    // The canvas is the full-page background: keep animating while the tab
    // is visible, pause only when hidden.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) running = false;
      else if (running === false) { running = true; last = performance.now(); requestAnimationFrame(animate); }
    });
    requestAnimationFrame(animate);
  }
})();
