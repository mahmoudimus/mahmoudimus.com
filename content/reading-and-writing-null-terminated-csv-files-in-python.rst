Reading and Writing Null-Terminated CSV Files in Python
#######################################################
:date: 2010-09-12 18:42
:author: Mahmoud
:tags: linux, programming, python

I've recently had to do some work that required sorting a very large CSV
file, containing fields with embedded newlines, quickly. As it turns
out, Linux comes with a sort implementation that has a
`"--zero-terminated"`_ option, which sorts on null-terminated delimited
strings instead of the default newline separator.

**Writing null-terminated CSV files**

Since I was writing a process to generate these CSV files, I figured I
can just use Python's `CSV module`_, which has support for different
types of dialects. Inheriting from `csv.Dialect`_, we can write a simple
dialect that will allow us to terminate all lines with a null byte.

.. code-block:: python

  import csv
  import struct

  class null_terminated(csv.excel):
      lineterminator = struct.pack('B', 0)

  csv.register_dialect("null-terminated", null_terminated)


Essentially, we've registered a global csv dialect called
``"null-terminated"`` that inherits from the `excel`_ dialect, which has
sensible standard defaults.

Here's a simple snippet that shows the usage of the new
``"null-terminated"`` dialect that I created above.

.. code-block:: python

  from csv import DictWriter

  with open("/tmp/file.csv", "w") as f:
      dwriter = DictWriter(f, fieldnames=["id","field"], dialect="null-terminated")

      for i, field in enumerate(("foo", "bar", "baz", "bif")):
          dwriter.writerow({"id": i, "field": field})

Now, */tmp/file.csv* will contain a file with four rows that are
separated by a null-terminator. As you can see, it's pretty easy to
write a null-terminated CSV file, but unfortunately, it's a bit tricky
to *read* a null-terminated csv file due to some inflexible hardcoded
defaults.

**Reading null-terminated CSV files**

The CSV module's unintuitive restriction for `Dialect.lineterminator`_
is hard-coded to recognize ``'\r'`` or ``'\n'`` as the end of line
terminator, which unfortunately, means we will need to handle
null-termination and implement reading ourselves.

There are many ways of writing a procedure to read null-terminated
strings, but I figured the simplest algorithm is to read
character-by-character, concatenating everything into a string until we
reach a null byte, then we can just return the string. I'd figure an
implementation might go something like this:

.. code-block:: python

  def read(fobj):
      current_string = ""
      while True:
          char = fobj.read(1)
          if char and char != nullbyte:
              current_string += char
          elif char == nullbyte:
              yield current_string
              current_string = ""
          elif not char:
              if current_string:
                  yield current_string
              raise StopIteration


Looks awesome, but, how can we integrate this into the CSV module? We
would want to just plug and play with the existing CSV module. A simple
solution is to wrap the function above to iterate over each line, like
so:


.. code-block:: python

  # we use StringIO since cStringIO has poor unicode support
  from StringIO import StringIO
  from csv import reader

  class NullTerminatedDelimiterReader(object):
      """
      A CSV reader which will iterate over lines in the CSV file 'f',
      which are line terminated by a null byte

      """

      def __init__(self, f,  dialect, *args, **kwds):
          # satisfying DictReader instance
          self._line_num = 0
          self.fobj = f
          self.dialect = dialect
          self.reader = self._read()
          self.string_io = StringIO()

      def _properly_parse_row(self, current_string):
          self.string_io.write(current_string)
          # seek to the first byte
          self.string_io.seek(0)
          # we instantiate a reader here to properly parse the row
          # taking into account escaping, and various edge cases
          return next(reader(self.string_io, dialect=self.dialect))

      def _read(self):
          current_string = ""
          while True:
              char = self.fobj.read(1)  # read one byte
              if char and char != null_byte:
                  # keep appending to the current string
                  current_string += char
              elif char == null_byte:
                  yield self._properly_parse_row(current_string)
                  # increment instrumentation
                  self._line_num += 1
                  # clear internal reading buffer
                  self.string_io.seek(0)
                  self.string_io.truncate()
                  # clear row
                  current_string = ""
              elif not char:
                  if current_string:
                      yield self._properly_parse_row(current_string)
                  raise StopIteration

      @property
      def line_num(self):
          return self._line_num

      def next(self):
          return next(self.reader)

      def __iter__(self):
          return self


To use the DictReader class, we'll inherit from the `DictReader`_ class
and override the reader object. It's the cleanest and simplest way of
doing it.

.. code-block:: python

  class NullByteDictReader(csv.DictReader):
      def __init__(self, f, *args, **kwds):
          csv.DictReader.__init__(self, f, *args, **kwds)
          self.reader = NullTerminatedDelimiterReader(f, *args, **kwds)

  with open("/tmp/file.csv", "r") as f:
      for line in NullByteDictReader(f, dialect="null-terminated"):
          print line["id"], line["field"]

Voila :)

**Conclusions and Future Work**

Something that might be interesting to pursue further is the possibility
of writing, or wrapping a python interface around, a `C library`_ as a
substitute for the current CSV module. It should be able to support
different line terminators, multi-byte delimiters, and have unicode
detection outside the box, which happen to be my main three gripes with
the CSV module.

For your convenience, I've put all the code in a `gist <http://gist.github.com/576675>`_.
You should follow me on `twitter <http://twitter.com/mahmoudimus>`_.

.. _"--zero-terminated": http://linux.die.net/man/1/sort
.. _CSV module: http://docs.python.org/library/csv.html
.. _csv.Dialect: http://docs.python.org/library/csv.html#csv.Dialect
.. _excel: http://docs.python.org/library/csv.html#csv.excel
.. _Dialect.lineterminator: http://docs.python.org/library/csv.html#csv.Dialect.lineterminator
.. _DictReader: http://svn.python.org/projects/python/trunk/Lib/csv.py
.. _C library: http://www.kilabit.org/
