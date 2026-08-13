const storages = [
  { id: 'storage-bigquery', title: 'BigQuery Demo', type: 'GOOGLE_BIGQUERY' },
  { id: 'storage-snowflake', title: 'Snowflake Demo', type: 'SNOWFLAKE' },
];

const requests: Array<{ method: string; path: string; body?: unknown }> = [];
const navigations: string[] = [];
let nextId = 1;

const owox = {
  storages: {
    async list() {
      return storages;
    },
  },
  models: {
    async getDataMarts(_storageId: string, _offset = 0) {
      return { items: [], total: 0, nextOffset: null };
    },
  },
  async postJson<T>(path: string, body: unknown): Promise<T> {
    requests.push({ method: 'POST', path, body });
    return { id: `mock-${nextId++}` } as T;
  },
  async putJson<T>(path: string, body: unknown): Promise<T> {
    requests.push({ method: 'PUT', path, body });
    return {} as T;
  },
  async getJson<T>(_path: string): Promise<T> {
    return {} as T;
  },
};

export type PluginContext = {
  pluginId: string;
  installationId: string;
  projectId: string;
  userId: string;
  theme: 'light' | 'dark';
  owox: typeof owox;
  ui: {
    openExternal(url: string): Promise<void>;
    navigate(path: string): void;
  };
  signal: AbortSignal;
};

let context: PluginContext | undefined;

export async function connect(): Promise<PluginContext> {
  context ??= {
    pluginId: 'import-model-dev',
    installationId: 'local',
    projectId: 'demo-project',
    userId: 'demo-user',
    theme: 'light',
    owox,
    ui: {
      async openExternal(url) {
        console.info('[import-model mock] openExternal', url);
      },
      navigate(path) {
        navigations.push(path);
        console.info('[import-model mock] navigate', path);
      },
    },
    signal: new AbortController().signal,
  };
  return context;
}

export function __resetForTests(): void {
  context = undefined;
  requests.length = 0;
  navigations.length = 0;
  nextId = 1;
}

export const __mock = { requests, navigations, owox, storages };
