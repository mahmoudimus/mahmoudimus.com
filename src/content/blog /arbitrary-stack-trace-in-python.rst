Arbitrary Stack Trace in Python
###############################
:date: 2011-02-11 15:52
:author: Mahmoud
:tags: programming, python
:classification: blog
:excerpt: How to take an arbitrary stack trace in Python

I had a need to trace a function's call stack to identify call chain
paths in some difficult-to-follow Python code that was laced with lots
of magic and abstractions.

I tried stepping through ipdb, but it took forever. So, I thought to
myself, why can't I just take a stack trace and I'll be able to get the
call stack. It didn't help that this function was apparently called
multiple times from different places so when I tried raising an
unhandled exception, it only helped display the stack trace for the
first call to the function, not the successive ones. I also tried
throwing and catching the exception, assuming that a stack trace can
share some information about its call chain. That didn't work too well
because the exception masked the stack [1]_.

So I wrote some simple code that will do exactly that, take a stack
trace and format it as if it looked like an exception traceback. Without
further ado, here is, as far as I know, the only way to get an arbitrary
stack trace in Python from any line of code.

.. code-block:: python

  import inspect
  import traceback

  # get the currently frames' stack
  # this returns the frameobject, the filename,
  # the line number of the current line, the
  # function name, a list of lines of context from
  # the source code, and the index of the current
  # line within that list.

  stack = inspect.stack()

  # reverse the stack trace so the most recent is at the bottom of the stack

  stack.reverse()
  stack_list = []

  try:
      for s in stack:
          _, filename, line_no, func_name, code_list, index_in_code_list = s
          stack_list.append(
             (filename, line_no, func_name, code_list[index_in_code_list])
          )
      print ''.join(traceback.format_list(stack_list))
  finally:
      # avoid memory leak issues
      del stack


Hope this helps in your debugging adventures.

I'd love to hear if there are any other ways of doing the same thing.

**EDIT:**

My original assumption was right. Using a stack trace to get the call
chain is one way of doing it.

Turns out Python already does this in the `traceback.print\_stack`_
function.

Thanks to `@teepark`_ for the comment!

.. [1] I should probably revisit this later to see why it didn't work. In
       theory it should do what the stack trace snippet above does.

.. _traceback.print\_stack: http://docs.python.org/library/traceback.html?#traceback.print_stack
.. _@teepark: http://twitter.com/teepark/
