A Pythonic ``n``-wise Iterator for Any Iterable
###############################################
:date: 2010-06-01 00:48
:author: Mahmoud
:tags: programming, python
:classification: blog
:excerpt: Extending python's `itertools`_ module

Over the weekend, I was working on upgrading `python-ngrams`_ because I
had discovered a bug where the tokenization was incorrect. I was reading
a research paper that was describing q-grams and while following their
examples, I realized I was getting incorrect results for a fundamental
n-gram result.

The tokenization that's required here is quite simple, given some
iterable consisting of values ``[x0, x1, x2, x3...,xi]``, produce an
exhaustive iterator of n-tuples such that it satisfies
(``x0,...xn), (x1,...xn+1), (xm,...xi``).

To make this easier to understand, if given a list of
``[0, 1, 2, 3, 4, 5, 6]``, I want to be able to return an iterator such
that:

.. code-block:: python

  for first, second, third in n_wise([0, 1, 2, 3, 4, 5, 6], 3):
      print first, second, third

Will have a result of:

.. code::

  0, 1, 2
  1, 2, 3
  2, 3, 4
  3, 4, 5
  4, 5, 6

Fortunately, this wasn't too difficult as the trivial implementation of
this is already done in `itertools`_, under pairwise. Below I've
implemented a n-wise iterator implementation that can take any iterator
and return n-iterators where each iterator is advanced by a step ahead
of the other.

.. code-block:: python

  from itertools import tee, izip


  def n_wise(iterable, n):
      """
      Returns n iterators for an iterable that are sequentially

      n-wise

      """
      n_iterators = tee(iterable, n)
      zippables = [n_iterators[0]]

      for advance, iteratee in enumerate(n_iterators[1:]):
          advance += 1  # since enumerate is 0 indexed.

          while advance > 0:
             # we advance the iterator ``advance+1`` steps
             next(iteratee, None)
             advance -= 1
             # append everything to the zippables
             zippables.append(iteratee)
             # return the izip expansion of each iterator
      return izip(*zippables)


I find that I sometimes need to open an iterator for a file and I need
to read n-wise lines each step, this iterator will do just that. For
sake of completeness, look at how concise, powerful, and easy to use
this combination is:

.. code-block:: python

  # assuming that n_wise is imported into this namespace

  from functools import partial

  triple_wise_line_reader = partial(n_wise, n=3)

  for line1, line2, line3 in triple_wise_line_reader(open("some_file.log", "r")):
      # do some computation with line1, line2 and line3
      do_something(line1, line2, line3)

      # next step:
      # line1 <- line2
      # line2 <- line3
      # line3 <- line4


Imagine doing this in C ;) It will be just ugly!

Please let me know if you find this useful or you have a better
implementation to the problem!

.. _python-ngrams: http://github.com/mahmoudimus/python-ngrams
.. _itertools: http://docs.python.org/library/itertools.html