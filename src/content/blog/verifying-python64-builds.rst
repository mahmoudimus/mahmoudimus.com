Verifying Python64 builds
#########################
:date: 2009-07-06 11:24
:author: Mahmoud
:tags: linux, programming, python
:classification: blog
:excerpt: Verifying if python was built correctly on 64bit machines that have a 32bit default

At work, I'm migrating over `python`_ to our 64bit machines and one
thing that I've noticed was that there really was no standard python
64bit verification method to ensure the build was really 64bit or not.
I've read `somewhere`_ previously, especially for the Mac OS X crowd,
that the LDFLAGS="-arch x86\_64" flag had to be passed in before
building on a 64bit machine.

It looks like python2.6 changed the way it was required to build
respective 64bit binaries. To build on standard linux x86\_64
architecture, the following standard steps to installing on a 64bit
machine worked for me:

.. code-block:: bash

  ./configure
  make && make test
  make install


Surprisingly, I received a segmentation fault when building as well as
testing. I've never seen this before, but for those of you who are
interested, the error message was:

.. code-block:: bash

  Parser/pgen ./Grammar/Grammar ./Include/graminit.h ./Python/graminit.c
  make: \*\*\* [Include/graminit.h] Segmentation fault
  Parser/pgen ./Grammar/Grammar ./Include/graminit.h ./Python/graminit.c
  make: \*\*\* [Python/graminit.c] Segmentation fault


The verification step is actually pretty intuitive. An easy test to
verify that you're on a 64bit machine is to find the size of the
MAX_INT. Luckily for us, python makes this a very easy verification.

To verify the build, I went on a regular python 32bit machine and I did:

.. code-block:: python

  import sys
  assert sys.maxint == 2147483647


On a 64bit machine, I did:

.. code-block:: python

  import sys
  assert sys.maxint == 9223372036854775807


Clearly, my 64bit installation worked:)

Hope this helps some of you.

.. _python: http://www.python.org/
.. _somewhere: http://www.corepy.org/wiki/index.php?title=How_To_Build_a_64-bit_Python_and_use_Corepy/x86_64_on_OSX
