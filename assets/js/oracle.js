/* monolith — the moai oracle.
 *
 * One page, one state machine:
 *   idle → asking → listening → zooming → speaking → (back) → asking
 * The image is laid out once per viewport as a "cover" rectangle, then moved
 * with a single transform: zoomed in on the head, or at scale 1.
 */
(() => {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const esc = s => String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const body = document.body;
  const img = $('.moai');
  const box = $('.thought-box');
  const pill = $('.thought-pill');
  const form = $('.thought-form');
  const input = $('#question');
  const thoughtDots = [$('.thought-dot.d1'), $('.thought-dot.d2')];
  const thinkingDots = $('.thinking-dots');
  const status = $('#status');
  const speech = $('.speech');
  const tail = $('.speech-tail');
  const tailPath = $('.speech-tail path');
  const scroller = $('.speech-scroll');
  const speechBody = $('#speech-body');
  const readAll = $('.read-all');

  const HOME = body.dataset.home || '/';
  const SEARCH_URL = body.dataset.search || HOME + 'search.json';
  const SITE = body.dataset.site || 'monolith';
  const HOME_TITLE = document.title;

  const ZOOM_MS = 1600;
  const POP_MS = 520;
  const THINK_MS = 1300;
  const ZOOM_EASE = 'cubic-bezier(.65, 0, .25, 1)';

  // Points on the image, as fractions of its width and height.
  const FOCUS = { x: 0.652, y: 0.62 };                 // centre of the idle zoom
  const ANCHOR = { wide: { x: 0.605, y: 0.56 },        // where the thought dots end
                   narrow: { x: 0.652, y: 0.44 } };
  const TIP = { wide: { x: 0.612, y: 0.575 },          // where the speech tail points
                narrow: { x: 0.652, y: 0.44 } };

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  let G = null;             // current geometry
  let zoomedOut = false;
  let run = 0;              // bumps on every transition; stale async steps bail out
  let question = '';
  let dotTimer = 0;

  /* ---------------- geometry ---------------- */

  function geometry() {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const iw = img.naturalWidth || +img.getAttribute('width');
    const ih = img.naturalHeight || +img.getAttribute('height');
    const ar = iw / ih;
    const narrow = vw < 900 && vw < vh * 1.1;

    // Scale 1: cover the viewport. On narrow screens a little taller, so the
    // head sits lower and leaves room for the balloon above it.
    let h = Math.max(vh, vw / ar);
    if (narrow) h = Math.max(h, vh * 1.12);
    const w = h * ar;

    const headX = narrow ? vw * 0.5 : clamp(vw * 0.62, 480, 938);
    const out = {
      s: 1,
      x: clamp(headX - FOCUS.x * w, vw - w, 0),
      y: narrow ? 0 : (vh - h) / 2,
    };

    // Zoomed in: the statue fills ~85% of the viewport height.
    const s = clamp(0.85 * vh / (0.42 * h), 1.4, 3);
    const fx = narrow
      ? vw * 0.5
      : clamp(470 + (FOCUS.x - ANCHOR.wide.x) * w * s, vw * 0.5, vw * 0.7);
    const fy = narrow ? vh * 0.68 : vh * 0.5;
    const zin = {
      s,
      x: clamp(fx - FOCUS.x * w * s, vw - w * s, 0),
      y: clamp(fy - FOCUS.y * h * s, vh - h * s, 0),
    };

    return { vw, vh, narrow, w, h, out, in: zin };
  }

  const at = (t, p) => ({ x: t.x + p.x * G.w * t.s, y: t.y + p.y * G.h * t.s });
  const transformOf = t => `translate(${t.x}px, ${t.y}px) scale(${t.s})`;

  function setImage(t) { img.style.transform = transformOf(t); }

  async function moveImage(from, to) {
    if (reduced.matches) {
      const out = img.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, fill: 'forwards' });
      await out.finished;
      setImage(to);
      const back = img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350 });
      out.cancel();
      await back.finished;
      return;
    }
    setImage(to);
    await img.animate(
      [{ transform: transformOf(from) }, { transform: transformOf(to) }],
      { duration: ZOOM_MS, easing: ZOOM_EASE }
    ).finished;
  }

  function layout() {
    G = geometry();
    img.style.width = G.w + 'px';
    img.style.height = G.h + 'px';
    img.style.objectFit = 'fill';
    setImage(zoomedOut ? G.out : G.in);
    placeThought();
    placeSpeech();
  }

  function placeThought() {
    if (zoomedOut) return;
    const a = at(G.in, G.narrow ? ANCHOR.narrow : ANCHOR.wide);
    const bw = box.offsetWidth;
    const bh = box.offsetHeight;
    let left, top, cx, cy;

    if (G.narrow) {
      left = (G.vw - bw) / 2;
      top = clamp(a.y - 46 - bh, 16, G.vh - bh - 16);
      cx = left + bw * 0.62;
      cy = top + bh - 2;
    } else {
      left = clamp(a.x - 46 - bw, 16, G.vw - bw - 16);
      top = clamp(a.y - 30 - bh, 16, G.vh - bh - 16);
      cx = left + bw - 30;
      cy = top + bh - 4;
    }

    box.style.left = left + 'px';
    box.style.top = top + 'px';
    [0.42, 0.78].forEach((f, i) => {
      thoughtDots[i].style.left = cx + (a.x - cx) * f + 'px';
      thoughtDots[i].style.top = cy + (a.y - cy) * f + 'px';
    });
  }

  function placeSpeech() {
    const tip = at(G.out, G.narrow ? TIP.narrow : TIP.wide);
    let L, T, W, H, d, tl, tt, tw, th, ox, oy;

    if (G.narrow) {
      L = 12; T = 12; W = G.vw - 24;
      H = Math.max(tip.y - 34 - T, 220);
      tl = 0; tt = H - 1; tw = W; th = Math.max(tip.y - (T + H), 0) + 1;
      const bx = clamp(tip.x - L, 56, W - 56);
      const px = tip.x - L, py = th - 4;
      d = `M${bx - 22} 0 Q${bx - 6} ${th * 0.5} ${px} ${py} Q${bx + 6} ${th * 0.45} ${bx + 20} 0 Z`;
      ox = px; oy = tt + py;
    } else {
      L = 28; T = 28; H = G.vh - 56;
      W = Math.max(Math.min(780, tip.x - 64 - L), Math.min(320, G.vw - 56));
      tl = W - 1; tt = 0; tw = Math.max(tip.x - (L + W), 0) + 1; th = H;
      const by = clamp(tip.y - T, 56, H - 56);
      const px = tw - 6, py = tip.y - T;
      d = `M0 ${by - 22} Q${tw * 0.5} ${by - 6} ${px} ${py} Q${tw * 0.45} ${by + 6} 0 ${by + 20} Z`;
      ox = tl + px; oy = py;
    }

    Object.assign(speech.style, {
      left: L + 'px', top: T + 'px', width: W + 'px', height: H + 'px',
      right: 'auto', bottom: 'auto', transformOrigin: `${ox}px ${oy}px`,
    });
    Object.assign(tail.style, { left: tl + 'px', top: tt + 'px', width: tw + 'px', height: th + 'px' });
    tail.setAttribute('viewBox', `0 0 ${tw} ${th}`);
    tailPath.setAttribute('d', d);
  }

  /* ---------------- thought balloon ---------------- */

  function setState(s) { body.dataset.state = s; }

  // Switch the balloon's content and let it grow or shrink from where it was.
  function morph(mode) {
    const r0 = box.getBoundingClientRect();
    box.getAnimations({ subtree: true }).forEach(a => a.cancel());
    box.dataset.mode = mode;
    placeThought();
    const r1 = box.getBoundingClientRect();
    if (reduced.matches || !r0.width) return;
    box.animate([
      { left: r0.left + 'px', top: r0.top + 'px', width: r0.width + 'px', height: r0.height + 'px' },
      { left: r1.left + 'px', top: r1.top + 'px', width: r1.width + 'px', height: r1.height + 'px' },
    ], { duration: 360, easing: 'cubic-bezier(.3, 1.2, .5, 1)' });
    const part = box.querySelector(`[data-part="${mode}"]`);
    part.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 140, fill: 'backwards' });
  }

  function ask() {
    if (body.dataset.state !== 'idle') return;
    setState('asking');
    morph('form');
    input.focus();
  }

  function cancel() {
    if (body.dataset.state !== 'asking') return;
    setState('idle');
    morph('pill');
    pill.focus();
  }

  function startThinking() {
    let n = 0;
    thinkingDots.textContent = '.';
    dotTimer = setInterval(() => { n = (n + 1) % 3; thinkingDots.textContent = '.'.repeat(n + 1); }, 360);
    status.textContent = 'thinking';
  }

  function stopThinking() {
    clearInterval(dotTimer);
    status.textContent = '';
  }

  async function submit(e) {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    question = q;

    const my = ++run;
    setState('listening');
    morph('thinking');
    box.focus({ preventScroll: true });
    startThinking();

    let answer;
    try {
      const [posts] = await Promise.all([loadPosts(), wait(THINK_MS)]);
      answer = await answerFor(q, posts);
    } catch (err) {
      answer = { html: failureHtml(), route: null, title: HOME_TITLE };
    }
    stopThinking();
    if (my !== run) return;
    speak(answer, { animate: true });
  }

  /* ---------------- speech balloon ---------------- */

  function setRoute(route) {
    try { history.replaceState(null, '', route ? HOME + route : HOME); } catch (_) { /* file:// etc. */ }
  }

  function focusSpeech() { speechBody.focus({ preventScroll: true }); }

  function pop() {
    const frames = reduced.matches
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { transform: 'scale(.08)', opacity: 0 },
          { transform: 'scale(1.025)', opacity: 1, offset: 0.72 },
          { transform: 'scale(1)', opacity: 1 },
        ];
    speech.animate(frames, { duration: reduced.matches ? 300 : POP_MS, easing: 'cubic-bezier(.3, .7, .35, 1)' });
  }

  async function speak({ html, route, title }, { animate = false, keepScroll = false, focus = true } = {}) {
    const my = ++run;
    const top = scroller.scrollTop;
    speechBody.innerHTML = html;
    scroller.scrollTop = keepScroll ? top : 0;
    setRoute(route);
    document.title = title;

    if (body.dataset.state === 'speaking') {          // already open: swap in place
      if (focus) focusSpeech();
      return;
    }

    const wasOut = zoomedOut;
    zoomedOut = true;
    if (!animate || wasOut) {
      setImage(G.out);
      setState('speaking');
      placeSpeech();
      if (focus) focusSpeech();
      return;
    }

    setState('zooming');
    moveImage(G.in, G.out);
    await wait(reduced.matches ? 600 : ZOOM_MS * 0.75);
    if (my !== run) return;
    setState('speaking');
    placeSpeech();
    pop();
    focusSpeech();
  }

  async function back() {
    if (body.dataset.state !== 'speaking') return;
    const my = ++run;
    const close = speech.animate(
      reduced.matches
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.92)', opacity: 0 }],
      { duration: 220, easing: 'ease-in', fill: 'forwards' }
    );
    await close.finished;
    if (my !== run) return;
    setState('zooming');
    close.cancel();

    setRoute(null);
    document.title = HOME_TITLE;
    zoomedOut = false;
    box.dataset.mode = 'form';
    input.value = question;
    placeThought();
    await moveImage(G.out, G.in);
    if (my !== run) return;

    setState('asking');
    placeThought();
    input.focus();
    input.select();
  }

  /* ---------------- posts + matching ---------------- */

  let postsPromise = null;
  const bodies = new Map();

  // search.json text is stripped HTML, so it may still hold entities like &amp;.
  const decoder = document.createElement('textarea');
  const decode = s => { decoder.innerHTML = s || ''; return decoder.value; };

  const words = s => (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean);

  function loadPosts() {
    if (!postsPromise) {
      postsPromise = fetch(SEARCH_URL)
        .then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
        .then(list => list.map(p => ({
          ...p,
          title: decode(p.title),
          excerpt: decode(p.excerpt),
          content: decode(p.content),
          tags: p.tags || [],
          fields: [
            [words(p.title), 3],
            [words((p.tags || []).join(' ')), 3],
            [words(p.keys), 2],
            [words(p.content), 1],
          ],
        })))
        .catch(err => { postsPromise = null; throw err; });
    }
    return postsPromise;
  }

  const STOP = new Set((
    'the and for are but not you your yours yourself with this that these those there their them they ' +
    'what when where which who whom whose why how does did doing done have has had having was were been being ' +
    'will would shall should can could may might must about into onto from than then its it\'s over under ' +
    'very just also some such only own same too more most other all any each few both much many ' +
    'anything something everything nothing thing things someone anyone everyone ' +
    'get got getting make made one ever really lot lots our ours out off his her hers him she ' +
    'don doesn didn isn aren wasn weren won can cant couldn wouldn shouldn haven hasn ' +
    'tell know think want please monolith moai'
  ).split(' '));

  function tokenize(q) {
    return [...new Set(words(q).filter(w => w.length > 2 && !STOP.has(w)))];
  }

  function score(post, tokens) {
    let total = 0;
    for (const t of tokens) {
      const root = t.length > 5 ? t.slice(0, -2) : t;
      for (const [list, weight] of post.fields) {
        if (list.some(w => w.startsWith(root))) total += weight;
      }
    }
    return total;
  }

  function rank(q, posts) {
    const tokens = tokenize(q);
    return posts
      .map((p, i) => ({ p, i, s: tokens.length ? score(p, tokens) : 0 }))
      .sort((a, b) => b.s - a.s || a.i - b.i);
  }

  function fetchBody(p) {
    if (!bodies.has(p.id)) {
      bodies.set(p.id, fetch(p.url)
        .then(r => (r.ok ? r.text() : Promise.reject(new Error(r.status))))
        .then(text => {
          const doc = new DOMParser().parseFromString(text, 'text/html');
          const el = doc.querySelector('article .post-body');
          if (!el) throw new Error('no article');
          return el.innerHTML;
        })
        .catch(() => { bodies.delete(p.id); return `<p>${esc(p.content)}</p>`; }));
    }
    return bodies.get(p.id);
  }

  async function answerFor(q, posts) {
    const ranked = rank(q, posts);
    if (!ranked.length || ranked[0].s === 0) {
      return archiveAnswer(posts, null, 'I haven’t thought about that yet. Here is what I have thought about.');
    }
    const top = ranked[0].p;
    const near = ranked.slice(1).filter(r => r.s > 0).slice(0, 2).map(r => r.p);
    return postAnswer(top, posts, { asked: q, near });
  }

  /* ---------------- views ---------------- */

  const tagLink = t =>
    `<a class="tag" href="${esc(HOME)}#/all/${encodeURIComponent(t)}" data-tag="${esc(t)}">${esc(t)}</a>`;

  const nearRow = p =>
    `<li><a class="near-row" href="${esc(p.url)}" data-slug="${esc(p.id)}"><span class="near-title">${esc(p.title)}</span><time>${esc(p.date)}</time></a></li>`;

  async function postAnswer(p, posts, { asked = null, near = [] } = {}) {
    const bodyHtml = await fetchBody(p);
    const isNear = asked && near.length;
    const list = isNear ? near : posts.filter(x => x.id !== p.id).slice(0, 3);
    const html = `
      ${asked ? `<p class="asked">you asked — “${esc(asked)}”</p>` : ''}
      <article class="post" data-slug="${esc(p.id)}">
        <h1 class="post-title">${esc(p.title)}</h1>
        <p class="post-meta"><time>${esc(p.date)}</time>${p.tags.map(tagLink).join('')}</p>
        <div class="post-body">${bodyHtml}</div>
      </article>
      ${list.length ? `<aside class="near">
        <h2 class="near-heading">${isNear ? 'also near your question' : 'other things it has said'}</h2>
        <ul class="near-list">${list.map(nearRow).join('')}</ul>
      </aside>` : ''}`;
    return { html, route: '#/' + p.id, title: `${p.title} — ${SITE}` };
  }

  function archiveAnswer(posts, tag, note = null) {
    const tags = [...new Set(posts.flatMap(p => p.tags))].sort();
    if (tag && !tags.includes(tag)) tag = null;
    const shown = tag ? posts.filter(p => p.tags.includes(tag)) : posts;
    const chip = (value, label) =>
      `<button class="chip" type="button" data-filter="${esc(value)}" aria-pressed="${(tag || '') === value}">${esc(label)}</button>`;
    const row = p => `
      <li><a class="row" href="${esc(p.url)}" data-slug="${esc(p.id)}">
        <span class="row-meta">${esc(p.date)}${p.tags.length ? ' · ' + esc(p.tags.join(', ')) : ''}</span>
        <span class="row-title">${esc(p.title)}</span>
        <span class="row-excerpt">${esc(p.excerpt)}</span>
      </a></li>`;
    const html = `
      ${note ? `<p class="note">${esc(note)}</p>` : ''}
      <div class="archive">
        <h1 class="archive-title">Everything it has said</h1>
        ${tags.length ? `<div class="chips" role="group" aria-label="Filter by tag">${chip('', 'all')}${tags.map(t => chip(t, t)).join('')}</div>` : ''}
        <ul class="rows">${shown.length ? shown.map(row).join('') : '<li class="empty">Nothing yet.</li>'}</ul>
      </div>`;
    return { html, route: tag ? '#/all/' + encodeURIComponent(tag) : '#/all', title: `Everything — ${SITE}` };
  }

  function failureHtml() {
    return `<p class="note">I can’t reach my own words right now. Ask again in a moment.</p>`;
  }

  /* ---------------- navigation ---------------- */

  async function openPost(id, opts = {}) {
    let posts;
    try { posts = await loadPosts(); } catch (_) { return; }
    const p = posts.find(x => x.id === id);
    if (!p) return openArchive(null, opts);
    speak(await postAnswer(p, posts), opts);
  }

  async function openArchive(tag, opts = {}) {
    let posts;
    try { posts = await loadPosts(); } catch (_) { return; }
    speak(archiveAnswer(posts, tag), opts);
  }

  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    if (!h) return null;
    const [first, second] = h.split('/').map(s => { try { return decodeURIComponent(s); } catch (_) { return s; } });
    if (first === 'all') return { type: 'all', tag: second || null };
    return { type: 'post', id: first };
  }

  function go(route, opts) {
    return route.type === 'all' ? openArchive(route.tag, opts) : openPost(route.id, opts);
  }

  /* ---------------- events ---------------- */

  pill.addEventListener('click', ask);
  form.addEventListener('submit', submit);
  $('[data-action="cancel"]', form).addEventListener('click', cancel);

  readAll.addEventListener('click', e => {
    e.preventDefault();
    const s = body.dataset.state;
    if (s === 'idle' || s === 'asking') openArchive(null, { animate: true });
  });

  speech.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const t = e.target.closest('.again, [data-slug], [data-tag], [data-filter], [data-view="all"]');
    if (!t || !speech.contains(t)) return;
    e.preventDefault();
    if (t.matches('.again')) back();
    else if (t.hasAttribute('data-filter')) {
      const value = t.dataset.filter;
      openArchive(value || null, { keepScroll: true, focus: false }).then(() => {
        const same = speechBody.querySelector(`[data-filter="${CSS.escape(value)}"]`);
        if (same) same.focus();
      });
    }
    else if (t.hasAttribute('data-tag')) openArchive(t.dataset.tag);
    else if (t.dataset.view === 'all') openArchive(null);
    else openPost(t.dataset.slug);
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const s = body.dataset.state;
    if (s === 'asking') { e.preventDefault(); cancel(); }
    else if (s === 'speaking') { e.preventDefault(); back(); }
  });

  window.addEventListener('hashchange', () => {
    const route = parseHash();
    if (route) go(route, { animate: body.dataset.state !== 'speaking' });
  });

  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    // A phone keyboard opening only shrinks the height; keep the scene still.
    if (document.activeElement === input && window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    layout();
  });

  if (!img.complete) img.addEventListener('load', layout, { once: true });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeThought);

  /* ---------------- start ---------------- */

  function start() {
    const route = parseHash();
    const onPost = body.dataset.page === 'post';
    zoomedOut = onPost || !!route;
    layout();

    if (onPost) {
      const article = $('article.post', speechBody);
      const bodyEl = $('.post-body', speechBody);
      if (article && bodyEl) bodies.set(article.dataset.slug, Promise.resolve(bodyEl.innerHTML));
      setState('speaking');
    } else if (route) {
      setState('wait');
      go(route, { animate: false, focus: false });
    } else {
      box.dataset.mode = 'pill';
      setState('idle');
      placeThought();
    }
    requestAnimationFrame(() => body.classList.add('ready'));
  }

  start();
})();
