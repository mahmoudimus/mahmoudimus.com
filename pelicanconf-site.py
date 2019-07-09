#!/usr/bin/env python
# -*- coding: utf-8 -*- #
import os
import sys

from pelican import settings


_context = settings.get_settings_from_file(
    os.path.join(os.getcwd(), 'pelicansettings.py'))
_current_module = sys.modules[__name__]

# [[ site specific configurations ]]

_context['PATH'] = 'site'
_context['OUTPUT_PATH'] = "output/"
_context['PAGE_PATHS'] = [
   'pages'
]

_context['DIRECT_TEMPLATES'] = [
    'index',
]

# A list of files to copy from the source to the destination
# Take advantage of the following defaults
# STATIC_SAVE_AS = '{path}'
# STATIC_URL = '{path}'
_context['SECTIONS'] = [
    ('blog', 'blog'),
]
# static paths will be copied under the same name
_context['STATIC_PATHS'] = [
    'images',
    'extra/favicon.ico',
]
_context['EXTRA_PATH_METADATA'] = {
    'extra/favicon.ico': {'path': 'favicon.ico'},
}
_context['READERS'] = {'html': None}

# the about page exposes a bug with relative urls
_context['TEMPLATE_PAGES'] = {
#    'pages/index.html' : 'index.html'
}


# DO NOT EDIT BELOW
for _variable_name, _variable_value in _context.items():
    setattr(_current_module, _variable_name, _variable_value)
