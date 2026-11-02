// SPDX-License-Identifier: Apache-2.0
// KriyaDot landing site behaviour: manual light/dark theme toggle
// (persisted in localStorage), the frontdoor health probe that adapts
// the primary CTA to the hosting mode, live star count, mobile nav,
// scroll reveal, and the screenshot lightbox.
(function () {
  'use strict';
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- theme toggle ----
     The initial theme is set by the inline bootstrap in index.html
     (saved choice, else prefers-color-scheme). Toggling flips
     html[data-theme] and persists the choice. */
  var toggle = document.getElementById('theme-toggle');
  function syncToggle() {
    if (!toggle) return;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    toggle.setAttribute('aria-pressed', String(dark));
    toggle.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
  if (toggle) {
    syncToggle();
    toggle.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { window.localStorage.setItem('kriyadot-theme', next); } catch (e) { /* private mode */ }
      syncToggle();
    });
  }
  // If the OS theme flips and the user has never chosen manually, follow it.
  var osDark = window.matchMedia('(prefers-color-scheme: dark)');
  if (osDark && osDark.addEventListener) {
    osDark.addEventListener('change', function (e) {
      var saved = null;
      try { saved = window.localStorage.getItem('kriyadot-theme'); } catch (err) { /* ignore */ }
      if (saved !== 'light' && saved !== 'dark') {
        document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
        syncToggle();
      }
    });
  }

  /* ---- frontdoor probe ----
     When this page is served by the KriyaDot frontdoor service, the
     service answers GET api/health and the primary CTA ("Create your
     workspace", href "auth/google") starts the Google sign-in flow.
     When the page is hosted statically (e.g. GitHub Pages) there is no
     service behind it, so the probe fails and the CTA degrades
     gracefully: it points at the downloads section instead and invites
     the visitor to download the fully local desktop app. */
  var cta = document.getElementById('cta-primary');
  var ctaNote = document.getElementById('cta-note');
  if (cta) {
    var probeDone = false;
    function staticMode() {
      if (probeDone) return;
      probeDone = true;
      cta.setAttribute('href', '#downloads');
      cta.textContent = 'Download the app';
      if (ctaNote) {
        ctaNote.textContent = 'You are viewing the static site. The desktop app is fully local-first — no account needed. Cloud workspaces launch from here once sign-in is live.';
      }
    }
    var timer = setTimeout(staticMode, 3500);
    fetch('api/health', { method: 'GET', headers: { 'Accept': 'application/json' } })
      .then(function (r) {
        clearTimeout(timer);
        // Any non-OK response (404 on static hosts, proxy errors) means
        // the frontdoor service is not behind this page.
        if (!r.ok) staticMode();
        else probeDone = true; // service is live: keep the sign-in CTA as-is
      })
      .catch(function () { clearTimeout(timer); staticMode(); });
  }

  /* ---- live GitHub star count ---- */
  function paintStars(n) {
    document.querySelectorAll('[data-stars]').forEach(function (el) {
      el.textContent = n == null ? 'Star' : '★ ' + n;
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
  var revealEls = document.querySelectorAll('.card, .shot, .steps li, .note-card, .hero-shot, .section-shot, .arch-box');
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
