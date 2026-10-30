import copy
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).with_name('live-memory-observer.py')
spec = importlib.util.spec_from_file_location('live_memory_observer', path)
module = importlib.util.module_from_spec(spec)
if path.exists():
    spec.loader.exec_module(module)

GIB = 1024 ** 3

def health(t=100000, heap=40, uptime=100):
    return {'memory': {'heapUsed': 999}, 'memoryPressure': {'level': 'normal'},
            'storageDurability': {'mutationFailures': 0},
            'resourceSample': {'version': 1, 'pid': 42, 'startedAtMs': t,
              'finishedAtMs': t + 5, 'uptimeStartSeconds': uptime,
              'uptimeEndSeconds': uptime + .005,
              'memory': dict(heapUsed=heap, heapTotal=90, heapLimit=100,
                             rss=120, external=2, arrayBuffers=1)}}

class ObserverTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(module, 'Observer'), 'Observer implementation missing')
        self.o = module.Observer(42)

    def feed(self, h=None, now=100010, host=10*GIB):
        return self.o.feed(health() if h is None else h, now, host)

    def test_live_sample_and_cached_memory_ignored(self):
        r = self.feed()
        self.assertEqual(r['freshness'], 'fresh')
        self.assertEqual(r['sample']['memory']['heapUsed'], 40)
        self.assertFalse(r['unsafe'])
        h = health(); del h['resourceSample']
        self.assertEqual(self.feed(h)['freshness'], 'unavailable')

    def test_duplicate_and_changed_duplicate(self):
        self.feed()
        for _ in range(20):
            r = self.feed()
        self.assertEqual(r['shadowCandidate']['sampleCount'], 1)
        self.assertEqual(r['freshness'], 'duplicate')
        h = health(); h['resourceSample']['memory']['heapUsed'] = 41
        self.assertTrue(self.feed(h)['unsafe'])

    def test_validation_and_monotonicity(self):
        for field, value in [('pid', True), ('pid', 43), ('version', '1'),
                             ('startedAtMs', float('nan')), ('finishedAtMs', 101001),
                             ('uptimeEndSeconds', 99)]:
            h = health(); h['resourceSample'][field] = value
            self.assertTrue(module.Observer(42).feed(h, 101010, 10*GIB)['unsafe'], field)
        self.assertTrue(self.feed(now=100004)['unsafe'])
        self.assertTrue(self.feed(now=115006)['unsafe'])
        self.feed()
        self.assertTrue(self.feed(health(100010, uptime=99), 100020)['unsafe'])
        self.assertTrue(self.feed(health(99999, uptime=101))['unsafe'])
        h = health(); h['resourceSample']['memory']['rss'] = '120'
        self.assertTrue(self.feed(h)['unsafe'])

    def test_absolute_protections_on_duplicates(self):
        self.feed()
        for key, value in [('memoryPressure', {'level': 'high'}), ('storageDurability', {'mutationFailures': 1})]:
            h = health(); h[key] = value
            self.assertTrue(self.feed(h)['protectiveReasons'])
        self.assertIn('host_available_below_8gib', self.feed(host=8*GIB-1)['protectiveReasons'])
        self.assertIn('heap_at_or_above_70_percent', module.Observer(42).feed(health(heap=70),100010,10*GIB)['protectiveReasons'])

    def test_incoherent_monotonic_duration(self):
        for duration in (1000, .2):
            h = health(); h['resourceSample']['uptimeEndSeconds'] = 100 + duration
            self.assertEqual(self.feed(h)['refusalReason'], 'incoherent_sample_interval')

    def test_huge_integer_and_overflow_slope_refuse_without_history_change(self):
        h = health(); h['resourceSample']['memory']['rss'] = 10**400
        self.assertEqual(self.feed(h)['refusalReason'], 'invalid_memory')
        o = module.Observer(42, drainBudgetSeconds=10**15)
        first = health(uptime=0)
        first['resourceSample']['uptimeEndSeconds'] = 0
        o.feed(first, 100010,10*GIB)
        for spacing in (5e-324, 1e-300):
            h = health(100005, heap=41, uptime=spacing)
            h['resourceSample']['uptimeEndSeconds'] = spacing
            r = o.feed(h,100010,10*GIB)
            self.assertEqual(r['refusalReason'], 'nonfinite_trend')
            self.assertEqual(len(o.samples),1)
            self.assertEqual(o.last[1]['memory']['heapUsed'],40)

    def test_bounded_cli_input(self):
        import io
        for raw in (b'[]', b'{}' + b' ' * 131071, b'\xff'):
            with self.subTest(raw_length=len(raw)):
                self.assertRaises(ValueError, module.read_check_input, io.BytesIO(raw))
        self.assertEqual(module.read_check_input(io.BytesIO(b'{}')), {})

    def test_boundary_refusals_and_prediction_warning(self):
        for field, value in [('heapLimit', 0), ('heapUsed', -1),
                             ('external', float('nan')), ('arrayBuffers', True)]:
            h = health(); h['resourceSample']['memory'][field] = value
            with self.subTest(field=field):
                self.assertTrue(self.feed(h)['unsafe'])
        self.feed()
        self.assertEqual(self.feed(now=115006)['refusalReason'], 'stale_sample')
        o = module.Observer(42)
        o.feed(health(heap=40), 100010,10*GIB)
        r = o.feed(health(110000, 50,110),110010,10*GIB)
        self.assertTrue(r['shadowCandidate']['warning120Seconds80Percent'])
        self.assertIsNone(r['shadowCandidate']['hypotheticalHeadroomTo80PercentBytes'])
        self.assertFalse(r['shadowCandidate']['authorizesResume'])

    def test_trend_release_bounded_history_and_budget(self):
        self.o = module.Observer(42, drainBudgetSeconds=30)
        for i in range(10):
            r = self.feed(health(100000+i*10000, 40+i,100+i*10),100010+i*10000)
        c = r['shadowCandidate']
        self.assertEqual(c['sampleCount'], 6)
        self.assertEqual(c['positiveSlopeCount'], 5)
        self.assertTrue(c['warning120Seconds80Percent'] is False)
        self.assertAlmostEqual(c['hypotheticalHeadroomTo80PercentBytes'], 80-49-.1*(30+10+20+.005))
        other = module.Observer(42, drainBudgetSeconds=60)
        for i in range(2):
            r2 = other.feed(health(100000+i*10000,40+i,100+i*10),100010+i*10000,10*GIB)
        self.assertLess(r2['shadowCandidate']['hypotheticalHeadroomTo80PercentBytes'], 80-41-.1*60)
        r = self.feed(health(200000, 30, 200),200010)
        self.assertEqual(r['shadowCandidate']['sampleCount'], 1)
        self.assertEqual(r['shadowCandidate']['segmentReset'], 'measured_heap_release')
        self.assertFalse(r['shadowCandidate']['authorizesResume'])

if __name__ == '__main__':
    unittest.main()
