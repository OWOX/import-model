// Local stand-in for @owox/plugin-sdk: aliased over it in `vite dev` and in tests, and the type
// source for `npm run typecheck`. It keeps just enough of ODM's behaviour to walk the whole flow
// without a host — including the one rule the calculated-fields flow exists for: a column saved
// through the API stays DISCONNECTED, and a formula reading a DISCONNECTED column is refused.

const storages = [
  { id: 'storage-bigquery', title: 'BigQuery Demo', type: 'GOOGLE_BIGQUERY' },
  { id: 'storage-snowflake', title: 'Snowflake Demo', type: 'SNOWFLAKE' },
];

type MockField = { name: string; status?: string; calculated?: { formula: string }; [key: string]: unknown };
type MockMart = {
  id: string;
  title: string;
  status: 'DRAFT' | 'PUBLISHED';
  storage: { id: string; type: string };
  definitionType: string | null;
  description?: string;
  schema?: { type: string; fields: MockField[] };
};

const requests: Array<{ method: string; path: string; body?: unknown }> = [];
const navigations: string[] = [];
const marts = new Map<string, MockMart>();
type MockDocument = { id: string; parentId?: string; document: unknown; createdAt: string; updatedAt: string };
const documents = new Map<string, Map<string, MockDocument>>();
let nextId = 1;

/** Shaped like the SDK's PluginTransportError, so callers read `payload.details` the same way. */
class MockTransportError extends Error {
  constructor(readonly payload: { code: string; status?: number; message: string; details?: unknown }) {
    super(payload.message);
  }
}

const martPath = /^\/api\/data-marts\/([^/]+)(?:\/([a-z-]+))?$/;

const owox = {
  storages: {
    async list() {
      return storages;
    },
  },
  models: {
    async getDataMarts(_storageId: string, _offset = 0) {
      return { items: [] as Array<{ title: string }>, total: 0, nextOffset: null as number | null };
    },
  },
  async postJson<T>(path: string, body: unknown): Promise<T> {
    requests.push({ method: 'POST', path, body });
    const id = `mock-${nextId++}`;
    if (path === '/api/data-marts') {
      const { title, storageId } = body as { title: string; storageId: string };
      const storage = storages.find(entry => entry.id === storageId) ?? storages[0];
      marts.set(id, { id, title, status: 'DRAFT', storage: { id: storage.id, type: storage.type }, definitionType: null });
    }
    return { id } as T;
  },
  async putJson<T>(path: string, body: unknown): Promise<T> {
    requests.push({ method: 'PUT', path, body });
    const match = martPath.exec(path);
    const mart = match ? marts.get(decodeURIComponent(match[1])) : undefined;
    if (mart && match?.[2] === 'description') mart.description = (body as { description: string }).description;
    if (mart && match?.[2] === 'schema') saveSchema(mart, (body as { schema: MockMart['schema'] }).schema!);
    return {} as T;
  },
  async getJson<T>(path: string, _query?: Record<string, string>): Promise<T> {
    const match = martPath.exec(path);
    const mart = match && !match[2] ? marts.get(decodeURIComponent(match[1])) : undefined;
    if (mart) return structuredClone(mart) as T;
    return {} as T;
  },
  async deleteJson<T>(_path: string): Promise<T> {
    return {} as T;
  },
};

/** ODM's save rules, reduced: status is server-owned, and a formula may read only CONNECTED columns. */
function saveSchema(mart: MockMart, schema: NonNullable<MockMart['schema']>) {
  const previous = new Map((mart.schema?.fields ?? []).map(field => [field.name, field]));
  const fields = schema.fields.map(field => ({
    ...field,
    status: field.calculated ? 'CONNECTED' : (previous.get(field.name)?.status ?? 'DISCONNECTED'),
  }));
  const connected = new Set(fields.filter(field => field.status === 'CONNECTED').map(field => field.name));
  const errors = fields.flatMap(field =>
    [...(field.calculated?.formula ?? '').matchAll(/\{\{ref field="([^"]+)"\}\}/g)]
      .filter(ref => !connected.has(ref[1]))
      .map(ref => ({ code: 'FORMULA_UNKNOWN_REFERENCE', field: field.name, message: `\`${ref[1]}\` no longer exists in the Data Mart.` })),
  );
  if (errors.length) {
    throw new MockTransportError({ code: 'HTTP_ERROR', status: 400, message: 'Calculated field validation failed', details: { errors } });
  }
  mart.schema = { ...schema, fields };
}

function collections<T>(name: string) {
  const store = documents.get(name) ?? new Map<string, MockDocument>();
  documents.set(name, store);
  return {
    async list(_options: { limit?: number; cursor?: string } = {}) {
      return {
        items: [...store.values()].map(entry => ({ ...entry, document: entry.document as T })),
        nextCursor: null as string | null,
      };
    },
    async get(id: string) {
      const entry = store.get(id);
      return entry ? { ...entry, document: entry.document as T } : null;
    },
    async put(id: string, document: T, options: { parentId?: string } = {}) {
      requests.push({ method: 'PUT', path: `collections/${name}/${id}`, body: document });
      const now = new Date().toISOString();
      const entry: MockDocument = {
        id,
        ...(options.parentId ? { parentId: options.parentId } : {}),
        document,
        createdAt: store.get(id)?.createdAt ?? now,
        updatedAt: now,
      };
      store.set(id, entry);
      return { ...entry, document };
    },
    async delete(id: string) {
      requests.push({ method: 'DELETE', path: `collections/${name}/${id}` });
      store.delete(id);
    },
  };
}

/**
 * What a member does in ODM between the import and coming back: give a Data Mart an input source
 * and publish it, after which ODM has read the warehouse and connected its columns. `ids`
 * defaults to every mart.
 */
function connectMarts(ids?: string[]) {
  for (const mart of marts.values()) {
    if (ids && !ids.includes(mart.id)) continue;
    mart.definitionType = 'TABLE';
    mart.status = 'PUBLISHED';
    for (const field of mart.schema?.fields ?? []) field.status = 'CONNECTED';
  }
}

export type PluginContext = {
  pluginId: string;
  installationId: string;
  projectId: string;
  userId: string;
  theme: 'light' | 'dark';
  owox: typeof owox;
  collections: typeof collections;
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
    collections,
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
  marts.clear();
  documents.clear();
  nextId = 1;
}

export const __mock = { requests, navigations, owox, storages, marts, documents, connectMarts };

// In `vite dev`, the browser console stands in for the ODM screens the mock cannot show:
// `__importModelMock.connectMarts()` gives every imported Data Mart an input source and publishes it.
if (typeof window !== 'undefined') (window as unknown as { __importModelMock: typeof __mock }).__importModelMock = __mock;
