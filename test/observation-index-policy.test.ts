import {it,expect} from 'vitest';
import {indexRecords,getSearchIndex,setVectorIndex,setEmbeddingProvider} from '../src/functions/search.js';
import {SearchIndex} from '../src/state/search-index.js';
it('characterizes real rebuild exclusion and live empty publication with whitespace truthiness',async()=>{setVectorIndex(null);setEmbeddingProvider(null);const idx=getSearchIndex();idx.clear();const rows=['','normal',' '].map((narrative,i)=>({id:'policy'+i,sessionId:'policy',title:'Title',narrative,facts:[],concepts:[],files:[]} as any));expect(await indexRecords(rows,[])).toBe(2);expect(rows.map(r=>idx.has(r.id))).toEqual([false,true,true]);const live=new SearchIndex();live.add(rows[0]);expect(live.has(rows[0].id)).toBe(true);idx.clear()});
