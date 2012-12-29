Python 2.6.4 and Twisted 9 on OS X 10.6 Snow Leopard
####################################################
:date: 2009-12-27 02:06
:author: Mahmoud
:tags: programming, python, software

I just recently purchased a MacBook Pro, which comes with Snow Leopard
installed, and I noticed that it comes with python 2.6.1 installed. I
wanted to upgrade to the latest python release of 2.6.4, so I tried
installing the official python Mac OS distribution from python.org.
After installation, I wanted to install `Twisted`_ and I kept getting
this error below:

.. code-block:: bash

  creating build/temp.macosx-10.3-fat-2.6
  creating build/temp.macosx-10.3-fat-2.6/twisted
  creating build/temp.macosx-10.3-fat-2.6/twisted/runner
  gcc-4.0 -arch ppc -arch i386 -fno-strict-aliasing -fno-common -dynamic -DNDEBUG -g -O3 -I/Library/Frameworks/Python.framework/Versions/2.6/include/python2.6 -c twisted/runner/portmap.c -o build/temp.macosx-10.3-fat-2.6/twisted/runner/portmap.o
  In file included from /usr/include/architecture/i386/math.h:626,
   from /usr/include/math.h:28,
   from /Library/Frameworks/Python.framework/Versions/2.6/include/python2.6/pyport.h:235,
   from /Library/Frameworks/Python.framework/Versions/2.6/include/python2.6/Python.h:58,
   from twisted/runner/portmap.c:10:
  /usr/include/AvailabilityMacros.h:108:14: warning: #warning Building for Intel with Mac OS X Deployment Target < 10.4 is invalid.
  Compiling with an SDK that doesn't seem to exist: /Developer/SDKs/MacOSX10.4u.sdk
  Please check your Xcode installation
  gcc-4.0 -arch ppc -arch i386 -isysroot /Developer/SDKs/MacOSX10.4u.sdk -g -bundle -undefined dynamic_lookup build/temp.macosx-10.3-fat-2.6/twisted/runner/portmap.o -o build/lib.macosx-10.3-fat-2.6/twisted/runner/portmap.so
  ld: library not found for -lbundle1.o
  ld: library not found for -lbundle1.o
  collect2: ld returned 1 exit status
  collect2: ld returned 1 exit status
  lipo: can't open input file: /var/folders/T6/T6diKRiFGJSwsabKP4864E+++TI/-Tmp-//ccIK1c3K.out (No such file or directory)
  error: command 'gcc-4.0' failed with exit status 1


Something's not right -- setuptools is detecting that I'm using
macosx-10.3, but I'm using Mac OS X 10.6.  Why is it that setuptools
also wants to use /Developer/SDKs/MacOS10.4u.sdk to build python
extensions? I'm currently using the SDK for Mac OS X 10.6, and I don't
want to install another SDK.

Well, I did a little bit of research and I learned that PSF's 2.6.4
python package for a Mac is built with an option called
--enable-universalsdk which, according to the `readme`_, defaults to
/Developer/SDKs/MacOSX.10.4u.sdk. This is why building third-party
extensions tries to reference the 10.4 SDK.

I was able to build python successfully using the following:

.. code-block:: bash

  ./configure --enable-framework --enable-universalsdk=/Developer/SDKs/MacOSX10.6.sdk/ --with-universal-archs=intel
  make && make test
  sudo make install

You'll notice that the following 3 tests failed when attempting to run
the unit tests:

-  asyncore
-  test\_platform
-  test\_macostools

The test that should really put you on alert is asyncore. After doing
some `research`_, it turns out the asyncore module is using some variant
of select.poll(), which isn't supported by the FreeBSD kernel. FreeBSD
uses something called kqueue, which is what the test doesn't take into
account. To fix this, I pulled the `asyncore.py`_ module from the trunk
and overwrote /Lib/asyncore.py. The tests passed then.

You don't need to fix the other two, as they only pertain to fixing the
actual tests themselves instead of having to actually change a module.
If you're interested though, fixing "test\_platform" follows the same
pattern as asyncore. `Brett Cannon`_ actually `filed a bug`_ for this
test and `submitted a patch`_, but you will still need to replace the
entire test\_platform.py module to get it working. Apparently, this
patch is for python v2.7, v3.1, and v3.2. To fix it, download the
patched `test\_platform.py`_ module and replace it with the one in
/Lib/test/test\_platform.py. Make sure you also delete
/Lib/test/test\_platform.pyc.

The last test, test\_macostools, is actually quite interesting.
Apparently, `Apple does not supply 64-bit versions of the Carbon
frameworks used by these modules`_. This is why this test is failing.
Looks like there might not be a way to fix this test until Apple
upgrades the Carbon frameworks to 64-bit usage.

After fixing these bugs, make sure you run the following command:

.. code-block:: bash

  sudo make install

Needless to say, after I installed python with the options above, and
after I fixed all these modules, the Twisted 9.0 installation was
successful.

I hope this helps some of you in case you run into this problem!

.. _Twisted: http://twistedmatrix.com/trac/
.. _readme: http://svn.python.org/projects/python/trunk/Mac/README
.. _research: http://bugs.python.org/issue5798
.. _asyncore.py: http://svn.python.org/view/*checkout*/python/trunk/Lib/asyncore.py?revision=73184&content-type=text%2Fplain
.. _Brett Cannon: http://sayspy.blogspot.com/
.. _filed a bug: http://bugs.python.org/issue6806
.. _submitted a patch: http://svn.python.org/view/python/trunk/Lib/test/test_platform.py?r1=73714&r2=74640&pathrev=74640
.. _test\_platform.py: http://svn.python.org/view/*checkout*/python/trunk/Lib/test/test_platform.py?revision=74640&content-type=text%2Fplain
.. _Apple does not supply 64-bit versions of the Carbon frameworks used by these modules: http://bugs.python.org/issue7041
