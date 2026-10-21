import {it,expect} from 'vitest';
import {capturePayloadDigest,captureSourceDigest} from '../src/capture/receipt-digest.js';
import {scrubRecord,stripPrivateData} from '../src/functions/privacy.js';
import {SAFE_PAYLOAD_BYTES,payloadByteLength} from '../src/state/frame-guard.js';
it('matches the full sanitized Unicode source regardless of object field order and never the short preview',()=>{
 const body={hookType:'post_tool_use',timestamp:'2026-10-21T00:00:00Z',data:{z:'한😀'.repeat(70_000),a:'<private>synthetic secret</private>'}};
 const stored=JSON.parse(stripPrivateData(JSON.stringify(scrubRecord(body.data))));
 expect(capturePayloadDigest(body)).toBe(captureSourceDigest(body.hookType,body.timestamp,{a:stored.a,z:stored.z}));
 expect(capturePayloadDigest(body)).not.toBe(captureSourceDigest(body.hookType,body.timestamp,{a:stored.a,z:stored.z.slice(0,16000)}));
});
it('accounts for sourceRaw duplication near the existing transport ceiling without truncating it',()=>{
 const tool='x'.repeat(7_034_880),raw={raw:{tool_output:tool},toolOutput:tool};
 expect(payloadByteLength({sourceRaw:raw})).toBeGreaterThan(14_000_000);
 expect(payloadByteLength({sourceRaw:raw})).toBeLessThan(SAFE_PAYLOAD_BYTES);
 const unsupported={raw:{tool_output:tool,tool_response:tool},toolOutput:tool};
 expect(payloadByteLength({sourceRaw:unsupported})).toBeGreaterThan(SAFE_PAYLOAD_BYTES);
 expect(raw.raw.tool_output.length).toBe(7_034_880);
});
