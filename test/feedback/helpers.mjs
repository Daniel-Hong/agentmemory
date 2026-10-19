import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {createFeedbackStore} from '../../src/feedback/feedback-store.mjs';
export const input=(content='문제')=>({requestId:randomUUID(),kind:'bug',content});
export function setup(t,options={}){const root=mkdtempSync(join(tmpdir(),'am-feedback-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,store:createFeedbackStore({root,...options})};}
export const result=ids=>({reports:ids.map(id=>({id,summary:'요약',evidence:['재현 미확인'],unknowns:['원인 미확인'],duplicates:[],upstream:{status:'unverified',evidence:[]},fix:'최소 수정안',impact:['화면'],tests:['회귀'],maintenance:'독립 모듈',priority:'normal'}))});
