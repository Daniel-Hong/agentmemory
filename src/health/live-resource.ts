import {getHeapStatistics} from 'node:v8';

export function liveResourceSample() {
  try {
    const startedAtMs=Date.now(),uptimeStartSeconds=process.uptime();
    const memory=process.memoryUsage();
    const heapLimit=getHeapStatistics().heap_size_limit;
    const uptimeEndSeconds=process.uptime(),finishedAtMs=Date.now();
    if(!Number.isFinite(startedAtMs)||!Number.isFinite(finishedAtMs)||finishedAtMs<startedAtMs||
      !Number.isFinite(uptimeStartSeconds)||uptimeStartSeconds<0||!Number.isFinite(uptimeEndSeconds)||uptimeEndSeconds<uptimeStartSeconds||
      !Number.isFinite(heapLimit)||heapLimit<=0||Object.values(memory).some(v=>!Number.isFinite(v)||v<0))return null;
    return {version:1,pid:process.pid,startedAtMs,finishedAtMs,uptimeStartSeconds,uptimeEndSeconds,memory:{...memory,heapLimit}};
  } catch {return null;}
}
