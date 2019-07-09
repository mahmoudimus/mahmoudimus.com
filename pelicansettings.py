#!/usr/bin/env python
# -*- coding: utf-8 -*- #
import datetime


_now = datetime.datetime.now()
AUTHOR = 'Mahmoud Abdelkader'
SITENAME = 'Hacker Moleskine'
SITEURL = '//mahmoudimus.com'
#SITEURL = 'http://0.0.0.0:8000'
CURRENT_YEAR = _now.year
TIMEZONE = 'America/Los_Angeles'

DEFAULT_LANG = 'en'

# Feed generation is usually not desired when developing
FEED_ALL_ATOM = None
CATEGORY_FEED_ATOM = None
TRANSLATION_FEED_ATOM = None
AUTHOR_FEED_ATOM = None
AUTHOR_FEED_RSS = None
DEFAULT_PAGINATION = False

# Uncomment following line if you want document-relative URLs when developing
#RELATIVE_URLS = True

DATE_FORMAT = {
    'en': '%d %m %Y'
}
#DEFAULT_DATE = 'fs'
DEFAULT_DATE_FORMAT = '%d %m %Y'
DEFAULT_CATEGORY = 'Uncategorized'


ARTICLE_URL = '{date:%Y}/{date:%m}/{slug}/'
ARTICLE_SAVE_AS = '{date:%Y}/{date:%m}/{slug}/index.html'
PAGE_URL = '{slug}/'
PAGE_SAVE_AS = '{slug}/index.html'
AUTHORS_SAVE_AS = 'authors/index.html'
ARCHIVES_SAVE_AS = 'archives/index.html'
CATEGORIES_SAVE_AS = 'categories/index.html'
TAGS_SAVE_AS = 'tags/index.html'
INDEX_SAVE_AS = 'index.html'

# Show most recent posts first
NEWEST_FIRST_ARCHIVES = False

# Social
DISQUS_SITENAME = 'hackermoleskine'
TWITTER_USERNAME = 'mahmoudimus'
LINKEDIN_URL = 'http://linkedin.com/in/mabdelkader'
GITHUB_URL = 'http://github.com/mahmoudimus'

PDF_GENERATOR = False
REVERSE_CATEGORY_ORDER = True
DEFAULT_PAGINATION = 10

FEED_RSS = 'feeds/all.rss.xml'
CATEGORY_FEED_RSS = 'feeds/{slug}.rss.xml'

GOOGLE_ANALYTICS_ACCOUNT = 'UA-10868702-1'

MAIL_USERNAME = 'mabdelkader'
MAIL_HOST = 'gmail.com'

THEME = 'themes/minimal'

import hashlib

# I was in the middle of debugging the rst_gist error while running
# pelican content -D

GRAVATAR_EMAIL = '{}@{}'.format(MAIL_USERNAME, MAIL_HOST).strip().lower()
GRAVATAR_HASH = hashlib.md5(GRAVATAR_EMAIL.encode('utf-8')).hexdigest()
GRAVATAR_URL = 'http://www.gravatar.com/avatar/{}.jpg'.format(GRAVATAR_HASH)

PLUGIN_PATHS = ['plugins']
PLUGINS = ['rst_gist']
