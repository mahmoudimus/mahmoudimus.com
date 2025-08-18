import datetime
import hashlib
import logging
import multiprocessing
import os
import pathlib
import sys
import traceback
from dataclasses import asdict, dataclass, field

import pelican
import pelican.settings

logger = pelican.logger
cwd = pathlib.Path(__file__).parent


@dataclass
class PelicanSettings:
    # Basic settings
    AUTHOR: str = "Mahmoud Abdelkader"
    SITENAME: str = "Hacker Moleskine"
    SITEURL: str = "http://127.0.0.1:8000"  # Using the last defined value
    CURRENT_YEAR: int = field(default_factory=lambda: datetime.datetime.now().year)
    TIMEZONE: str = "America/Los_Angeles"
    DEFAULT_LANG: str = "en"

    # Feed settings
    FEED_ALL_ATOM: None = None
    CATEGORY_FEED_ATOM: None = None
    TRANSLATION_FEED_ATOM: None = None
    AUTHOR_FEED_ATOM: None = None
    AUTHOR_FEED_RSS: None = None
    FEED_RSS: str = "feeds/all.rss.xml"
    CATEGORY_FEED_RSS: str = "feeds/{slug}.rss.xml"

    # Pagination and ordering
    DEFAULT_PAGINATION: int = 10  # Using the last defined value
    NEWEST_FIRST_ARCHIVES: bool = False
    REVERSE_CATEGORY_ORDER: bool = True

    # Date format settings
    DATE_FORMAT: dict = field(default_factory=lambda: {"en": "%d %m %Y"})
    DEFAULT_DATE_FORMAT: str = "%d %m %Y"
    DEFAULT_CATEGORY: str = "Uncategorized"

    # URL and save path settings
    ARTICLE_URL: str = "{date:%Y}/{date:%m}/{slug}/"
    ARTICLE_SAVE_AS: str = "{date:%Y}/{date:%m}/{slug}/index.html"
    PAGE_URL: str = "{slug}/"
    PAGE_SAVE_AS: str = "{slug}/index.html"
    AUTHORS_SAVE_AS: str = "authors/index.html"
    ARCHIVES_SAVE_AS: str = "archives/index.html"
    CATEGORIES_SAVE_AS: str = "categories/index.html"
    TAGS_SAVE_AS: str = "tags/index.html"
    INDEX_SAVE_AS: str = "index.html"

    # Social settings
    DISQUS_SITENAME: str = "hackermoleskine"
    TWITTER_USERNAME: str = "mahmoudimus"
    LINKEDIN_URL: str = "http://linkedin.com/in/mabdelkader"
    GITHUB_URL: str = "http://github.com/mahmoudimus"
    GOOGLE_ANALYTICS_ACCOUNT: str = "UA-10868702-1"

    # Email settings
    MAIL_USERNAME: str = "mabdelkader"
    MAIL_HOST: str = "gmail.com"

    # Theme and plugins
    THEME: str = str(cwd / "themes/minimal")
    PLUGIN_PATHS: list = field(default_factory=lambda: [str(cwd / "plugins")])
    PLUGINS: list = field(default_factory=lambda: ["rst_gist"])

    # Other settings
    PDF_GENERATOR: bool = False
    PAGE_PATHS: list[str] = field(default_factory=lambda: ["pages"])
    PAGE_EXCLUDES: list[str] = field(default_factory=lambda: [])
    ARTICLE_PATHS: list[str] = field(default_factory=lambda: [])
    ARTICLE_EXCLUDES: list[str] = field(default_factory=lambda: [])
    DIRECT_TEMPLATES: list[str] = field(
        default_factory=lambda: ["index", "tags", "categories", "authors", "archives"]
    )
    SECTIONS: list[tuple[str, str]] = field(default_factory=lambda: [("blog", "blog")])
    STATIC_PATHS: list[str] = field(default_factory=lambda: ["images"])
    EXTRA_PATH_METADATA: dict[str, dict[str, str]] = field(default_factory=dict)
    READERS: dict[str, None] = field(default_factory=lambda: {"html": None})
    TEMPLATE_PAGES: dict[str, str] = field(default_factory=dict)
    PATH: str = field(default_factory=lambda: "blog")
    RELATIVE_URLS: bool = True
    OVERRIDDEN_SITEURL: str | None = None
    OUTPUT_PATH: str = "output"

    # Computed properties
    @property
    def GRAVATAR_EMAIL(self) -> str:
        return f"{self.MAIL_USERNAME}@{self.MAIL_HOST}".strip().lower()

    @property
    def GRAVATAR_HASH(self) -> str:
        return hashlib.md5(self.GRAVATAR_EMAIL.encode("utf-8")).hexdigest()

    @property
    def GRAVATAR_URL(self) -> str:
        return f"http://www.gravatar.com/avatar/{self.GRAVATAR_HASH}.jpg"

    def to_dict(self):
        # Get all fields as a dictionary
        settings_dict = asdict(self)

        # Add computed properties
        settings_dict["GRAVATAR_EMAIL"] = self.GRAVATAR_EMAIL
        settings_dict["GRAVATAR_HASH"] = self.GRAVATAR_HASH
        settings_dict["GRAVATAR_URL"] = self.GRAVATAR_URL

        return settings_dict


LandingPageSettings = PelicanSettings(
    PATH=str(cwd / "content"),
    PAGE_PATHS=[],
    # ARTICLE_PATHS=["landing"],
    ARTICLE_EXCLUDES=["blog", "extra", "media", "til"],
    DIRECT_TEMPLATES=["index"],
    SECTIONS=[("blog", "blog")],
    STATIC_PATHS=["media", "extra"],
    EXTRA_PATH_METADATA={"extra/favicon.ico": {"path": "favicon.ico"}},
    READERS={"html": None},
    TEMPLATE_PAGES={},
)

WeblogSettings = PelicanSettings(
    PATH=str(cwd / "content"),
    ARTICLE_PATHS=["blog"],
    RELATIVE_URLS=True,
    OVERRIDDEN_SITEURL=PelicanSettings.SITEURL,
    OUTPUT_PATH="output/{0}".format("blog"),
    SECTIONS=[
        ("Blog", ""),
        ("Archives", "archives"),
        ("Tags", "tags"),
    ],
    DIRECT_TEMPLATES=["index", "tags", "archives"],
)


def get_instance(args, settings: PelicanSettings):
    config_file = args.settings
    if config_file is None and os.path.isfile(pelican.DEFAULT_CONFIG_NAME):
        config_file = pelican.DEFAULT_CONFIG_NAME
        args.settings = pelican.DEFAULT_CONFIG_NAME

    # read the default settings
    overrides = pelican.settings.DEFAULT_CONFIG.copy()
    # override the default settings with the user's settings from cmd line
    overrides.update(pelican.get_config(args))
    # finally, override the default settings with the user's settings from the settings file
    overrides.update(settings.to_dict())
    # print(default_settings)
    settings = pelican.read_settings(None, override=overrides)
    print(settings)
    cls = settings["PELICAN_CLASS"]
    if isinstance(cls, str):
        module, cls_name = cls.rsplit(".", 1)
        module = __import__(module)
        cls = getattr(module, cls_name)

    return cls(settings), settings


def autoreload(args, excqueue=None):
    pelican.console.print(
        "  --- AutoReload Mode: Monitoring `content`, `theme` and"
        " `settings` for changes. ---"
    )
    args, settings_classes = args
    pelican_instances = []
    for _settings in settings_classes:
        pelican_instance = PelicanInstance(*get_instance(args, _settings))
        pelican_instances.append(pelican_instance)

    settings_file = os.path.abspath(args.settings)
    while True:
        try:
            for pelican_instance in pelican_instances:
                pelican_instance.instance.run()

            changed_files = pelican.wait_for_changes(args.settings, pelican.settings)
            changed_files = {c[1] for c in changed_files}

            if settings_file in changed_files:
                for pelican_instance in pelican_instances:
                    pelican_instance.instance, pelican_instance.settings = get_instance(
                        args, pelican_instance.settings
                    )

            pelican.console.print(
                "\n-> Modified: {}. re-generating...".format(", ".join(changed_files))
            )

        except KeyboardInterrupt:
            if excqueue is not None:
                excqueue.put(None)
                return
            raise

        except Exception as e:
            if args.verbosity == logging.DEBUG:
                if excqueue is not None:
                    excqueue.put(traceback.format_exception_only(type(e), e)[-1])
                else:
                    raise
            logger.warning(
                'Caught exception:\n"%s".',
                e,
                exc_info=pelican.settings.get("DEBUG", False),
            )


@dataclass
class PelicanInstance:
    instance: pelican.Pelican
    settings: PelicanSettings


def main(argv=None):
    args = pelican.parse_arguments(argv)
    logs_dedup_min_level = getattr(logging, args.logs_dedup_min_level)
    pelican.init_logging(
        level=args.verbosity,
        fatal=args.fatal,
        name=__name__,
        handler=pelican.LOG_HANDLERS[args.log_handler],
        logs_dedup_min_level=logs_dedup_min_level,
    )

    logger.debug("Pelican version: %s", pelican.__version__)
    logger.debug("Python version: %s", sys.version.split()[0])

    try:
        instances = []
        for settings in [LandingPageSettings, WeblogSettings]:
            instances.append(PelicanInstance(*get_instance(args, settings)))

        if args.autoreload and args.listen:
            excqueue = multiprocessing.Queue()
            p1 = multiprocessing.Process(
                target=autoreload,
                args=((args, [LandingPageSettings, WeblogSettings]), excqueue),
            )
            p2 = multiprocessing.Process(
                target=pelican.listen,
                args=(
                    instances[0].settings.get("BIND"),
                    instances[0].settings.get("PORT"),
                    instances[0].settings.get("OUTPUT_PATH"),
                    excqueue,
                ),
            )
            try:
                p1.start()
                p2.start()
                exc = excqueue.get()
                if exc is not None:
                    logger.critical(exc)
            finally:
                p1.terminate()
                p2.terminate()
        elif args.autoreload:
            autoreload(args)
        elif args.listen:
            pelican.listen(
                instances[0].settings.get("BIND"),
                instances[0].settings.get("PORT"),
                instances[0].settings.get("OUTPUT_PATH"),
            )
        else:
            with pelican.console.status("Generating..."):
                for instance in instances:
                    instance.instance.run()
    except KeyboardInterrupt:
        logger.warning("Keyboard interrupt received. Exiting.")
    except Exception as e:
        logger.critical("%s: %s", e.__class__.__name__, e)

        if args.verbosity == logging.DEBUG:
            pelican.console.print_exception()
        sys.exit(getattr(e, "exitcode", 1))


if __name__ == "__main__":
    main()
