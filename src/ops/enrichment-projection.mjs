import {createHash} from 'node:crypto';
export function graphProjection(row, chars) {
  const projection = {id:row.id,type:row.type,title:String(row.title ?? '').slice(0,100),
    narrative:String(row.narrative ?? '').slice(0,1000),
    concepts:(row.concepts ?? []).slice(0,8).map(x=>String(x).slice(0,100)),
    files:(row.files ?? []).slice(0,8).map(x=>String(x).slice(0,200))};
  while (JSON.stringify(projection).length > chars-2) {
    if (projection.narrative.length) projection.narrative = projection.narrative.slice(0,Math.max(0,projection.narrative.length-100));
    else if (projection.files.length) projection.files.pop();
    else if (projection.concepts.length) projection.concepts.pop();
    else throw Error('graph_metadata_exceeds_input_budget');
  }
  return projection;
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
