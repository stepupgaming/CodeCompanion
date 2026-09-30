import type { EventChannel, EventMap, InvokeApi, InvokeChannel } from '../shared/ipc';

export interface PreloadApi {
  invoke<K extends InvokeChannel>(
    channel: K,
    ...args: Parameters<InvokeApi[K]>
  ): Promise<Awaited<ReturnType<InvokeApi[K]>>>;
  on<K extends EventChannel>(channel: K, listener: (payload: EventMap[K]) => void): () => void;
}

declare global {
  interface Window {
    api: PreloadApi;
  }
}
