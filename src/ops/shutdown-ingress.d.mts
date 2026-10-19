import type { IIIClient } from 'iii-sdk';
import type { HttpRequest } from '@iii-dev/helpers/http';
export function createShutdownIngress(): {
 close(): void;
 isClosed(): boolean;
 snapshot(): { closed: boolean; activeOperations: number };
 track<T>(fn: () => Promise<T> | T): Promise<T>;
 drain(): Promise<void>;
 install(sdk: IIIClient, authenticate: (request: HttpRequest) => unknown): void;
};
