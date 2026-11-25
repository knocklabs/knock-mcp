import { AsyncLocalStorage } from "node:async_hooks";

type WaitUntil = (promise: Promise<unknown>) => void;

const requestWaitUntil = new AsyncLocalStorage<WaitUntil>();

/** Runs a request's work so that `keepAlive` can outlast its client. */
export function withKeepAlive<T>(waitUntil: WaitUntil, work: () => T): T {
  return requestWaitUntil.run(waitUntil, work);
}

/**
 * Lets `promise` finish when the client disconnects. Otherwise the runtime
 * cancels whatever the request was doing. Outside a request it does nothing.
 */
export function keepAlive<T>(promise: Promise<T>): Promise<T> {
  // A rejection is the caller's to handle, not waitUntil's.
  requestWaitUntil.getStore()?.(promise.catch(() => undefined));
  return promise;
}
