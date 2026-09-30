# monolith

A blog that is one scene: a moai in a night field. Visitors ask it a question and it answers with the closest post. The site is plain Jekyll, which GitHub Pages builds natively, so there is no build step or Actions workflow.

## How it fits together

| File | What it does |
| --- | --- |
| `_posts/*.md` | The posts, in Markdown. |
| `_layouts/default.html` | The scene: image, thought balloon, speech balloon, Open Graph tags. |
| `_layouts/post.html` | A post inside the speech balloon. Each post also gets a real page at `/posts/{slug}/` for sharing, search engines and visitors without JavaScript. |
| `index.html` | The home page. Without JavaScript it shows the full archive. |
| `search.json` | Built by Jekyll from all posts. The oracle searches this in the browser. |
| `assets/js/oracle.js` | The state machine (idle → asking → thinking → zoom → speaking), the matching and the hash routes. |
| `assets/css/site.css` | All styles. The palette is at the top. |
| `assets/moai.jpg` | The background image. |

Links you can share:

- `/#/alone-in-a-field` opens that post, already zoomed out.
- `/#/all` opens the archive. `/#/all/time` opens it filtered to the `time` tag.
- `/posts/alone-in-a-field/` is the post's own page.

## Adding a post

Create `_posts/YYYY-MM-DD-your-slug.md`. The part after the date becomes the slug, so this post will live at `/posts/your-slug/` and `/#/your-slug`.

```yaml
---
title: On standing still
date: 2026-09-28
tags: [time, patience]
keywords: wait waiting slow patience stillness move rush hurry busy stop
---

Write the post here, in Markdown.
```

- **title**: shown as the heading. Its words also count the most when matching questions.
- **date**: shown as DD/MM/YYYY. Jekyll skips posts dated in the future, so a post appears on the first build on or after its date.
- **tags**: a short list. They show up as pills and as filters in the archive, and they count as much as the title when matching.
- **keywords**: extra words, separated by spaces, that should lead to this post even though they aren't in the title or tags. Think about how someone would ask: the words they'd type, not the words you wrote. Include the variants that a prefix match won't catch (`lonely` and `alone`, `glasses` and `eyes`).

  Don't name this field `keys`. In Jekyll's templates, `post.keys` is a built-in that lists a post's field names, so a `keys` field can never be read. That was the cause of an earlier bug where the site couldn't load its posts.

The voice: the moai speaks in the first person, plainly and calmly, in short sentences. It is not mystical and not cute.

If you link to an image from a post, use a path from the site root (`/assets/...`), not a relative one. Post bodies are also shown on the home page, where relative paths would break.

### How a question finds a post

1. The question is lowercased and split into words. Words of two letters or fewer and common words (`why`, `does`, `anything`, …) are dropped. The list is `STOP` in `oracle.js`.
2. Each remaining word is cut to a root: words longer than five letters lose their last two letters (`waiting` → `waiti`).
3. A post gains points when a word in one of its fields *starts with* that root, or when the question word starts with a field word longer than four letters (`remembering` finds `remember`, which the root `rememberi` would miss). Fields are weighted **title ×3, tags ×3, keywords ×2, body ×1**, and each field counts once per question word.
4. The highest score wins. The next two posts that scored anything are listed as "also near your question". If nothing scored, the moai says it hasn't thought about that yet and shows the archive.

To check a new post, ask the questions you expect people to ask and see where they land. When the wrong post wins, adding a few `keywords` is usually enough.

## Publishing on GitHub Pages

1. Push this repository to GitHub as `vinissaurus.github.io`.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose branch **`main`** and folder **`/ (root)`**, and save.
4. After a minute or two the site is live at <https://vinissaurus.github.io>. Each push to `main` rebuilds it.

If you serve it from another address, change `url` (and `baseurl`, for a project page like `/blog`) in `_config.yml`.

### Previewing locally (optional)

You need Ruby. Then, once:

```sh
gem install bundler
bundle init
bundle add github-pages --group jekyll_plugins
```

and each time:

```sh
bundle exec jekyll serve
```

Open <http://localhost:4000>.

## Replacing the image

The scene is tuned to this photo. The positions of the head, the tail's target and the thought balloon are fractions of the image size, set near the top of `oracle.js` (`FOCUS`, `ANCHOR`, `TIP`). A new crop of the same photo only needs its size updated in `_config.yml` (`moai.width`, `moai.height`). A different photo will need those points moved as well.

The current file is 1408 px wide, which gets soft when the scene is zoomed in on large screens. If you have a version at least 3000 px wide, save it as `assets/moai.jpg`, save a 1600 px copy as `assets/moai-1600.jpg`, update the size in `_config.yml`, and add this to the `<img class="moai">` tag in `_layouts/default.html`:

```html
srcset="{{ '/assets/moai-1600.jpg' | relative_url }} 1600w, {{ site.moai.src | relative_url }} 3000w"
sizes="(max-width: 899px) 250vw, 200vw"
```

(`sizes` is large because the image is shown zoomed in.)
