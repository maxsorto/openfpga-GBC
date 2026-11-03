/* Vitrine site: reveals, the hero's tilt and parallax, the before and after wipe, and videos that play in view. */
(function () {
  var root = document.documentElement;
  root.classList.add('js');
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) root.classList.add('reduced');
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function smooth(t) { return t * t * (3 - 2 * t); }

  /* Nav background once the page moves. */
  var nav = document.getElementById('nav');
  function navState() { nav.classList.toggle('scrolled', window.scrollY > 12); }

  /* Reveal sections as they arrive. */
  var reveals = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window && !reduced) {
    var ro = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); ro.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });
    reveals.forEach(function (el) { ro.observe(el); });
  } else reveals.forEach(function (el) { el.classList.add('in'); });

  /* Videos: load when near, play only while on screen. */
  var vids = document.querySelectorAll('video.loop');
  if ('IntersectionObserver' in window) {
    var near = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        var v = e.target;
        if (e.isIntersecting && v.dataset.src && !v.src) { v.src = v.dataset.src; v.load(); }
      });
    }, { rootMargin: '900px 0px' });
    var seen = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        var v = e.target;
        if (e.isIntersecting && !reduced) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
        else v.pause();
      });
    }, { threshold: 0.25 });
    vids.forEach(function (v) { near.observe(v); seen.observe(v); });
  }
  if (reduced) vids.forEach(function (v) {         // no autoplay: a click plays or pauses
    v.removeAttribute('autoplay'); v.pause();
    v.addEventListener('click', function () { if (!v.src && v.dataset.src) v.src = v.dataset.src; v.paused ? v.play() : v.pause(); });
  });

  /* Hero: the screen tilts up to face you and the cover wall drifts as you scroll. */
  var heroDev = document.querySelector('.hero-device');
  var wall = document.querySelector('.wall-wrap');

  /* Before and after: scrolling wipes the stock list away; dragging takes over. */
  var compare = document.getElementById('compare');
  var ba = document.getElementById('ba');
  var handle = ba && ba.querySelector('.ba-handle');
  var dev = ba && ba.closest('.compare-device');
  var manual = false;
  function setP(p) {
    p = clamp(p, 0, 100);
    ba.style.setProperty('--p', p.toFixed(2) + '%');
    handle.setAttribute('aria-valuenow', Math.round(p));
    dev.classList.toggle('at-before', p > 88);
    dev.classList.toggle('at-after', p < 12);
  }
  function fromPointer(ev) {
    var r = ba.getBoundingClientRect();
    setP(100 * (ev.clientX - r.left) / r.width);
  }
  if (ba) {
    var dragging = false;
    ba.addEventListener('pointerdown', function (ev) { dragging = true; manual = true; ba.setPointerCapture(ev.pointerId); fromPointer(ev); });
    ba.addEventListener('pointermove', function (ev) { if (dragging) fromPointer(ev); });
    ba.addEventListener('pointerup', function () { dragging = false; });
    ba.addEventListener('pointercancel', function () { dragging = false; });
    handle.addEventListener('keydown', function (ev) {
      var now = parseFloat(ba.style.getPropertyValue('--p')) || 50;
      if (ev.key === 'ArrowLeft') { manual = true; setP(now - 5); ev.preventDefault(); }
      if (ev.key === 'ArrowRight') { manual = true; setP(now + 5); ev.preventDefault(); }
    });
    if (reduced) { compare.style.height = 'auto'; compare.querySelector('.compare-stick').style.position = 'relative'; setP(50); }
  }

  var ticking = false;
  function frame() {
    ticking = false;
    var y = window.scrollY, vh = window.innerHeight;
    navState();
    if (reduced) return;
    if (heroDev) {
      var t = clamp(y / (vh * 0.7), 0, 1), e = smooth(t);
      heroDev.style.setProperty('--tilt', (14 * (1 - e)).toFixed(2) + 'deg');
      heroDev.style.setProperty('--sc', (0.94 + 0.06 * e).toFixed(4));
    }
    if (wall) wall.style.setProperty('--wy', (y * -0.18).toFixed(1) + 'px');
    if (ba && !manual) {
      var r = compare.getBoundingClientRect();
      var span = compare.offsetHeight - vh;
      var k = clamp((-r.top - vh * 0.05) / (span * 0.8), 0, 1);
      setP(100 - 100 * smooth(k));
    }
  }
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  frame();
})();
