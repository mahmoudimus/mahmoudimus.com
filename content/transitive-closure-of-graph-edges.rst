    def transitive_closure(*list_of_tuples):
        closures = defaultdict(set)

        def _merge(x, y):
            """Checks for the elements existence in the
            closure and updates all elements accordingly
            to point to the most recent closure

            """
            for e in closures[y]:
                closures[x] |= set([e])
                closures[e] = closures[x]

        for x, y in chain.from_iterable(list_of_tuples):
            # check if we've already seen y
            # so that if we did, we can merge it
            # into the closure of x
            if y in closures:
                _merge(x, y)
            else:
                # add x to itself so it keeps a full
                # transitive closure to all elements
                # in this graph
                closures[x] |= set([x])

            closures[x] |= set([(y)])
            closures[y] = closures[x]

        for k in closures.keys():
            for v in closures[k]:
                if v == k:
                    continue
                del closures[v]

        return filter(None, closures.values())
