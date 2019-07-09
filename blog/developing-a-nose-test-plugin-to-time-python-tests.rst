Developing a ``nose`` Test Plugin to Time Python Tests
######################################################
:date: 2011-02-28 14:28
:author: Mahmoud
:tags: python
:excerpt: Writing a simple nose test plugin that times python tests, based of XUnit.

`Nose`_ is a fantastic testing framework. What surprises me though, is
that there's no out of the box plugin to time tests to see which tests
are the slowest, and most likely, problematic. After all, unit tests are
supposed to be wicked fast. I googled, but nothing really came up except
an `insightful google-groups post`_.

I figured, what the hey, might as well just write a simple nose plugin
to time the tests. I modeled it slightly off the `xunit nose plugin`_.
With the xunit plugin as a guiding example, I thought it was pretty
trivial to write a nose plugin, definitely a testament to the great
design chosen by nose.

.. gist:: 848183 nose-timetests.py

Something cool about nose was that you don't have to install a plugin
package-wide using setuptools, but you can actually `just dynamically
add it during run-time`_. All you have to do is:

.. code-block:: python

  import nose

  from yourplugin import YourPlugin

  if __name__ == '__main__':
      nose.main(addplugins=[YourPlugin()])


This way, you can just execute your tests as normal, like so:

.. code-block:: bash

  python nose-testtimers.py --with-test-timer -sv --debug=sqlalchemy.engine


and you get a nice little output of test times :)

.. _Nose: https://nose.readthedocs.io/en/latest/
.. _insightful google-groups post: http://groups.google.com/group/nose-users/browse_thread/thread/ad51415d14bda06e
.. _xunit nose plugin: https://github.com/nose-devs/nose/blob/master/nose/plugins/xunit.py
.. _just dynamically add it during run-time: https://nose.readthedocs.io/en/latest/plugins/writing.html#registering-a-plugin-without-setuptools
