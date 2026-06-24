"""Pelican plugin: Markdown footnotes via cmark-gfm.

Enables cmark-gfm's footnote rendering for the GFM reader so that `[^1]`-style
references produce `<sup class="footnote-ref">` markers and a
`<section class="footnotes">` list. The interactive popover behaviour lives in
the theme (`footnotes.css` / `footnotes.js`); this plugin only turns on the
rendering. Remove "footnotes" from PLUGINS to switch it back off.

cmark-gfm footnotes are a parser option (CMARK_OPT_FOOTNOTES), so we OR it into
the options that `GFMReader._convert` passes to cmark, preserving the existing
CMARK_OPT_UNSAFE (raw HTML passthrough). reStructuredText footnotes are
unaffected: docutils emits its own markup (`.footnote-reference`).
"""
import logging

from pelican import signals

logger = logging.getLogger(__name__)


def _enable_footnotes(*_args, **_kwargs):
    """Patch GFMReader to render Markdown footnotes. Idempotent."""
    try:
        import cmarkgfm
        import gfm  # sibling plugin; PLUGIN_PATHS puts it on sys.path
        from cmarkgfm.cmark import Options
    except ImportError:
        logger.warning("footnotes: cmarkgfm/gfm unavailable; footnotes not enabled")
        return

    reader = gfm.GFMReader
    if getattr(reader, "_footnotes_patched", False):
        return

    options = Options.CMARK_OPT_UNSAFE | Options.CMARK_OPT_FOOTNOTES

    def _convert(self, text):
        return cmarkgfm.github_flavored_markdown_to_html(text, options=options)

    reader._convert = _convert
    reader._footnotes_patched = True
    logger.debug("footnotes: enabled CMARK_OPT_FOOTNOTES on GFMReader")


def register():
    # `initialized` fires once per Pelican instance, before content is read.
    signals.initialized.connect(_enable_footnotes)
