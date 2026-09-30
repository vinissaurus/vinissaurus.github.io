/* monolith — the moai oracle.
 *
 * One page, one state machine:
 *   idle → asking → listening → zooming → speaking → unzooming → asking
 * The image is laid out once per viewport as a "cover" rectangle (scale 1),
 * and zoomed in on the head with a single transform.
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
  const thought = $('.thought');
  const pill = $('.thought-pill');
  const form = $('.thought-form');
  const input = $('#question');
  const askBtn = $('.btn-ask');
  const thinking = $('.thought-thinking');
  const thinkingDots = $('.thinking-dots');
  const status = $('#status');
  const speech = $('.speech');
  const tail = $('.speech-tail');
  const scroller = $('.speech-scroll');
  const speechBody = $('#speech-body');

  const HOME = body.dataset.home || '/';
  const SEARCH_URL = body.dataset.search || HOME + 'search.json';
  const SITE = body.dataset.site || 'monolith';
  const HOME_TITLE = document.title;

  const ZOOM_MS = 1600;
  const THINK_MS = 1300;
  const FADE_MS = 650;                 // reduced motion: crossfade length
  const MX = 0.652, MY = 0.62;         // the moai's head, as fractions of the image

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  let G = null;          // geometry for the current viewport
  let zoomedOut = false;
  let run = 0;           // bumps on every transition; stale async steps bail out
  let dotTimer = 0;

  /* ---------------- geometry ---------------- */

  function geometry() {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const R = (img.naturalWidth || +img.getAttribute('width')) /
              (img.naturalHeight || +img.getAttribute('height'));
    const W = Math.max(vw, vh * R);
    const H = W / R;
    const wide = vw >= 900;

    // Scale 1: the moai sits right of centre on wide screens, centred on narrow ones.
    const farL = wide ? clamp(vw - 0.85 * W, vw - W, 0) : clamp(vw / 2 - MX * W, vw - W, 0);
    const farT = (vh - H) / 2;

    // Zoomed in: the statue is ~85% of the viewport height, head near the middle.
    const S = clamp(0.85 * vh / (0.42 * H), 1.4, 3);
    const pn = { x: vw * (vw >= 700 ? 0.58 : 0.5), y: vh * 0.56 };

    return {
      vw, vh, wide, W, H,
      out: { x: farL, y: farT, s: 1 },
      in: { x: pn.x - MX * W * S, y: pn.y - MY * H * S, s: S },
    };
  }

  const at = (t, u, v) => ({ x: t.x + u * G.W * t.s, y: t.y + v * G.H * t.s });
  const transformOf = t => `translate(${t.x}px, ${t.y}px) scale(${t.s})`;

  // Turn transitions off until the next frame has been painted.
  function instantly(fn) {
    body.classList.add('instant');
    fn();
    void body.offsetWidth;
    requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove('instant')));
  }

  function moveImage(to) {
    if (!reduced.matches) { img.style.transform = transformOf(to); return; }
    const out = img.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, fill: 'forwards' });
    out.finished.then(() => {
      img.style.transform = transformOf(to);
      img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400 });
      out.cancel();
    });
  }

  function layout() {
    G = geometry();
    img.style.width = G.W + 'px';
    img.style.height = G.H + 'px';
    img.style.objectFit = 'fill';
    img.style.transform = transformOf(zoomedOut ? G.out : G.in);
    placeThought();
    placeSpeech();
  }

  function placeThought() {
    const asking = thought.dataset.mode === 'form';
    const askW = Math.min(360, G.vw - 56);
    const curW = asking ? askW : 190;
    const head = at(G.in, 0.62, 0.45);
    const ax = Math.max(head.x, curW + 20);
    const ay = Math.max(head.y, asking ? 200 : 90);
    form.style.width = askW + 'px';
    thought.style.right = G.vw - ax + 'px';
    thought.style.bottom = G.vh - ay + 'px';
  }

  function placeSpeech() {
    const { vw, vh, W, H, out } = G;
    const headX = out.x + 0.65 * W;
    const headY = out.y + 0.53 * H;
    const capY = out.y + 0.44 * H;
    let bx, by, bw, bh, tx, ty;

    if (G.wide) {
      const right = headX - 0.03 * W - 34;
      bw = Math.min(780, right - 24); bx = right - bw; by = 28; bh = vh - 56;
      tx = bw; ty = clamp(headY - by, 60, bh - 60);
    } else {
      bx = 12; bw = vw - 24; by = 12;
      bh = Math.min(Math.max(320, capY - 34 - by), vh - 24);
      tx = clamp(headX - bx, 40, bw - 40); ty = bh;
    }

    Object.assign(speech.style, {
      left: bx + 'px', top: by + 'px', width: bw + 'px', height: bh + 'px',
      right: 'auto', bottom: 'auto', transformOrigin: `${tx}px ${ty}px`,
    });
    tail.style.left = tx - 13 + 'px';
    tail.style.top = ty - 13 + 'px';
  }

  /* ---------------- thought balloon ---------------- */

  function setState(s) { body.dataset.state = s; }

  function setMode(mode) {
    thought.dataset.mode = mode;
    placeThought();
  }

  function syncAskBtn() { askBtn.classList.toggle('ready', !!input.value.trim()); }

  function ask() {
    if (body.dataset.state !== 'idle') return;
    setState('asking');
    setMode('form');
    input.focus();
  }

  function cancel() {
    if (body.dataset.state !== 'asking') return;
    input.value = '';
    syncAskBtn();
    setState('idle');
    setMode('pill');
    pill.focus();
  }

  function startThinking() {
    let n = 1;
    thinkingDots.textContent = '·';
    dotTimer = setInterval(() => { n = (n % 3) + 1; thinkingDots.textContent = '·'.repeat(n); }, 280);
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

    const my = ++run;
    setState('listening');
    setMode('thinking');
    thinking.focus({ preventScroll: true });
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
    try { history.replaceState(null, '', route ? HOME + route : HOME); } catch (_) { /* file:// */ }
  }

  function focusSpeech() { speechBody.focus({ preventScroll: true }); }

  async function speak({ html, route, title }, { animate = false, keepScroll = false, focus = true } = {}) {
    const my = ++run;
    const top = scroller.scrollTop;
    speechBody.innerHTML = html;
    scroller.scrollTop = keepScroll ? top : 0;
    setRoute(route);
    document.title = title;

    if (body.dataset.state === 'speaking') {        // already open: swap in place
      if (focus) focusSpeech();
      return;
    }

    const wasOut = zoomedOut;
    zoomedOut = true;
    if (!animate || wasOut) {
      instantly(() => {
        img.style.transform = transformOf(G.out);
        setState('speaking');
      });
      if (focus) focusSpeech();
      return;
    }

    setState('zooming');
    moveImage(G.out);
    await wait(reduced.matches ? FADE_MS : ZOOM_MS * 0.75);
    if (my !== run) return;
    setState('speaking');
    focusSpeech();
  }

  async function back() {
    if (body.dataset.state !== 'speaking') return;
    const my = ++run;
    setRoute(null);
    document.title = HOME_TITLE;
    input.value = '';
    syncAskBtn();
    setState('unzooming');
    setMode('form');
    zoomedOut = false;
    moveImage(G.in);
    await wait(reduced.matches ? FADE_MS : ZOOM_MS * 0.9);
    if (my !== run) return;
    setState('asking');
    input.focus();
  }

  /* ---------------- posts + matching ---------------- */

  const STOP = new Set((
    'the a an and or but is are was were be been am i you me my your we it its of to in on at for with ' +
    'what why how who when where which that this do does did can could would should will about there ' +
    'their them they have has had not no so if as by from into just any anything something thing things really'
  ).split(' '));

  const words = s => (s || '').toLowerCase().match(/[a-z']+/g) || [];

  // search.json text is stripped HTML, so it may still hold entities like &amp;.
  const decoder = document.createElement('textarea');
  const decode = s => { decoder.innerHTML = s || ''; return decoder.value; };

  let postsPromise = null;
  const bodies = new Map();

  function loadPosts() {
    if (!postsPromise) {
      postsPromise = fetch(SEARCH_URL)
        .then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
        .then(list => list.map(p => {
          const post = {
            ...p,
            title: decode(p.title),
            excerpt: decode(p.excerpt),
            content: decode(p.content),
            tags: p.tags || [],
          };
          post.fields = [
            [words(post.title), 3],
            [words(post.tags.join(' ')), 3],
            [words(post.keys), 2],
            [words(post.content), 1],
          ];
          return post;
        }))
        .catch(err => { postsPromise = null; throw err; });
    }
    return postsPromise;
  }

  // Each question word (or its root) is prefix-matched against each field.
  function rank(q, posts) {
    const tokens = words(q).filter(t => t.length > 2 && !STOP.has(t));
    return posts.map(p => {
      let s = 0;
      for (const t of tokens) {
        const root = t.length > 5 ? t.slice(0, -2) : t;
        for (const [list, weight] of p.fields) {
          if (list.some(x => x.startsWith(root) || (x.length > 4 && t.startsWith(x)))) s += weight;
        }
      }
      return { p, s };
    }).sort((a, b) => b.s - a.s);
  }

  function fetchBody(p) {
    if (!bodies.has(p.id)) {
      bodies.set(p.id, fetch(p.url)
        .then(r => (r.ok ? r.text() : Promise.reject(new Error(r.status))))
        .then(text => {
          const el = new DOMParser().parseFromString(text, 'text/html').querySelector('article .post-body');
          if (!el) throw new Error('no article');
          return el.innerHTML;
        })
        .catch(() => { bodies.delete(p.id); return `<p>${esc(p.content)}</p>`; }));
    }
    return bodies.get(p.id);
  }

  async function answerFor(q, posts) {
    const ranked = rank(q, posts);
    if (!ranked.length || ranked[0].s === 0) return archiveAnswer(posts, null, q);
    const near = ranked.slice(1).filter(r => r.s > 0).slice(0, 2).map(r => r.p);
    return postAnswer(ranked[0].p, posts, { asked: q, near });
  }

  /* ---------------- views ---------------- */

  const asked = q => `<div class="asked">you asked — <span>“${esc(q)}”</span></div>`;

  const tagLink = t =>
    `<a class="tag hit" href="${esc(HOME)}#/all/${encodeURIComponent(t)}" data-tag="${esc(t)}">${esc(t)}</a>`;

  const relatedRow = p =>
    `<a class="related-row" href="${esc(p.url)}" data-slug="${esc(p.id)}"><span>${esc(p.title)}</span><time>${esc(p.date)}</time></a>`;

  const excerpt = s => (s.length > 150 ? s.slice(0, 150).replace(/\s+\S*$/, '') + '…' : s);

  async function postAnswer(p, posts, { asked: q = null, near = [] } = {}) {
    const bodyHtml = await fetchBody(p);
    const isNear = !!q && near.length > 0;
    const list = isNear ? near : posts.filter(x => x.id !== p.id).slice(0, 3);
    const html = `
      <article class="post" data-slug="${esc(p.id)}">
        ${q ? asked(q) : ''}
        <h1 class="post-title">${esc(p.title)}</h1>
        <div class="post-meta"><time>${esc(p.date)}</time>${p.tags.map(tagLink).join('')}</div>
        <div class="post-body">${bodyHtml}</div>
        <nav class="related" aria-label="Other posts">
          <div class="related-label">${isNear ? 'also near your question' : 'other things it has said'}</div>
          ${list.map(relatedRow).join('')}
        </nav>
      </article>`;
    return { html, route: '#/' + p.id, title: `${p.title} — ${SITE}` };
  }

  function archiveAnswer(posts, tag, unanswered = null) {
    const tags = [...new Set(posts.flatMap(p => p.tags))];
    if (tag && !tags.includes(tag)) tag = null;
    const shown = tag ? posts.filter(p => p.tags.includes(tag)) : posts;
    const chip = (value, label) =>
      `<button class="chip hit" type="button" data-filter="${esc(value)}" aria-pressed="${(tag || '') === value}">${esc(label)}</button>`;
    const row = p => `
      <a class="row" href="${esc(p.url)}" data-slug="${esc(p.id)}">
        <span class="row-meta">${esc(p.date)} · ${esc(p.tags.join(', '))}</span>
        <span class="row-title">${esc(p.title)}</span>
        <span class="row-excerpt">${esc(excerpt(p.excerpt))}</span>
      </a>`;
    const html = `
      <section class="archive">
        ${unanswered ? `<div class="notice">${asked(unanswered)}<p class="note">I haven't thought about that yet. Here is what I have thought about.</p></div>` : ''}
        <h1 class="archive-title">Everything it has said</h1>
        <div class="chips" role="group" aria-label="Filter by tag">${chip('', 'all')}${tags.map(t => chip(t, t)).join('')}</div>
        <div class="rows">${shown.map(row).join('')}</div>
      </section>`;
    return { html, route: tag ? '#/all/' + encodeURIComponent(tag) : '#/all', title: `Everything — ${SITE}` };
  }

  function failureHtml() {
    return `<section class="archive"><p class="note">I can't reach my own words right now. Ask again in a moment.</p></section>`;
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
    return first === 'all' ? { type: 'all', tag: second || null } : { type: 'post', id: first };
  }

  const go = (route, opts) => (route.type === 'all' ? openArchive(route.tag, opts) : openPost(route.id, opts));

  /* ---------------- events ---------------- */

  pill.addEventListener('click', ask);
  form.addEventListener('submit', submit);
  input.addEventListener('input', syncAskBtn);
  $('[data-action="cancel"]', form).addEventListener('click', cancel);

  $('.read-all button').addEventListener('click', () => {
    const s = body.dataset.state;
    if (s === 'idle' || s === 'asking') openArchive(null, { animate: true });
  });

  speech.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const t = e.target.closest('.again, [data-slug], [data-tag], [data-filter], [data-view="all"]');
    if (!t || t.closest('.post-body')) return;
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
    instantly(layout);
  });

  if (!img.complete) img.addEventListener('load', () => instantly(layout), { once: true });

  /* ---------------- start ---------------- */

  function start() {
    const route = parseHash();
    const onPost = body.dataset.page === 'post';
    zoomedOut = onPost || !!route;

    instantly(() => {
      layout();
      if (onPost) {
        const article = $('article.post', speechBody);
        const bodyEl = $('.post-body', speechBody);
        if (article && bodyEl) bodies.set(article.dataset.slug, Promise.resolve(bodyEl.innerHTML));
        setState('speaking');
      } else if (route) {
        setState('wait');
      } else {
        setMode('pill');
        setState('idle');
      }
      body.classList.add('ready');
    });

    if (!onPost && route) go(route, { animate: false, focus: false });
  }

  start();
})();
