#!/usr/bin/env python3
"""Pure shadow observer. No future-clock allowance; no control authorization.

--check reads one JSON object from stdin and emits summary JSON. Exit 2 means
unsafe/refused (including missing sample); exit 0 only means this poll passed
these checks, never that a resume is authorized. Drain budgets are hypothetical.
"""
import argparse
import json
import math
import sys

MAX_NUMBER = 2 ** 53 - 1
MEMORY_FIELDS = ('heapUsed', 'heapTotal', 'heapLimit', 'rss', 'external', 'arrayBuffers')


def number(value, positive=False, integer=False):
    return (type(value) in (int, float)
            and (value > 0 if positive else value >= 0) and value <= MAX_NUMBER
            and math.isfinite(value)
            and (not integer or type(value) is int))


class Observer:
    def __init__(self, expectedPid, drainBudgetSeconds=None):
        if not number(expectedPid, positive=True, integer=True):
            raise ValueError('invalid_expected_pid')
        if drainBudgetSeconds is not None and not number(drainBudgetSeconds):
            raise ValueError('invalid_drain_budget')
        self.expected_pid = expectedPid
        self.drain_budget = drainBudgetSeconds
        self.samples = []
        self.last = None

    def feed(self, health_response, receivedAtMs, hostAvailableBytes):
        reasons = []
        result = {'unsafe': True, 'freshness': 'unavailable', 'protectiveReasons': reasons,
                  'refusalReason': None, 'sample': None, 'shadowCandidate': None}
        h = health_response if isinstance(health_response, dict) else {}
        if not number(hostAvailableBytes):
            reasons.append('host_available_invalid')
        elif hostAvailableBytes < 8 * 1024 ** 3:
            reasons.append('host_available_below_8gib')
        pressure = h.get('memoryPressure')
        if not isinstance(pressure, dict) or pressure.get('level') != 'normal':
            reasons.append('memory_pressure_not_normal')
        durability = h.get('storageDurability')
        failures = durability.get('mutationFailures') if isinstance(durability, dict) else None
        if not number(failures, integer=True):
            reasons.append('mutation_failures_unavailable')
        elif failures > 0:
            reasons.append('storage_mutation_failures')
        try:
            s = h.get('resourceSample')
            if not isinstance(s, dict):
                raise ValueError('missing_resource_sample')
            if type(s.get('version')) is not int or s['version'] != 1:
                raise ValueError('invalid_sample_version')
            if not number(s.get('pid'), positive=True, integer=True) or s['pid'] != self.expected_pid:
                raise ValueError('unexpected_pid')
            fields = ('startedAtMs', 'finishedAtMs', 'uptimeStartSeconds', 'uptimeEndSeconds')
            if not all(number(s.get(k)) for k in fields) or not number(receivedAtMs):
                raise ValueError('invalid_sample_time')
            start, end, us, ue = (s[k] for k in fields)
            if (end < start or ue < us or end-start > 1000 or ue-us > 1
                    or abs((ue-us)*1000-(end-start)) > 50):
                raise ValueError('incoherent_sample_interval')
            if receivedAtMs < end:
                raise ValueError('future_sample')
            age = receivedAtMs-end
            if age > 15000:
                raise ValueError('stale_sample')
            m = s.get('memory')
            if not isinstance(m, dict) or not all(number(m.get(k), positive=k == 'heapLimit') for k in MEMORY_FIELDS):
                raise ValueError('invalid_memory')
            normalized = dict(version=1, pid=s['pid'], **{k:s[k] for k in fields},
                              memory={k:m[k] for k in MEMORY_FIELDS})
            if m['heapUsed'] >= .7*m['heapLimit']:
                reasons.append('heap_at_or_above_70_percent')
            identity = tuple(s[k] for k in fields)
            duplicate = self.last is not None and identity == self.last[0]
            if duplicate and normalized != self.last[1]:
                raise ValueError('changed_duplicate')
            if self.last is not None and not duplicate:
                previous = self.last[1]
                if us <= previous['uptimeEndSeconds'] or start < previous['finishedAtMs']:
                    raise ValueError('out_of_order_or_epoch_change')
            reset = None
            pending_samples = self.samples[:]
            if not duplicate:
                if pending_samples and m['heapUsed'] < pending_samples[-1]['memory']['heapUsed']:
                    pending_samples = []
                    reset = 'measured_heap_release'
                pending_samples.append(normalized)
                pending_samples = pending_samples[-6:]
            slopes = [(b['memory']['heapUsed']-a['memory']['heapUsed']) /
                      (b['uptimeEndSeconds']-a['uptimeEndSeconds'])
                      for a,b in zip(pending_samples,pending_samples[1:])]
            if not all(math.isfinite(v) for v in slopes):
                raise ValueError('nonfinite_trend')
            positive = [v for v in slopes if v > 0]
            slope = max(positive) if positive else 0
            horizon = None if self.drain_budget is None else self.drain_budget+10+20+age/1000
            candidate = {'shadowOnly': True, 'authorizesResume': False,
                         'sampleCount': len(pending_samples), 'segmentReset': reset,
                         'positiveSlopesBytesPerSecond': positive,
                         'positiveSlopeCount': len(positive), 'repeatedPositiveSlopes': len(positive)>=2,
                         'warning120Seconds80Percent': bool(positive and m['heapUsed']+slope*(120+age/1000)>=.8*m['heapLimit']),
                         'drainBudgetSeconds': self.drain_budget, 'pollSeconds': 10,
                         'safetyMarginSeconds': 20, 'sampleAgeSeconds': age/1000,
                         'hypotheticalHeadroomTo80PercentBytes': None if horizon is None else .8*m['heapLimit']-m['heapUsed']-slope*horizon}
            headroom = candidate['hypotheticalHeadroomTo80PercentBytes']
            if (not math.isfinite(m['heapUsed']+slope*(120+age/1000))
                    or (headroom is not None and not math.isfinite(headroom))):
                raise ValueError('nonfinite_trend')
            if not duplicate:
                self.samples = pending_samples
                self.last = (identity, normalized)
            result.update(unsafe=bool(reasons), freshness='duplicate' if duplicate else 'fresh',
                          sample=normalized, shadowCandidate=candidate)
        except ValueError as exc:
            result['refusalReason'] = str(exc)
        return result


def read_check_input(stream):
    raw = stream.read(131073)
    if len(raw) > 131072:
        raise ValueError('check_input_too_large')
    try:
        value = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ValueError('invalid_check_input') from exc
    if not isinstance(value, dict):
        raise ValueError('invalid_check_input')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', required=True)
    parser.parse_args()
    try:
        data = read_check_input(sys.stdin.buffer)
        observer = Observer(data['expectedPid'], data.get('drainBudgetSeconds'))
        result = observer.feed(data['response'], data['receivedAtMs'], data['hostAvailableBytes'])
    except (ValueError, KeyError, TypeError):
        result = {'unsafe': True, 'freshness': 'unavailable', 'refusalReason': 'invalid_check_input'}
    print(json.dumps(result, allow_nan=False, separators=(',', ':')))
    return 2 if result['unsafe'] else 0


if __name__ == '__main__':
    sys.exit(main())
