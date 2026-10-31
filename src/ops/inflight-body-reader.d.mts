export function createInflightBodyReader(): <T>(options:{key:string;fileBytes:number;signal?:AbortSignal;load:(signal?:AbortSignal)=>Promise<Map<string,T>>})=>Promise<Map<string,T>>;
