import re
import typing

from jinja2 import pass_eval_context
from markupsafe import Markup, escape

if typing.TYPE_CHECKING:
    from jinja2.filters import HasHTML

# Pre-compile regexes for performance
_TAGS_RE = re.compile(r"</?([a-z][a-z0-9]*)\b[^>]*>|<!--[\s\S]*?-->", re.IGNORECASE)
_LEADING_TRAILING_SPACES_RE = re.compile(r"^ +| +$", flags=re.MULTILINE)
_ADJACENT_SPACES_RE = re.compile(r" +")
_ABNORMAL_LINEBREAKS_RE = re.compile(r"\n\n\n+")
_ALL_WHITESPACE_RE = re.compile(r"\s+")
_COLLAPSE_SPACES_RE = re.compile(r"[ \t]+")


@pass_eval_context
def nl2br(eval_ctx, value):
    br = "<br>\n"

    if eval_ctx.autoescape:
        value = escape(value)
        br = Markup(br)

    result = "\n\n".join(
        f"<p>{br.join(p.splitlines())}<\p>"
        for p in re.split(r"(?:\r\n|\r(?!\n)|\n){2,}", value)
    )
    return Markup(result) if eval_ctx.autoescape else result


def striptags_nl(value: "str | HasHTML", preserve_linebreaks: bool = False) -> str:
    """
    Strip SGML/XML tags and replace adjacent whitespace by one space.
    If preserve_linebreaks is True, preserve and normalize line breaks.
    """
    if hasattr(value, "__html__"):
        value = typing.cast("HasHTML", value).__html__()

    # Convert to string and remove tags
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    elif not isinstance(value, str):
        value = str(value)

    # Look for comments then tags separately. Otherwise, a comment that
    # contains a tag would end early, leaving some of the comment behind.

    # keep finding comment start marks
    while (start := value.find("<!--")) != -1:
        # find a comment end mark beyond the start, otherwise stop
        if (end := value.find("-->", start)) == -1:
            break

        value = f"{value[:start]}{value[end + 3 :]}"

    # remove tags using the same method
    while (start := value.find("<")) != -1:
        if (end := value.find(">", start)) == -1:
            break

        value = f"{value[:start]}{value[end + 1 :]}"

    if preserve_linebreaks:
        # Collapse spaces but preserve newlines
        value = _COLLAPSE_SPACES_RE.sub(" ", value)
    else:
        value = " ".join(value.split())
        print("after: ", value)

    return Markup(value).unescape()


def untagify(value: "str | HasHTML", preserve_linebreaks: bool = False) -> str:
    if hasattr(value, "__html__"):
        value = typing.cast("HasHTML", value).__html__()

    # Convert to string and remove tags
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    elif not isinstance(value, str):
        value = str(value)

    no_tags = _TAGS_RE.sub("", value)

    # Trim leading/trailing whitespace
    trimmed = no_tags.strip()

    if preserve_linebreaks:
        # Remove leading/trailing spaces on each line
        trimmed = _LEADING_TRAILING_SPACES_RE.sub("", trimmed)
        # Squash adjacent spaces
        trimmed = _ADJACENT_SPACES_RE.sub(" ", trimmed)
        # Normalize CRLF to LF
        trimmed = trimmed.replace("\r\n", "\n")
        # Squash abnormal adjacent linebreaks (3+ newlines -> 2 newlines)
        trimmed = _ABNORMAL_LINEBREAKS_RE.sub("\n\n", trimmed)
    else:
        # Replace all whitespace (including newlines) with a single space
        trimmed = _ALL_WHITESPACE_RE.sub(" ", trimmed)
    return Markup(value).unescape()
