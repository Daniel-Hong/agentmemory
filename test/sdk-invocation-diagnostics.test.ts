import {it,expect} from 'vitest';
import {InvocationError} from 'iii-sdk';
import {safeFailureDetails} from '../src/ops/provider-readiness.mjs';
it('retains fixed SDK identifiers without retaining private payload or raw error text',()=>{
 const error=Object.assign(new InvocationError({code:'TIMEOUT',function_id:'state::set',message:'private message'}),{payload:{secret:'private'},key:'private-key'});
 expect(safeFailureDetails(error)).toEqual({sdkFunction:'state::set',sdkErrorCode:'TIMEOUT'});
});
it('does not retain arbitrary function names or unknown protocol codes',()=>{
 expect(safeFailureDetails({function_id:'private-user-function',code:'SECRET_VALUE'})).toEqual({});
 expect(safeFailureDetails({function_id:'state::get',code:'SECRET_VALUE'})).toEqual({sdkFunction:'state::get'});
});
it('preserves existing bounded provider diagnostics',()=>{
 expect(safeFailureDetails({diagnostics:{category:'output_invalid',field:'title',itemCount:4,certificateRef:'a'.repeat(32)+':1'}})).toEqual({category:'output_invalid',field:'title',itemCount:4,certificateRef:'a'.repeat(32)+':1'});
});
