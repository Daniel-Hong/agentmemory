import {createHash} from 'node:crypto';

// A read-reuse identity for the full JSON wire value, not a byte/durability receipt.
// Normalize through JSON first so toJSON, omitted fields and boxed primitives keep
// their wire meaning. Only object key order is canonicalized; arrays/strings stay exact.
export function observationJsonFingerprint(serialized){
 if(typeof serialized!=='string')throw new TypeError('observation JSON value required');
 const plain=JSON.parse(serialized);
 const canonical=JSON.stringify(plain,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
 return createHash('sha256').update(canonical).digest('hex');
}
export const observationValueFingerprint=value=>observationJsonFingerprint(JSON.stringify(value));
