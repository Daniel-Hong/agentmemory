export function getCpuCapacityCores(options?: {platform?:string;parallelism?:()=>number;read?:(path:string)=>Promise<string>}):Promise<number|null>;
