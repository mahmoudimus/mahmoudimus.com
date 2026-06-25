"""Pelican plugin: per-article table of contents (right rail).

For any article or page with `Toc: true` in its frontmatter and at least two
`<h2>` headings, this slugifies each heading, injects a stable `id` into the
rendered HTML, and builds a flat table of contents. The TOC is exposed as
`content.toc_html`; the theme renders it as a sticky right-rail nav (see
article.html / theme.css) and toc.js adds scroll-spy.

Server-side, so the heading ids are real, shareable `#section` anchors that
work without JavaScript. Markdown (cmark-gfm) emits `<h2>` with no id, which is
why this is needed. Remove "toc" from PLUGINS to turn it off.
"""
import re
from html import escape, unescape

from pelican import signals

_H2_RE = re.compile(r"<h2(?P<attrs>[^>]*)>(?P<inner>.*?)</h2>", re.DOTALL | re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")
_ID_RE = re.compile(r"""id=["']([^"']+)["']""")

# lucide "hash" icon, revealed on hover to the left of each heading (theme.css)
_HASH_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15"'
    ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    '<line x1="4" x2="20" y1="9" y2="9"></line>'
    '<line x1="4" x2="20" y1="15" y2="15"></line>'
    '<line x1="10" x2="8" y1="3" y2="21"></line>'
    '<line x1="16" x2="14" y1="3" y2="21"></line></svg>'
)


def _truthy(value):
    if isinstance(value, str):
        return value.strip().lower() in ("true", "yes", "on", "1")
    return bool(value)


def _slugify(inner_html):
    text = unescape(_TAG_RE.sub("", inner_html)).strip().lower()
    text = re.sub(r"['‘’\"`]", "", text)  # drop apostrophes/quotes
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-") or "section"


def _build_toc(content):
    meta = getattr(content, "metadata", {}) or {}
    if not _truthy(meta.get("toc")):
        return
    html = getattr(content, "_content", None)
    if not html:
        return

    entries = []
    seen = {}

    def repl(match):
        attrs, inner = match.group("attrs"), match.group("inner")
        found = _ID_RE.search(attrs)
        if found:
            slug = found.group(1)
        else:
            slug = _slugify(inner)
            if slug in seen:
                seen[slug] += 1
                slug = f"{slug}-{seen[slug]}"
            else:
                seen[slug] = 0
            attrs = f'{attrs} id="{slug}"'
        label = unescape(_TAG_RE.sub("", inner)).strip()
        entries.append((slug, label))
        anchor = (
            f'<a class="heading-anchor" href="#{slug}"'
            ' aria-label="Permalink to this section">'
            f"{_HASH_SVG}</a>"
        )
        return f"<h2{attrs}>{anchor}{inner}</h2>"

    new_html = _H2_RE.sub(repl, html)
    if len(entries) < 2:
        return  # not worth a table of contents

    content._content = new_html
    items = "\n".join(
        f'<li><a href="#{slug}">{escape(label)}</a></li>' for slug, label in entries
    )
    content.toc_html = (
        '<nav class="article-toc" aria-label="On this page">'
        '<p class="article-toc-title">On this page</p>'
        f"<ul>{items}</ul></nav>"
    )


def register():
    signals.content_object_init.connect(_build_toc)
