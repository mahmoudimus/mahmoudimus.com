#!/usr/bin/env python

import contextlib
import copy
import datetime
import logging
import re
from typing import Protocol

from pelican.contents import Author, Category, Tag
from pelican.plugins import signals
from pelican.readers import DUPLICATES_DEFINITIONS_ALLOWED, MarkdownReader
from pelican.utils import get_date, pelican_open

ENABLED = False
ADAPTER = ""

# Only enable this extension if tomllib and either cmarkgfm (and eventually.. markdown packages) are installed
with contextlib.suppress(ImportError):
    import tomllib

    import cmarkgfm

    ADAPTER = "cmarkgfm"
    ENABLED = True


__log__ = logging.getLogger(__name__)

HEADER_RE = re.compile(
    r"\s*^\+\+\+$"  # File starts with a line of "+++" (preceeding blank lines accepted)
    r"(?P<metadata>.+?)"
    r"^(?:\+\+\+|\.\.\.)$"  # metadata section ends with a line of "+++" or "..."
    r"(?P<content>.*)",
    re.MULTILINE | re.DOTALL,
)

DUPES_NOT_ALLOWED = {k for k, v in DUPLICATES_DEFINITIONS_ALLOWED.items() if not v} - {
    "tags",
    "authors",
}

_DEL = object()

TOML_METADATA_PROCESSORS = {
    "tags": lambda x, y: [Tag(_strip(t), y) for t in _to_list(x)] or _DEL,
    "date": lambda x, y: _parse_date(x),
    "modified": lambda x, y: _parse_date(x),
    "category": lambda x, y: Category(_strip(x), y) if x else _DEL,
    "author": lambda x, y: Author(_strip(x), y) if x else _DEL,
    "authors": lambda x, y: [Author(_strip(a), y) for a in _to_list(x)] or _DEL,
    "slug": lambda x, y: _strip(x) or _DEL,
    "save_as": lambda x, y: _strip(x) or _DEL,
    "status": lambda x, y: _strip(x) or _DEL,
}


def _strip(obj):
    if isinstance(obj, (str, bytes)):
        return obj.strip()
    raise ValueError(f"Expected str or bytes, got {type(obj)}")


def _to_list(obj):
    """Make object into a list."""
    try:
        return list(obj)
    except (TypeError, ValueError):
        return [obj]


def _parse_date(obj):
    """Return a string representing a date."""
    # If it's already a date object, make it a string so Pelican can parse it
    # and make sure it has a timezone
    if isinstance(obj, datetime.date):
        obj = obj.isoformat()

    return get_date(str(obj).strip().replace("_", " "))


class MarkdownAdapterProtocol(Protocol):
    def convert(self, text): ...

    def reset(self): ...


class MarkdownMarkdownAdapter(MarkdownAdapterProtocol):
    """
    Adapter for the Python-Markdown backend.
    """

    def __init__(self, settings):
        self._md = Markdown(**settings)  # type: ignore

    def convert(self, text):
        return self._md.convert(text)

    def reset(self):
        self._md.reset()
        return self


class CmarkGFMAdapter(MarkdownAdapterProtocol):
    """
    Adapter for the cmarkgfm backend.
    """

    def __init__(self, settings):
        self._cmarkgfm = cmarkgfm
        self._settings = settings

    def convert(self, text):
        return self._cmarkgfm.github_flavored_markdown_to_html(
            text, options=self._settings["options"]
        )

    def reset(self):
        # cmarkgfm is stateless, nothing to reset
        return self


MarkdownAdapters = {
    "markdown": MarkdownMarkdownAdapter,
    "cmarkgfm": CmarkGFMAdapter,
}


class TOMLMetadataReader(MarkdownReader):
    """Reader for Markdown files with TOML metadata."""

    enabled = ENABLED

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        # Don't use default Markdown metadata extension for parsing. Leave self.settings
        # alone in case we have to fall back to normal Markdown parsing.
        md_settings = copy.deepcopy(self.settings["MARKDOWN"])
        with contextlib.suppress(KeyError, ValueError):
            md_settings["extensions"].remove("markdown.extensions.meta")

        self._md: MarkdownAdapterProtocol = MarkdownAdapters[ADAPTER](md_settings)

    @staticmethod
    def _check_toml_metadata_block(content):
        """Check if the source content has a TOML metadata block."""
        # Check that the given content is not empty
        if not content:
            raise ValueError("Could not find metadata. File is empty.")

        # Split content into a list of lines
        content_lines = content.splitlines()

        # Check that the first line of the file starts with a TOML block
        if content_lines[0].rstrip() not in ["+++"]:
            raise ValueError("Could not find metadata header '+++'.")

        # Find the end of the TOML block
        toml_block_end = ""
        for line_num, line in enumerate(content_lines[1:]):
            if line.rstrip() in ["+++"]:
                toml_block_end = line_num
                break

        # Check if the end of the TOML block was found
        if not toml_block_end:
            raise ValueError("Could not find end of metadata block.")

    def read(self, source_path):
        """Parse content and TOML metadata of Markdown files."""
        with pelican_open(source_path) as text:
            self._check_toml_metadata_block(text)
            m = HEADER_RE.fullmatch(text)

        if not m:
            __log__.info(
                (
                    "No TOML metadata header found in '%s' - "
                    "falling back to Markdown metadata parsing."
                ),
                source_path,
            )
            return super().read(source_path)

        return (
            self._md.reset().convert(m.group("content")),
            self._load_toml_metadata(m.group("metadata"), source_path),
        )

    def _load_toml_metadata(self, text, source_path):
        """Load Pelican metadata from the specified text.

        Returns an empty dict if the data fails to parse properly.
        """
        try:
            metadata = tomllib.loads(text)
        except Exception:  # NOQA: BLE001, RUF100
            __log__.error(
                "Error parsing TOML for file '%s",
                source_path,
                exc_info=True,
            )
            return {}

        if not isinstance(metadata, dict):
            __log__.error(
                "TOML header didn't parse as a dict for file '%s'",
                source_path,
            )
            __log__.debug("TOML data: %r", metadata)
            return {}

        return self._parse_toml_metadata(metadata, source_path)

    def _parse_toml_metadata(self, meta, source_path):
        """Parse TOML-provided data into Pelican metadata.

        Based on MarkdownReader._parse_metadata.
        """
        formatted_fields = self.settings["FORMATTED_FIELDS"]

        output = {}
        for name, value in meta.items():
            if value is None:
                continue

            name = name.lower()
            is_list = isinstance(value, list)
            if is_list:
                value = [x for x in value if x is not None]

            if name in formatted_fields:
                # join mutliple formatted fields before parsing them as markdown
                value = self._md.reset().convert(
                    "\n".join(value) if is_list else str(value)
                )
            elif is_list and len(value) > 1 and name == "author":
                # special case: upconvert multiple "author" values to "authors"
                name = "authors"
            elif is_list and name in DUPES_NOT_ALLOWED:
                if len(value) > 1:
                    __log__.warning(
                        (
                            "Duplicate definition of '%s' for '%s' ('%r') - "
                            "using the first one ('%s')"
                        ),
                        name,
                        source_path,
                        value,
                        value[0],
                    )
                value = value[0]

            # Need to do our own metadata processing as TOML loads data in a
            # different way than the markdown metadata extension.
            if name in TOML_METADATA_PROCESSORS:
                value = TOML_METADATA_PROCESSORS[name](value, self.settings)
            if value is not _DEL:
                output[name] = value

        __log__.debug("Parsed TOML data: %r into Pelican data %r", meta, output)
        return output


def add_reader(readers):
    for k in TOMLMetadataReader.file_extensions:
        readers.reader_classes[k] = TOMLMetadataReader


def register():
    signals.readers_init.connect(add_reader)
