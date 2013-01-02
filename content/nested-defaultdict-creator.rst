.. code-block:: python

def nested_defaultdict(factory, level):
    """Makes a nested defaultdict(factory) n-deep, so that the total
    number of nested defaultdicts are level + 1 deep.

    This function is for convenience.

    For example:
    >>> # equivalent to defaultdict(lambda: defaultdict(list))
    >>> nested_dd = nested_defaultdict(list, 1)
    >>> nested_dd['z']['x']
    []
    >>> nested_dd['z']['y'].append('foo')
    >>> nested_dd['z']['y']
    ['foo']
    >>> # equivalent to:
    >>> # defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    >>> nested_2_deep = nested_defaultdict(int, 2)
    >>> nested_2_deep['x']['y']['z']
    0

    """
    if level == 0:
        ret = defaultdict(factory)
    else:
        ret = nested_defaultdict(lambda: defaultdict(factory), level - 1)

    return ret
