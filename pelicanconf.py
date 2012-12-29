#!/usr/bin/env python
# -*- coding: utf-8 -*- #

AUTHOR = u'mahmoudimus'
SITENAME = u'Hacker Moleskine'
FEED_DOMAIN = u'http://mahmoudimus.com'
SITEURL = u'blog'
TIMEZONE = u'America/Los_Angeles'

DEFAULT_LANG = u'en'
LOCALE = ''

#Navigation sections and relative URL:
SECTIONS = [
    ('Blog', 'index.html'),
    ('Archive', 'archives.html'),
    ('Tags', 'tags.html'),
]

DEFAULT_CATEGORY = 'Uncategorized'

DATE_FORMAT = {
    'en': '%d %m %Y'
}

DEFAULT_DATE_FORMAT = '%d %m %Y'

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
CATEGORY_FEED_RSS = 'feeds/%s.rss.xml'

GOOGLE_ANALYTICS_ACCOUNT = 'UA-10868702-1'

MAIL_USERNAME = 'mabdelkader'
MAIL_HOST = 'gmail.com'

THEME = 'themes/easy'

# static paths will be copied under the same name
STATIC_PATHS = ['images']

# A list of files to copy from the source to the destination
#FILES_TO_COPY = (('extra/robots.txt', 'robots.txt'),)

# imports
import rst_gist
rst_gist.register()
