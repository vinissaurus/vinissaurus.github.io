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
  const thoughtDots = [$('.thought-dot.d1'), $('.thought-dot.d2')];
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
  const ZOOM_MS = 1600;
  const THINK_MS = 1300;
  const FADE_MS = 650;                 // reduced motion: crossfade length
  const MX = 0.652, MY = 0.62;         // the moai's head, as fractions of the image
  const TOP_CLEAR = 68;                // narrow screens: the question form stays below the language toggle

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  let G = null;          // geometry for the current viewport
  let zoomedOut = false;
  let run = 0;           // bumps on every transition; stale async steps bail out
  let dotTimer = 0;

  /* ---------------- language ----------------
   * Interface text comes from _data/i18n.yml, embedded in the page as JSON.
   * Elements carry data-i18n="key" (text) or data-i18n-attr="attr:key;…",
   * so switching language rewrites them in place, including rendered views.
   */

  const I18N = JSON.parse($('#i18n').textContent);
  const LANGS = I18N.languages.map(l => l.code);
  const DEFAULT_LANG = LANGS[0];
  const LANG_KEY = 'monolith.lang';

  function pickLang() {
    let saved = null;
    try { saved = localStorage.getItem(LANG_KEY); } catch (_) { /* storage blocked */ }
    if (LANGS.includes(saved)) return saved;
    // First visit: follow the browser if it prefers one of our languages.
    for (const want of navigator.languages || [navigator.language || '']) {
      const base = want.toLowerCase().split('-')[0];
      const hit = LANGS.find(code => code.toLowerCase() === want.toLowerCase())
               || LANGS.find(code => code.toLowerCase().split('-')[0] === base);
      if (hit) return hit;
    }
    return DEFAULT_LANG;
  }

  let lang = pickLang();
  let title = { key: 'home_title' };   // what document.title is built from

  const t = key => {
    const table = I18N.strings[lang] || {};
    return key in table ? table[key] : (I18N.strings[DEFAULT_LANG][key] ?? key);
  };

  // Tags are written in English in the posts; _data/i18n.yml names them per language.
  const tagName = (tag, code = lang) => ((I18N.tags || {})[code] || {})[tag] || tag;

  // A title is either fixed text, an interface key, or one text per language.
  function setTitle(spec) {
    title = spec;
    if (typeof spec === 'string') document.title = spec;
    else if (spec.byLang) document.title = (spec.byLang[lang] || spec.byLang[DEFAULT_LANG]) + (spec.suffix || '');
    else document.title = t(spec.key) + (spec.suffix || '');
  }

  function applyLang() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-lang-only]').forEach(el => { el.hidden = el.dataset.langOnly !== lang; });
    document.querySelectorAll('[data-i18n-tag]').forEach(el => { el.textContent = tagName(el.dataset.i18nTag); });
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-attr]').forEach(el => {
      el.dataset.i18nAttr.split(';').forEach(pair => {
        const [attr, key] = pair.split(':');
        el.setAttribute(attr.trim(), t(key.trim()));
      });
    });
    document.querySelectorAll('.lang-btn').forEach(b => b.setAttribute('aria-pressed', b.dataset.lang === lang));
    if (body.dataset.state === 'listening') status.textContent = t('thinking');
    setTitle(title);
  }

  function setLang(code) {
    if (!LANGS.includes(code) || code === lang) return;
    lang = code;
    try { localStorage.setItem(LANG_KEY, code); } catch (_) { /* storage blocked */ }
    applyLang();
    if (G) placeThought();
  }

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
    let ay = Math.max(head.y, asking ? 200 : 90);
    form.style.width = askW + 'px';
    // On narrow screens the form spans the width; keep it below the language toggle.
    if (!G.wide) ay = Math.max(ay, TOP_CLEAR + thought.offsetHeight);
    thought.style.right = G.vw - ax + 'px';
    thought.style.bottom = G.vh - ay + 'px';
    placeDots(ax, ay);
  }

  // Wide screens keep the dots at the balloon's bottom-right corner (CSS).
  // On narrow screens the balloon spans the width and the moai is centred,
  // so the dots leave the bottom edge and head for the top of its head.
  function placeDots(ax, ay) {
    const [d1, d2] = thoughtDots;
    if (G.wide) { d1.removeAttribute('style'); d2.removeAttribute('style'); return; }

    const w = thought.offsetWidth, h = thought.offsetHeight;
    const left = ax - w, top = ay - h;
    const hat = at(G.in, MX, 0.44);
    const sx = clamp(hat.x, left + 34, ax - 34);   // leave from the bottom edge, above the head
    const sy = ay;
    let dx = hat.x - sx, dy = hat.y - sy;
    if (dy < 24) { dx = 0; dy = 40; }              // head tucked under the balloon: point down
    const len = Math.hypot(dx, dy);
    if (len > 64) { dx *= 64 / len; dy *= 64 / len; }

    [[d1, 0.4, 14], [d2, 0.85, 8]].forEach(([d, f, size]) => {
      d.style.right = 'auto';
      d.style.bottom = 'auto';
      d.style.left = sx + dx * f - left - size / 2 + 'px';
      d.style.top = sy + dy * f - top - size / 2 + 'px';
    });
  }

  function placeSpeech() {
    const { vw, vh, W, H, out } = G;
    const headX = out.x + 0.65 * W;
    const headY = out.y + 0.53 * H;
    let bx, by, bw, bh, tx, ty;

    if (G.wide) {
      const right = headX - 0.03 * W - 34;
      bw = Math.min(780, right - 24); bx = right - bw; by = 28; bh = vh - 56;
      tx = bw; ty = clamp(headY - by, 60, bh - 60);
    } else {
      // Narrow: reading comes first. The balloon takes 90% of the height and
      // the tail points down at what is left of the moai below it.
      bx = 12; bw = vw - 24; by = 12;
      bh = Math.round(vh * 0.9) - by;
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
    status.textContent = t('thinking');
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
      answer = { html: failureHtml(), route: null, title: { key: 'home_title' } };
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

  async function speak({ html, route, title: pageTitle }, { animate = false, keepScroll = false, focus = true } = {}) {
    const my = ++run;
    const top = scroller.scrollTop;
    speechBody.innerHTML = html;
    scroller.scrollTop = keepScroll ? top : 0;
    setRoute(route);
    setTitle(pageTitle);

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
    setTitle({ key: 'home_title' });
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

  // English and Portuguese words too common to say anything about a question.
  // Written without accents: questions and posts are compared that way.
  const STOP = new Set((
    'the a an and or but is are was were be been am i you me my your we it its of to in on at for with ' +
    'what why how who when where which that this do does did can could would should will about there ' +
    'their them they have has had not no so if as by from into just any anything something thing things really ' +
    'que por porque para pra com sem uma umas uns dos das nos nas num numa pelo pela pelos pelas ' +
    'qual quais quem quando onde como isso isto esse essa este esta aquilo voce voces ele ela eles elas ' +
    'meu minha seu sua nao sim mais muito muita ja tem ter tenho estou esta sao ser foi era ' +
    'algo alguma algum coisa coisas nada tudo tambem aos sempre'
  ).split(' '));

  const text = v => (Array.isArray(v) ? v.join(' ') : typeof v === 'string' ? v : '');
  const words = s => text(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .match(/[a-z']+/g) || [];

  // search.json text is stripped HTML, so it may still hold entities like &amp;.
  const decoder = document.createElement('textarea');
  const decode = s => { decoder.innerHTML = s || ''; return decoder.value; };

  let postsPromise = null;
  const bodies = new Map();

  // Each post gets one text per language: its translation, or the original
  // (with the original's lang) where there is none.
  function prepare(p) {
    const tags = p.tags || [];
    const textFor = code => {
      const tr = code === DEFAULT_LANG ? p : (p.translations || {})[code];
      const src = tr || p;
      return {
        lang: tr ? code : DEFAULT_LANG,
        title: decode(src.title),
        keys: text(src.keys),
        excerpt: decode(src.excerpt),
        content: decode(src.content),
      };
    };
    const texts = Object.fromEntries(LANGS.map(code => [code, textFor(code)]));
    const fields = LANGS.map(code => [
      [words(texts[code].title), 3],
      [words(tags.map(tag => tagName(tag, code)).join(' ')), 3],
      [words(texts[code].keys), 2],
      [words(texts[code].content), 1],
    ]);
    return { id: p.id, url: p.url, date: p.date, tags, texts, fields, title: texts[DEFAULT_LANG].title };
  }

  function loadPosts() {
    if (!postsPromise) {
      postsPromise = fetch(SEARCH_URL)
        .then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
        .then(list => list.map(prepare))
        .catch(err => { postsPromise = null; throw err; });
    }
    return postsPromise;
  }

  // Each question word (or its root) is prefix-matched against each field.
  // A post is scored in each language separately and keeps its best score,
  // so a question in either language finds it.
  function rank(q, posts) {
    const tokens = words(q).filter(w => w.length > 2 && !STOP.has(w));
    const score = fields => {
      let s = 0;
      for (const tok of tokens) {
        const root = tok.length > 5 ? tok.slice(0, -2) : tok;
        for (const [list, weight] of fields) {
          if (list.some(x => x.startsWith(root) || (x.length > 4 && tok.startsWith(x)))) s += weight;
        }
      }
      return s;
    };
    return posts
      .map(p => ({ p, s: Math.max(...p.fields.map(score)) }))
      .sort((a, b) => b.s - a.s);
  }

  // The post's own page holds its body in every language; take them all.
  function fetchBody(p) {
    if (!bodies.has(p.id)) {
      bodies.set(p.id, fetch(p.url)
        .then(r => (r.ok ? r.text() : Promise.reject(new Error(r.status))))
        .then(html => {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const found = readBodies(doc);
          if (!found) throw new Error('no article');
          return found;
        })
        .catch(() => {
          bodies.delete(p.id);
          return Object.fromEntries(LANGS.map(code => [code, `<p>${esc(p.texts[code].content)}</p>`]));
        }));
    }
    return bodies.get(p.id);
  }

  function readBodies(root) {
    const els = [...root.querySelectorAll('article .post-body')];
    if (!els.length) return null;
    const byLang = {};
    for (const el of els) byLang[el.dataset.langOnly || DEFAULT_LANG] = el.innerHTML;
    for (const code of LANGS) if (!(code in byLang)) byLang[code] = byLang[DEFAULT_LANG] || els[0].innerHTML;
    return byLang;
  }

  async function answerFor(q, posts) {
    const ranked = rank(q, posts);
    if (!ranked.length || ranked[0].s === 0) return archiveAnswer(posts, null, q);
    const near = ranked.slice(1).filter(r => r.s > 0).slice(0, 2).map(r => r.p);
    return postAnswer(ranked[0].p, posts, { asked: q, near });
  }

  /* ---------------- views ----------------
   * Interface text is marked with data-i18n, tags with data-i18n-tag, and post
   * text is written once per language with data-lang-only. A language switch
   * rewrites or reveals these in place, so views never need re-rendering.
   */

  const ui = (key, tagName_ = 'span', attrs = '') =>
    `<${tagName_}${attrs} data-i18n="${key}">${esc(t(key))}</${tagName_}>`;

  // One element per language; only the current one is visible.
  const variants = (p, render, el = 'span', attrs = '') => LANGS.map(code =>
    `<${el}${attrs} data-lang-only="${code}" lang="${p.texts[code].lang}"${code === lang ? '' : ' hidden'}>${render(p.texts[code], code)}</${el}>`
  ).join('');

  const tagLabel = tag => `<span data-i18n-tag="${esc(tag)}">${esc(tagName(tag))}</span>`;

  const asked = q => `<div class="asked">${ui('you_asked')} <span class="q">“${esc(q)}”</span></div>`;

  const tagLink = tag =>
    `<a class="tag hit" href="${esc(HOME)}#/all/${encodeURIComponent(tag)}" data-tag="${esc(tag)}" data-i18n-tag="${esc(tag)}">${esc(tagName(tag))}</a>`;

  const relatedRow = p =>
    `<a class="related-row" href="${esc(p.url)}" data-slug="${esc(p.id)}">${variants(p, x => esc(x.title))}<time>${esc(p.date)}</time></a>`;

  const excerpt = s => (s.length > 150 ? s.slice(0, 150).replace(/\s+\S*$/, '') + '…' : s);

  const titleOf = p => ({ byLang: Object.fromEntries(LANGS.map(code => [code, p.texts[code].title])), suffix: ` — ${SITE}` });

  async function postAnswer(p, posts, { asked: q = null, near = [] } = {}) {
    const bodyHtml = await fetchBody(p);
    const isNear = !!q && near.length > 0;
    const list = isNear ? near : posts.filter(x => x.id !== p.id).slice(0, 3);
    const html = `
      <article class="post" data-slug="${esc(p.id)}">
        ${q ? asked(q) : ''}
        <h1 class="post-title">${variants(p, x => esc(x.title))}</h1>
        <div class="post-meta"><time>${esc(p.date)}</time>${p.tags.map(tagLink).join('')}</div>
        ${variants(p, (x, code) => bodyHtml[code], 'div', ' class="post-body"')}
        <nav class="related" aria-label="${esc(t('other_posts'))}" data-i18n-attr="aria-label:other_posts">
          ${ui(isNear ? 'also_near' : 'other_things', 'div', ' class="related-label"')}
          ${list.map(relatedRow).join('')}
        </nav>
      </article>`;
    return { html, route: '#/' + p.id, title: titleOf(p) };
  }

  function archiveAnswer(posts, tag, unanswered = null) {
    const tags = [...new Set(posts.flatMap(p => p.tags))];
    if (tag && !tags.includes(tag)) tag = null;
    const shown = tag ? posts.filter(p => p.tags.includes(tag)) : posts;
    const pressed = value => `aria-pressed="${(tag || '') === value}"`;
    const chips = [
      `<button class="chip hit" type="button" data-filter="" ${pressed('')} data-i18n="all">${esc(t('all'))}</button>`,
      ...tags.map(x => `<button class="chip hit" type="button" data-filter="${esc(x)}" ${pressed(x)} data-i18n-tag="${esc(x)}">${esc(tagName(x))}</button>`),
    ];
    const row = p => `
      <a class="row" href="${esc(p.url)}" data-slug="${esc(p.id)}">
        <span class="row-meta">${esc(p.date)} · ${p.tags.map(tagLabel).join(', ')}</span>
        ${variants(p, x => esc(x.title), 'span', ' class="row-title"')}
        ${variants(p, x => esc(excerpt(x.excerpt)), 'span', ' class="row-excerpt"')}
      </a>`;
    const html = `
      <section class="archive">
        ${unanswered ? `<div class="notice">${asked(unanswered)}${ui('no_match', 'p', ' class="note"')}</div>` : ''}
        ${ui('archive_title', 'h1', ' class="archive-title"')}
        <div class="chips" role="group" aria-label="${esc(t('filter_label'))}" data-i18n-attr="aria-label:filter_label">${chips.join('')}</div>
        <div class="rows">${shown.map(row).join('')}</div>
      </section>`;
    const route = tag ? '#/all/' + encodeURIComponent(tag) : '#/all';
    return { html, route, title: { key: 'archive_page_title', suffix: ` — ${SITE}` } };
  }

  function failureHtml() {
    return `<section class="archive">${ui('failure', 'p', ' class="note"')}</section>`;
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

  document.querySelectorAll('.lang-btn').forEach(b => b.addEventListener('click', () => setLang(b.dataset.lang)));

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
    const article = onPost && $('article.post', speechBody);
    if (article) {
      // The page already holds this post in every language.
      const byLang = {};
      article.querySelectorAll('.post-title [data-lang-only]').forEach(el => { byLang[el.dataset.langOnly] = el.textContent; });
      title = Object.keys(byLang).length ? { byLang, suffix: ` — ${SITE}` } : document.title;
      const found = readBodies(document);
      if (found) bodies.set(article.dataset.slug, Promise.resolve(found));
    }
    applyLang();

    instantly(() => {
      layout();
      if (onPost) {
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
