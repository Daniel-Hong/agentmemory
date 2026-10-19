import { describe, expect, it } from 'vitest';
import { StateKV } from '../src/state/kv.js';
import { VectorIndex } from '../src/state/vector-index.js';
import { IndexPersistence } from '../src/state/index-persistence.js';

// iii-sdk 0.22.1 resolves an absent state::get result as undefined.
function fixture() {
  const rows = new Map<string, unknown>();
  const sdk = { trigger: async ({ function_id, payload }: { function_id: string; payload: { scope: string; key: string; value?: unknown } }) => {
    const key = `${payload.scope}/${payload.key}`;
    if (function_id === 'state::get') return rows.get(key);
    if (function_id === 'state::set') { rows.set(key, payload.value); return payload.value; }
    if (function_id === 'state::delete') return rows.delete(key);
    throw Error(`unexpected function ${function_id}`);
  } };
  return new StateKV(sdk as never, { backend: 'redis' });
}

describe('StateKV missing-value boundary', () => {
  it('normalizes the actual SDK missing result to its declared null contract', async () => {
    expect(await fixture().get('scope', 'absent')).toBeNull();
  });

  it.each([false, 0, '', null, { id: 'kept' }])('preserves a stored value: %j', async value => {
    const kv = fixture(); await kv.set('scope', 'present', value);
    expect(await kv.get('scope', 'present')).toEqual(value);
  });

  it('certifies saved vectors and deletions with real SDK missing-value semantics', async () => {
    const kv = fixture(), index = new VectorIndex();
    const persistence = new IndexPersistence(kv, index); persistence.stop();
    index.add('synthetic', 'session', new Float32Array([1, 0]));
    await expect(persistence.saveVerified({ id: 'synthetic', entry: index.get('synthetic')! })).resolves.toBeUndefined();
    index.remove('synthetic');
    await expect(persistence.saveVerified({ id: 'synthetic', entry: null })).resolves.toBeUndefined();
  });
});
