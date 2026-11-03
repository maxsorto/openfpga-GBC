/* Vitrine site. Plain JS, no dependencies. */
(function () {
  'use strict';

  var doc = document;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) doc.documentElement.classList.add('reduced');

  /* Nav border once the page has moved. */
  var nav = doc.querySelector('.nav');
  function navState() { nav.classList.toggle('is-scrolled', window.scrollY > 8); }
  navState();

  /* Hero video: a tall clip on narrow screens, the wide one elsewhere. */
  var heroVideo = doc.getElementById('hero-video');
  var heroFrame = heroVideo.parentNode;
  function setHeroSource() {
    var portrait = window.innerWidth < 640;
    var want = portrait ? 'assets/pocket_portrait.mp4' : 'assets/pocket_landscape.mp4';
    if (heroVideo.getAttribute('data-current') === want) return;
    heroVideo.setAttribute('data-current', want);
    heroFrame.classList.toggle('is-portrait', portrait);
    heroVideo.src = want;
    heroVideo.load();
    var p = heroVideo.play();
    if (p && p.catch) p.catch(function () {});
  }
  setHeroSource();
  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { setHeroSource(); layoutScrubs(); }, 150);
  });

  /* Hero parallax: three layers, each at its own rate, only while the stage is near. */
  var stage = doc.getElementById('hero-stage');
  var layers = Array.prototype.slice.call(stage.querySelectorAll('.plx')).map(function (el) {
    return { el: el, rate: parseFloat(el.getAttribute('data-rate')) || 0 };
  });
  function parallax() {
    if (reduced) return;
    var rect = stage.getBoundingClientRect();
    if (rect.bottom < -200 || rect.top > window.innerHeight + 200) return;
    var y = window.scrollY;
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      l.el.style.transform = 'translate3d(0,' + (-y * l.rate).toFixed(1) + 'px,0)' + (l.el.getAttribute('data-rot') || '');
    }
  }
  /* The covers carry a rotation in CSS; keep it when we set a transform. */
  layers.forEach(function (l) {
    var m = getComputedStyle(l.el).transform;
    if (m && m !== 'none') {
      var v = m.match(/matrix\(([^)]+)\)/);
      if (v) {
        var a = v[1].split(',').map(parseFloat);
        var deg = Math.round(Math.atan2(a[1], a[0]) * 180 / Math.PI);
        if (deg) l.el.setAttribute('data-rot', ' rotate(' + deg + 'deg)');
      }
    }
  });

  /* Reveals: once, when a block enters the lower part of the viewport. */
  var io = 'IntersectionObserver' in window;
  var reveals = doc.querySelectorAll('.reveal');
  if (io && !reduced) {
    var ro = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('is-in'); ro.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
    reveals.forEach(function (el) { ro.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('is-in'); });
  }

  /* Lazy videos: load when near, play in view, pause out of view. */
  var lazies = doc.querySelectorAll('video.lazy-video');
  function loadVideo(v) {
    if (!v.getAttribute('src')) { v.src = v.getAttribute('data-src'); v.load(); }
  }
  if (io) {
    var vo = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var v = e.target;
        if (e.isIntersecting) {
          loadVideo(v);
          var p = v.play(); if (p && p.catch) p.catch(function () {});
        } else if (v.getAttribute('src')) {
          v.pause();
        }
      });
    }, { rootMargin: '40% 0px 40% 0px' });
    lazies.forEach(function (v) { vo.observe(v); });
  } else {
    lazies.forEach(function (v) { loadVideo(v); v.play(); });
  }

  /* Sticky stories: the image follows whichever beat is nearest the middle of the screen. */
  var stories = [];
  doc.querySelectorAll('.story').forEach(function (story) {
    var swap = story.querySelector('[data-swap]');
    if (!swap) return;
    stories.push({
      imgs: Array.prototype.slice.call(swap.querySelectorAll('img')),
      beats: Array.prototype.slice.call(story.querySelectorAll('.beat[data-beat]')),
      on: -1
    });
  });
  function updateStories() {
    var mid = window.innerHeight / 2;
    stories.forEach(function (st) {
      var best = -1, bestD = Infinity;
      st.beats.forEach(function (b, i) {
        var r = b.getBoundingClientRect();
        var d = Math.abs((r.top + r.bottom) / 2 - mid);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best !== st.on) {
        st.on = best;
        var key = st.beats[best].getAttribute('data-beat');
        st.imgs.forEach(function (im) { im.classList.toggle('is-on', im.getAttribute('data-beat') === key); });
      }
    });
  }

  /* Scroll scrubbed sequences. */
  var scrubs = [];
  doc.querySelectorAll('.scrub').forEach(function (sec) {
    var count = parseInt(sec.getAttribute('data-count'), 10);
    var base = sec.getAttribute('data-seq');
    var canvas = sec.querySelector('canvas');
    var ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    var caps = Array.prototype.slice.call(sec.querySelectorAll('.cap')).map(function (c) {
      return { el: c, from: parseInt(c.getAttribute('data-from'), 10), to: parseInt(c.getAttribute('data-to'), 10) };
    });
    var s = {
      sec: sec, track: sec.querySelector('.scrub-track'), stage: sec.querySelector('.scrub-stage'),
      canvas: canvas, ctx: ctx, count: count, base: base, caps: caps,
      frames: new Array(count), loaded: 0, loading: false, drawn: -1, capOn: -1,
      bar: sec.querySelector('.scrub-loading'), key: parseInt(sec.getAttribute('data-key'), 10) || 0,
      top: 0, span: 1
    };
    scrubs.push(s);
  });

  function frameUrl(s, i) { return s.base + '/' + ('00' + i).slice(-3) + '.webp'; }

  function loadSeq(s) {
    if (s.loading) return;
    s.loading = true;
    var next = 0, inflight = 0, lanes = 4;
    function pump() {
      while (inflight < lanes && next < s.count) {
        (function (i) {
          var im = new Image();
          inflight++;
          im.onload = im.onerror = function () {
            inflight--; s.loaded++;
            s.frames[i] = im.complete && im.naturalWidth ? im : null;
            if (s.bar) {
              s.bar.firstElementChild.style.width = Math.round(100 * s.loaded / s.count) + '%';
              if (s.loaded >= s.count) s.bar.classList.add('is-done');
            }
            draw(s, true);
            pump();
          };
          im.src = frameUrl(s, i);
        })(next++);
      }
    }
    /* The key frame first, so something shows at once. */
    var k = new Image();
    k.onload = function () { s.frames[s.key] = k; draw(s, true); };
    k.src = frameUrl(s, s.key);
    pump();
  }

  function nearestLoaded(s, i) {
    if (s.frames[i]) return s.frames[i];
    for (var d = 1; d < s.count; d++) {
      if (i - d >= 0 && s.frames[i - d]) return s.frames[i - d];
      if (i + d < s.count && s.frames[i + d]) return s.frames[i + d];
    }
    return null;
  }

  function targetIndex(s) {
    if (reduced) return s.key;
    var y = window.scrollY;
    var p = (y - s.top) / s.span;
    if (p < 0) p = 0; if (p > 1) p = 1;
    return Math.round(p * (s.count - 1));
  }

  function draw(s, force) {
    var i = targetIndex(s);
    var im = nearestLoaded(s, i);
    if (im && (force || s.drawn !== i)) {
      s.ctx.imageSmoothingEnabled = false;
      s.ctx.drawImage(im, 0, 0, s.canvas.width, s.canvas.height);
      s.drawn = i;
    }
    if (s.capOn !== i) {
      s.caps.forEach(function (c) { c.el.classList.toggle('is-on', reduced || (i >= c.from && i <= c.to)); });
      s.capOn = i;
    }
  }

  function layoutScrubs() {
    scrubs.forEach(function (s) {
      var r = s.track.getBoundingClientRect();
      s.top = r.top + window.scrollY;
      s.span = Math.max(1, s.track.offsetHeight - window.innerHeight);
    });
  }

  /* Start loading a sequence when it is within two screens. */
  function maybeLoad() {
    scrubs.forEach(function (s) {
      if (s.loading) return;
      var r = s.sec.getBoundingClientRect();
      if (r.top < window.innerHeight * 2 && r.bottom > -window.innerHeight) loadSeq(s);
    });
  }

  /* One frame loop for scroll work. */
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      navState();
      parallax();
      updateStories();
      maybeLoad();
      scrubs.forEach(function (s) { draw(s, false); });
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('load', function () { layoutScrubs(); onScroll(); });
  layoutScrubs();
  onScroll();
  if (reduced) scrubs.forEach(loadSeqKeyOnly);

  function loadSeqKeyOnly(s) {
    var k = new Image();
    k.onload = function () { s.frames[s.key] = k; draw(s, true); };
    k.src = frameUrl(s, s.key);
    s.loading = true;
    s.caps.forEach(function (c) { c.el.classList.add('is-on'); });
  }
})();
