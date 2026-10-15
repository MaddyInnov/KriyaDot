// SPDX-License-Identifier: Apache-2.0
// KriyaDot landing site behaviour: live star count, mobile nav,
// scroll reveal, and the self-playing "watch it write code" demo.
(function () {
  'use strict';
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- live GitHub star count ---- */
  function paintStars(n) {
    document.querySelectorAll('[data-stars]').forEach(function (el) {
      el.textContent = n == null ? 'Star' : '★ ' + n;
    });
    document.querySelectorAll('[data-stars-num]').forEach(function (el) {
      el.textContent = n == null ? '–' : String(n);
    });
  }
  fetch('https://api.github.com/repos/MaddyInnov/KriyaDot')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { paintStars(d && d.stargazers_count); })
    .catch(function () { paintStars(null); });

  /* ---- mobile nav ---- */
  var burger = document.querySelector('.nav-burger');
  var links = document.querySelector('.nav-links');
  if (burger && links) {
    burger.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      burger.setAttribute('aria-expanded', String(open));
    });
    links.addEventListener('click', function (e) {
      if (e.target.closest('a')) links.classList.remove('open');
    });
  }

  /* ---- scroll reveal ---- */
  var revealEls = document.querySelectorAll('.card, .shot, .steps li, .stat');
  revealEls.forEach(function (el) { el.classList.add('reveal'); });
  if ('IntersectionObserver' in window && !reduced) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.12 });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('in'); });
  }

  /* ---- "watch it write code" self-playing demo ----
     Types out a diff: deleted lines in red, added lines in green,
     with a blinking caret. Loops forever (pauses offscreen). */
  var LINES = [
    { t: 'del', code: 'export function greet(name: string): string {' },
    { t: 'del', code: '  return "Hello, " + name;' },
    { t: 'del', code: '}' },
    { t: 'add', code: 'export function greet(name: string, punct = "!"): string {' },
    { t: 'add', code: '  const clean = name.trim() || "friend";' },
    { t: 'add', code: '  return `Hello, ${clean}${punct}`;' },
    { t: 'add', code: '}' },
    { t: 'add', code: '' },
    { t: 'add', code: 'export function greetAll(names: string[]): string[] {' },
    { t: 'add', code: '  return names.map((n) => greet(n));' },
    { t: 'add', code: '}' },
  ];

  function highlight(code) {
    // Order matters: strings first, so later replacements never match
    // inside the spans this function itself inserts (e.g. class="tok-k").
    return code
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/("[^"]*"|`[^`]*`)/g, '<span class="tok-s">$1</span>')
      .replace(/\b(export|function|return|const)\b/g, '<span class="tok-k">$1</span>')
      .replace(/\b(greet|greetAll|trim|map)\b(?![^<]*>)/g, '<span class="tok-f">$1</span>');
  }

  var pre = document.getElementById('demo-code');
  if (pre) {
    var lineIdx = 0, charIdx = 0, visible = true, timer = null;

    function render() {
      var html = '';
      for (var i = 0; i < lineIdx; i++) {
        var L = LINES[i];
        var cls = L.t === 'add' ? 'ln ln-add' : 'ln ln-del';
        var prefix = L.t === 'add' ? '+' : '−';
        html += '<span class="' + cls + '"><span class="p">' + prefix + '</span> ' + highlight(L.code) + '</span>';
      }
      if (lineIdx < LINES.length) {
        var cur = LINES[lineIdx];
        var cls2 = cur.t === 'add' ? 'ln ln-add' : 'ln ln-del';
        var prefix2 = cur.t === 'add' ? '+' : '−';
        html += '<span class="' + cls2 + '"><span class="p">' + prefix2 + '</span> ' +
          highlight(cur.code.slice(0, charIdx)) + '<span class="caret"></span></span>';
      } else {
        html += '<span class="ln"><span class="caret"></span></span>';
      }
      pre.innerHTML = html;
    }

    function tick() {
      if (!visible) return;
      var cur = LINES[lineIdx];
      if (!cur) { // finished — hold, then restart
        timer = setTimeout(function () { lineIdx = 0; charIdx = 0; schedule(); }, 4200);
        return;
      }
      charIdx += 1;
      if (charIdx > cur.code.length) { lineIdx += 1; charIdx = 0; }
      render();
      schedule();
    }
    function schedule() {
      clearTimeout(timer);
      var speed = reduced ? 0 : 26 + Math.random() * 30;
      timer = setTimeout(tick, speed);
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) schedule(); else clearTimeout(timer);
      }).observe(pre);
    }
    if (reduced) { // static full render, no animation
      lineIdx = LINES.length; charIdx = 0; render();
    } else {
      render(); schedule();
    }
  }

  /* ---- screenshot lightbox ---- */
  (function lightbox() {
    var shots = Array.prototype.slice.call(document.querySelectorAll('.shot'));
    if (!shots.length) return;
    var box = document.getElementById('lightbox');
    var img = document.getElementById('lb-img');
    var cap = document.getElementById('lb-cap');
    var idx = 0, lastFocus = null;

    function show(i) {
      idx = (i + shots.length) % shots.length;
      var im = shots[idx].querySelector('img');
      var fc = shots[idx].querySelector('figcaption');
      img.src = im.getAttribute('src');
      img.alt = im.getAttribute('alt') || '';
      cap.textContent = fc ? fc.textContent : '';
    }
    function open(i, opener) {
      lastFocus = opener || document.activeElement;
      box.hidden = false;
      document.body.style.overflow = 'hidden';
      show(i);
      document.getElementById('lb-close').focus();
    }
    function close() {
      box.hidden = true;
      document.body.style.overflow = '';
      img.removeAttribute('src');
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    shots.forEach(function (fig, i) {
      fig.setAttribute('tabindex', '0');
      fig.setAttribute('role', 'button');
      fig.setAttribute('aria-label', 'Enlarge screenshot: ' + ((fig.querySelector('figcaption') || {}).textContent || '').trim());
      fig.addEventListener('click', function () { open(i, fig); });
      fig.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(i, fig); }
      });
    });
    document.getElementById('lb-close').addEventListener('click', close);
    document.getElementById('lb-prev').addEventListener('click', function (e) { e.stopPropagation(); show(idx - 1); });
    document.getElementById('lb-next').addEventListener('click', function (e) { e.stopPropagation(); show(idx + 1); });
    box.addEventListener('click', function (e) { if (e.target === box) close(); });
    document.addEventListener('keydown', function (e) {
      if (box.hidden) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') show(idx - 1);
      else if (e.key === 'ArrowRight') show(idx + 1);
    });
  })();
})();
