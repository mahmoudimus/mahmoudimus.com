#!/usr/bin/env python
# -*- coding: utf-8 -*- #
from __future__ import unicode_literals

AUTHOR = 'Mahmoud Abdelkader'
SITENAME = 'Hacker Moleskine'
SITEURL = 'http://mahmoudimus.com/blog'

PATH = 'content'

TIMEZONE = 'America/Los_Angeles'

DEFAULT_LANG = 'en'

# Feed generation is usually not desired when developing
FEED_ALL_ATOM = None
CATEGORY_FEED_ATOM = None
TRANSLATION_FEED_ATOM = None
AUTHOR_FEED_ATOM = None
AUTHOR_FEED_RSS = None

# Blogroll
LINKS = (('Pelican', 'http://getpelican.com/'),
         ('Python.org', 'http://python.org/'),
         ('Jinja2', 'http://jinja.pocoo.org/'),
         ('You can modify those links in your config file', '#'),)

# Social widget
SOCIAL = (('You can add links in your config file', '#'),
          ('Another social link', '#'),)

DEFAULT_PAGINATION = False

# Uncomment following line if you want document-relative URLs when developing
#RELATIVE_URLS = True
DATE_FORMAT = {
    'en': '%d %m %Y'
}
DEFAULT_DATE_FORMAT = '%d %m %Y'
DEFAULT_CATEGORY = 'Uncategorized'


#Navigation sections and relative URL:
SECTIONS = [
    ('Blog', 'index.html'),
    ('Archive', 'archives.html'),
    ('Tags', 'tags.html'),
    ('About', 'pages/about.html'),
]

PAGE_PATHS = [
   'pages'
]
ARTICLE_URL = '{date:%Y}/{date:%m}/{slug}/'
ARTICLE_SAVE_AS = '{date:%Y}/{date:%m}/{slug}/index.html'

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

# A list of files to copy from the source to the destination
# Take advantage of the following defaults
# STATIC_SAVE_AS = '{path}'
# STATIC_URL = '{path}'
# static paths will be copied under the same name
STATIC_PATHS = [
    'images',
]
EXTRA_PATH_METADATA = {
    'extra/favicon.ico': {'path': 'favicon.ico'},
    }

PLUGIN_PATHS = ['plugins']
PLUGINS = ['rst_gist']
