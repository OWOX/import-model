import { connect, type PluginContext } from '@owox/plugin-sdk';

let contextPromise: Promise<PluginContext> | undefined;

export function initializePlugin(): Promise<PluginContext> {
  contextPromise ??= connect();
  return contextPromise;
}

export function getPluginContext(): Promise<PluginContext> {
  return initializePlugin();
}

export function resetPluginContextForTests(): void {
  contextPromise = undefined;
}
