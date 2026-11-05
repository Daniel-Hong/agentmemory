def observe_until_idle(observe,pause,notice=lambda *args:None):
    """At most four fresh reads/15s; never retry writes or waive predicates."""
    for attempt in range(4):
        value=observe();proof=value[-1]
        if proof['failedPredicates']!=['activeMutationsZero'] or attempt==3:
            return value
        notice(attempt+1,proof)
        pause(5)
    raise AssertionError('unreachable')
