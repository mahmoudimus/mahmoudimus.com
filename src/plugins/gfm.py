#!/usr/bin/python
#
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.
#
#
# gfm.py -- GitHub-Flavored Markdown reader for Pelican
#
import html
import logging
import re

import pelican.plugins.signals
import pelican.readers
import pelican.utils
import pygments

try:
    import cmarkgfm
    from cmarkgfm.cmark import Options as cmarkgfm_options
except ImportError:
    cmarkgfm = None
    cmarkgfm_options = None

DUPLICATES_DEFINITIONS_ALLOWED = pelican.readers.DUPLICATES_DEFINITIONS_ALLOWED
logger = logging.getLogger(__name__)


FRONTMATTER_RE = re.compile(
    r"\s*^\+\+\+|\-\-\-+$"  # File starts with a line of "+++" or "---" (preceeding blank lines accepted)
    r"(?P<metadata>.+?)"
    r"^(?:\+\+\+|\-\-\-|\.\.\.)$"  # metadata section ends with a line of "+++" or "---" or "..."
    r"(?P<content>.*)",
    re.MULTILINE | re.DOTALL,
)


# NOTE: the builtin MarkdownReader should be disabled to ensure it is not used!
# You can do this by not installing the markdown module.

pelican.readers.MarkdownReader.enabled = bool(cmarkgfm)

# Make code fences with `python` as the language default to highlighting as
# Python 3.
_LANG_ALIASES = {
    "python": "python3",
}


def _highlight(html_content):
    """Syntax-highlights HTML-rendered Markdown.

    Plucks sections to highlight that conform the the GitHub fenced code info
    string as defined at https://github.github.com/gfm/#info-string.

    This is a big hack, and it's not very good. Should probably use real XML
    parsing instead.

    Args:
        html (str): The rendered HTML.

    Returns:
        str: The HTML with Pygments syntax highlighting applied to all code
            blocks.
    """

    formatter = pygments.formatters.HtmlFormatter(nowrap=True)

    code_expr = re.compile(
        r'<pre lang="(?P<lang>.+?)"><code>(?P<code>.+?)' r"</code></pre>",
        re.DOTALL,
    )

    def replacer(match):
        try:
            lang = match.group("lang")
            lang = _LANG_ALIASES.get(lang, lang)
            lexer = pygments.lexers.get_lexer_by_name(lang)
        except ValueError:
            lexer = pygments.lexers.TextLexer()

        code = match.group("code")

        # Decode html entities in the code. cmark tries to be helpful and
        # translate '"' to '&quot;', but it confuses pygments. Pygments will
        # escape any html entities when re-writing the code, and we run
        # everything through bleach after.
        code = html.unescape(code)

        highlighted = pygments.highlight(code, lexer, formatter)

        return "<div class='highlight'><pre>{}</pre></div>".format(highlighted)

    result = code_expr.sub(replacer, html_content)
    return result


class GFMReader(pelican.readers.MarkdownReader):
    """GFM-flavored Reader for the Pelican system.

    Pelican looks for all subclasses of BaseReader, and automatically
    registers them for the file extensions listed below. Thus, nothing
    further is required by users of this Reader.
    """

    enabled = bool(cmarkgfm)
    file_extensions = pelican.readers.MarkdownReader.file_extensions

    def _convert(self, text):
        return cmarkgfm.github_flavored_markdown_to_html(
            text,
            options=cmarkgfm_options.CMARK_OPT_UNSAFE,
        )

    def _parse_metadata(self, metadata):
        """Return the dict containing document metadata"""
        formatted_fields = self.settings["FORMATTED_FIELDS"]
        print("FORMATTED FIELDS:", formatted_fields)
        print("DUPLICATES_DEFINITIONS_ALLOWED", DUPLICATES_DEFINITIONS_ALLOWED)
        meta = {}
        for line in metadata.splitlines():
            if not line.strip():
                continue
            try:
                name, value = line.split(":", 1)
            except ValueError:
                logger.warning(
                    "Malformed metadata line: %s, missing colon (':'). Skipping.", line
                )
                continue
            meta[name.strip()] = [value.strip()]

        output = {}
        for name, value in meta.items():
            print("NAME:", name, "VALUE:", value)
            name = name.lower()
            if name in formatted_fields:
                # formatted metadata is special case and join all list values
                formatted_values = "\n".join(value)
                formatted = self._convert(formatted_values)
                output[name] = self.process_metadata(name, formatted)
            elif not DUPLICATES_DEFINITIONS_ALLOWED.get(name, True):
                if len(value) > 1:
                    logger.warning(
                        "Duplicate definition of `%s` for %s. Using first one.",
                        name,
                        self._source_path,
                    )
                output[name] = self.process_metadata(name, value[0])
            elif len(value) > 1:
                # handle list metadata as list of string
                output[name] = self.process_metadata(name, value)
            else:
                # otherwise, handle metadata as single string
                output[name] = self.process_metadata(name, value[0])
        return output

    def read(self, source_path):
        "Read metadata and content then render into HTML."

        # read metadata and markdown content
        self._source_path = source_path
        with pelican.utils.pelican_open(source_path) as text:
            match = FRONTMATTER_RE.match(text)
            if match:
                metadata = self._parse_metadata(match.group("metadata"))
                content = match.group("content")
            else:
                metadata = {}
                content = text
            content = self._convert(content)
            content = _highlight(content)

        assert content, "Did not expect content to be empty"
        return content, metadata

    def disabled_message(self) -> str:
        return (
            "Could not import 'cmarkgfm'. "
            "Have you installed the 'cmarkgfm' package? pip install cmarkgfm"
        )


def add_readers(readers):
    for ext in GFMReader.file_extensions:
        readers.reader_classes[ext] = GFMReader


def register():
    pelican.plugins.signals.readers_init.connect(add_readers)
