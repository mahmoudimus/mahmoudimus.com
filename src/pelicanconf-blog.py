#!/usr/bin/env python
# -*- coding: utf-8 -*- #
import os
import sys
import urllib.parse

from pelican import settings


_context = settings.get_settings_from_file(
    os.path.join(os.getcwd(), 'pelicansettings.py'))
_current_module = sys.modules[__name__]

# [[ blog specific configurations ]]
RELATIVE_URLS = True
_context['PATH'] = 'blog'
_context['OVERRIDEN_SITEURL'] = _context['SITEURL']
# _context['SITEURL'] = urllib.parse.urljoin(_context['SITEURL'], 'blog')
_context['OUTPUT_PATH'] = "output/{0}".format(_context['PATH'])

# Navigation sections and relative URL:
_context['SECTIONS'] = [
    ('Blog', ''),
    ('Archives', 'archives'),
    ('Tags', 'tags'),
]


_context['DIRECT_TEMPLATES'] = [
    'index', 'tags', 'archives'
]


# DO NOT EDIT BELOW
for _variable_name, _variable_value in _context.items():
    setattr(_current_module, _variable_name, _variable_value)
