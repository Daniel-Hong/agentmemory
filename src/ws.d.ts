declare module "ws" {
 import { EventEmitter } from "node:events";
 import type { IncomingMessage } from "node:http";
 import type { Duplex } from "node:stream";
 export default class WebSocket extends EventEmitter {
  static readonly OPEN:number;
  readonly readyState:number;
  readonly bufferedAmount:number;
  send(data:string,callback?:(error?:Error)=>void):void;
  close(code?:number,reason?:string):void;
  terminate():void;
  ping():void;
 }
 export class WebSocketServer extends EventEmitter {
  constructor(options:{noServer:boolean;maxPayload:number});
  clients:Set<WebSocket>;
  handleUpgrade(req:IncomingMessage,socket:Duplex,head:Buffer,callback:(client:WebSocket)=>void):void;
  close():void;
 }
}
