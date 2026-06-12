# Blogmark template

A **blogmark** is a link post: you link an external page, pull a quote, and add your
own commentary. Any post in `src/content/blog/` with a `Link:` field renders as a
blogmark — favicon avatar, quote + commentary inline in the `/blog` stream, and a
"Source →" link on its permalink.

To create one, copy the block below into a new file
`src/content/blog/<your-slug>.md` and fill it in:

```markdown
+++
Title: A short headline for the link
Date: 2026-06-12
Link: https://example.com/the-source-post
Via: https://x.com/someone/status/123        (optional — where you found it)
Tags: ai, hardware
+++

> A pulled quote from the source, as a normal Markdown blockquote.

My thoughts on it — a sentence or three of commentary.
```

Notes:
- The **`Link:`** field is what turns a post into a blogmark. Remove it and it's a normal article.
- `Via:` is optional (a credit link; shows as "via <domain>").
- The body holds the quote (a `>` blockquote) plus your commentary; keep it short — it
  renders in full inside the `/blog` listing.
- The title links to the on-site permalink; the external page is reached via the
  "Source →" link (on the permalink and the `domain ↗` in the listing).
- **Do not use `Status: draft`** — the deploy's Pelican version crashes on drafts. Publish
  directly, or keep work-in-progress blogmarks outside `src/content/`.
