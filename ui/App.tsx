import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Boxes,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Github,
  Loader2,
  Network,
  RefreshCw,
  Search,
  TableProperties,
} from 'lucide-react';
import {
  bundleGithubUrl,
  fetchVerifiedBundleList,
  type VerifiedBundle,
} from './lib/bundles';
import { fetchOkfBundleFromUrl } from './lib/github';
import {
  findExistingTitleConflicts,
  importModel,
  listStorages,
  prepareGraphForImport,
  type ImportProgress,
  type ImportResult,
  type StorageRef,
} from './lib/import-model';
import { parseBundle } from './lib/okf';
import type { ModelGraph } from './lib/okf-types';
import { getPluginContext } from './lib/plugin-runtime';

type Screen = 'catalog' | 'preview' | 'importing' | 'complete';

const buttonPrimary =
  'inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50';
const buttonOutline =
  'inline-flex items-center justify-center gap-2 rounded-md border bg-card px-4 py-2 text-sm font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50';

export function App() {
  const [screen, setScreen] = useState<Screen>('catalog');
  const [bundles, setBundles] = useState<VerifiedBundle[]>([]);
  const [storages, setStorages] = useState<StorageRef[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [search, setSearch] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [selectedName, setSelectedName] = useState('');
  const [selectedUrl, setSelectedUrl] = useState('');
  const [graph, setGraph] = useState<ModelGraph | null>(null);
  const [bundleLoading, setBundleLoading] = useState(false);
  const [bundleError, setBundleError] = useState('');
  const [storageId, setStorageId] = useState('');
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [conflictsLoading, setConflictsLoading] = useState(false);
  const [conflictsError, setConflictsError] = useState('');
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    let alive = true;
    const catalogRequest = fetchVerifiedBundleList()
      .then(catalog => {
        if (alive) setBundles(catalog);
      })
      .catch(error => {
        if (alive) setCatalogError(`Could not load verified catalog: ${errorMessage(error)}`);
      });

    const storagesRequest = getPluginContext()
      .then(listStorages)
      .then(availableStorages => {
        if (!alive) return;
        setStorages(availableStorages);
        if (availableStorages.length === 1) setStorageId(availableStorages[0].id);
      })
      .catch(error => {
        if (alive) setStorageError(`Could not load ODM Storages: ${errorMessage(error)}`);
      });

    void Promise.allSettled([catalogRequest, storagesRequest]).finally(() => {
      if (alive) setCatalogLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!graph || !storageId) {
      setConflicts([]);
      setConflictsError('');
      return;
    }
    let alive = true;
    setConflictsLoading(true);
    setConflictsError('');
    getPluginContext()
      .then(context => findExistingTitleConflicts(context, storageId, graph))
      .then(found => {
        if (alive) setConflicts(found);
      })
      .catch(error => {
        if (alive) setConflictsError(`Could not check existing Data Marts: ${errorMessage(error)}`);
      })
      .finally(() => {
        if (alive) setConflictsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [graph, storageId]);

  const filteredBundles = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return bundles;
    return bundles.filter(bundle => bundle.title.toLocaleLowerCase().includes(query));
  }, [bundles, search]);

  const selectedStorage = storages.find(storage => storage.id === storageId) ?? null;
  const totalFields = graph?.nodes.reduce((total, node) => total + node.schema.length, 0) ?? 0;
  const relationshipWrites = graph?.edges.reduce((total, edge) => total + (edge.bidirectional ? 2 : 1), 0) ?? 0;

  async function loadBundle(name: string, url: string) {
    setBundleLoading(true);
    setBundleError('');
    setSelectedName(name);
    setSelectedUrl(url);
    try {
      const files = await fetchOkfBundleFromUrl(url);
      const parsed = prepareGraphForImport(parseBundle(files));
      if (parsed.nodes.length === 0) {
        throw new Error('No Data Marts found. Select a concrete OKF bundle folder, not the top-level catalog.');
      }
      setGraph({
        ...parsed,
        nodes: parsed.nodes.map(node => ({ ...node, status: 'pending', owoxId: null })),
      });
      setScreen('preview');
    } catch (error) {
      setBundleError(errorMessage(error));
    } finally {
      setBundleLoading(false);
    }
  }

  async function runImport() {
    if (!graph || !selectedStorage || conflicts.length > 0 || conflictsError) return;
    setScreen('importing');
    setBundleError('');
    setResult(null);
    try {
      const context = await getPluginContext();
      const imported = await importModel(context, selectedStorage, graph, { onProgress: setProgress });
      setResult(imported);
      setScreen('complete');
    } catch (error) {
      setBundleError(errorMessage(error));
      setScreen('preview');
    }
  }

  async function openCanvas() {
    const context = await getPluginContext();
    context.ui.navigate(`/ui/${encodeURIComponent(context.projectId)}/data-marts/models`);
  }

  function backToCatalog() {
    setScreen('catalog');
    setGraph(null);
    setSelectedName('');
    setSelectedUrl('');
    setBundleError('');
    setConflicts([]);
    setConflictsError('');
    setProgress(null);
    setResult(null);
  }

  return (
    <div className='dm-page text-foreground'>
      <header className='dm-page-header border-b'>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <div>
            <h1 className='dm-page-header-title'>Import Model</h1>
            <p className='mt-1 text-sm text-muted-foreground'>
              Create draft Data Marts, schemas, and relationships from a public OKF model.
            </p>
          </div>
          <StepIndicator screen={screen} />
        </div>
      </header>

      <main className='dm-page-content py-6'>
        {bundleError && <Banner kind='error'>{bundleError}</Banner>}

        {screen === 'catalog' && (
          <section className='flex flex-col gap-5' data-testid='catalog-screen'>
            <div className='dm-card flex flex-col gap-3'>
              <div className='flex items-center gap-2'>
                <Github className='h-5 w-5 text-muted-foreground' />
                <div>
                  <h2 className='font-semibold'>Import from a public GitHub bundle</h2>
                  <p className='text-sm text-muted-foreground'>No GitHub credential is requested or stored.</p>
                </div>
              </div>
              <div className='flex flex-col gap-2 sm:flex-row'>
                <input
                  type='url'
                  className='h-10 min-w-0 flex-1 rounded-md border bg-card px-3 text-sm'
                  value={customUrl}
                  onChange={event => setCustomUrl(event.target.value)}
                  placeholder='https://github.com/OWOX/models/tree/main/bundles/e-commerce'
                  data-testid='custom-url'
                />
                <button
                  className={buttonOutline}
                  disabled={!customUrl.trim() || bundleLoading}
                  onClick={() => void loadBundle('Custom bundle', customUrl.trim())}
                >
                  {bundleLoading ? <Loader2 className='h-4 w-4 animate-spin' /> : <ArrowRight className='h-4 w-4' />}
                  Load URL
                </button>
              </div>
            </div>

            <div className='flex items-center justify-between gap-3'>
              <div>
                <h2 className='text-base font-semibold'>Verified models</h2>
                <p className='text-sm text-muted-foreground'>Live catalog from OWOX/models.</p>
              </div>
              <div className='relative w-64 max-w-full'>
                <Search className='absolute left-3 top-2.5 h-4 w-4 text-muted-foreground' />
                <input
                  className='h-9 w-full rounded-md border bg-card pl-9 pr-3 text-sm'
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  placeholder='Search models'
                />
              </div>
            </div>

            {catalogLoading ? (
              <LoadingLine text='Loading verified models and ODM storages…' />
            ) : catalogError ? (
              <Banner kind='error'>{catalogError}</Banner>
            ) : (
              <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
                {filteredBundles.map(bundle => (
                  <button
                    key={bundle.folder}
                    className='dm-card flex min-h-28 flex-col items-start gap-3 text-left transition-colors hover:bg-accent'
                    onClick={() => void loadBundle(bundle.title, bundleGithubUrl(bundle.folder))}
                    disabled={bundleLoading}
                    data-testid='bundle-card'
                  >
                    <div className='flex w-full items-start justify-between gap-3'>
                      <Boxes className='h-5 w-5 text-primary' />
                      <span className='rounded-full bg-card px-2 py-0.5 text-xs text-muted-foreground'>
                        {bundle.martCount ?? '—'} marts
                      </span>
                    </div>
                    <span className='font-semibold'>{bundle.title}</span>
                    <span className='inline-flex items-center gap-1 text-xs text-muted-foreground'>
                      OWOX/models <ArrowRight className='h-3 w-3' />
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {screen === 'preview' && graph && (
          <section className='flex flex-col gap-5' data-testid='preview-screen'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <button className={buttonOutline} onClick={backToCatalog}>
                <ArrowLeft className='h-4 w-4' /> Models
              </button>
              <button className={buttonOutline} onClick={() => void getPluginContext().then(context => context.ui.openExternal(selectedUrl))}>
                Source <ExternalLink className='h-4 w-4' />
              </button>
            </div>

            <div>
              <h2 className='text-xl font-semibold'>{selectedName}</h2>
              <p className='mt-1 text-sm text-muted-foreground'>Review what will be created in ODM.</p>
            </div>

            <div className='grid gap-3 sm:grid-cols-3'>
              <Stat icon={<TableProperties className='h-5 w-5' />} label='Data Marts' value={graph.nodes.length} />
              <Stat icon={<GitBranch className='h-5 w-5' />} label='Fields' value={totalFields} />
              <Stat icon={<Network className='h-5 w-5' />} label='Relationships' value={relationshipWrites} />
            </div>

            <div className='dm-card flex flex-col gap-3'>
              <label className='text-sm font-semibold' htmlFor='storage'>Target ODM Storage</label>
              {storages.length === 0 ? (
                <Banner kind='error'>No Storage is available. Create or request access to an ODM Storage first.</Banner>
              ) : (
                <select
                  id='storage'
                  className='h-10 w-full rounded-md border bg-card px-3 text-sm sm:max-w-md'
                  value={storageId}
                  onChange={event => setStorageId(event.target.value)}
                  data-testid='storage-select'
                >
                  <option value=''>Select a Storage</option>
                  {storages.map(storage => (
                    <option key={storage.id} value={storage.id}>{storage.title} · {storage.type}</option>
                  ))}
                </select>
              )}
              {conflictsLoading && <LoadingLine text='Checking existing Data Marts…' />}
              {conflicts.length > 0 && (
                <Banner kind='error'>
                  Import blocked to prevent duplicates. These titles already exist: {conflicts.join(', ')}.
                </Banner>
              )}
              {conflictsError && <Banner kind='error'>{conflictsError}</Banner>}
              <p className='text-xs text-muted-foreground'>
                Bundles contain conceptual schemas, not SQL definitions. Imported Data Marts remain drafts.
              </p>
              {storageError && <Banner kind='error'>{storageError}</Banner>}
            </div>

            <div className='dm-card overflow-hidden p-0'>
              <div className='border-b px-4 py-3 font-semibold'>Objects to create</div>
              <div className='max-h-80 overflow-auto'>
                <table className='w-full text-sm'>
                  <thead className='sticky top-0 bg-card text-left text-muted-foreground'>
                    <tr><th className='px-4 py-2 font-medium'>Data Mart</th><th className='px-4 py-2 font-medium'>Fields</th><th className='px-4 py-2 font-medium'>Primary key</th></tr>
                  </thead>
                  <tbody>
                    {graph.nodes.map(node => (
                      <tr key={node.key} className='border-t'>
                        <td className='px-4 py-2'><div className='font-medium'>{node.title}</div><div className='line-clamp-1 max-w-xl text-xs text-muted-foreground'>{node.description}</div></td>
                        <td className='px-4 py-2'>{node.schema.length}</td>
                        <td className='px-4 py-2'>{node.schema.filter(field => field.pk).map(field => field.name).join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className='flex justify-end'>
              <button
                className={buttonPrimary}
                disabled={!selectedStorage || conflictsLoading || conflicts.length > 0 || Boolean(conflictsError)}
                onClick={() => void runImport()}
                data-testid='import-button'
              >
                Import into ODM <ArrowRight className='h-4 w-4' />
              </button>
            </div>
          </section>
        )}

        {screen === 'importing' && graph && (
          <section className='mx-auto flex max-w-2xl flex-col gap-5 py-12 text-center' data-testid='importing-screen'>
            <Loader2 className='mx-auto h-10 w-10 animate-spin text-primary' />
            <div>
              <h2 className='text-xl font-semibold'>Creating the model in ODM</h2>
              <p className='mt-1 text-sm text-muted-foreground'>Keep this page open until all relationships are created.</p>
            </div>
            {progress && (
              <div className='dm-card text-left'>
                <div className='flex items-center justify-between gap-3 text-sm'>
                  <span className='truncate'>{progress.label}</span>
                  <span className='shrink-0 text-muted-foreground'>{progress.completed}/{progress.total}</span>
                </div>
                <div className='mt-3 h-2 overflow-hidden rounded-full bg-muted'>
                  <div className='h-full rounded-full bg-primary transition-all' style={{ width: `${progress.total ? (progress.completed / progress.total) * 100 : 0}%` }} />
                </div>
                <p className='mt-2 text-xs capitalize text-muted-foreground'>{progress.phase}</p>
              </div>
            )}
          </section>
        )}

        {screen === 'complete' && result && (
          <section className='mx-auto flex max-w-3xl flex-col gap-5 py-8' data-testid='complete-screen'>
            <div className='text-center'>
              {result.martsFailed === 0 && result.relationshipsFailed === 0 ? (
                <CheckCircle2 className='mx-auto h-12 w-12 text-green-600' />
              ) : (
                <AlertCircle className='mx-auto h-12 w-12 text-amber-600' />
              )}
              <h2 className='mt-3 text-xl font-semibold'>Import finished</h2>
              <p className='mt-1 text-sm text-muted-foreground'>The native ODM canvas reads these Data Marts and relationships directly.</p>
            </div>
            <div className='grid gap-3 sm:grid-cols-2'>
              <Stat icon={<TableProperties className='h-5 w-5' />} label='Data Marts created' value={result.martsCreated} />
              <Stat icon={<Network className='h-5 w-5' />} label='Relationships created' value={result.relationshipsCreated} />
            </div>
            {result.joinsNamed > 0 && (
              <p className='text-sm text-muted-foreground'>
                {result.joinsNamed} joins reached through another Data Mart were named and described, so the
                reporting column picker can tell them apart.
              </p>
            )}
            {result.relationshipsWithoutKeys > 0 && (
              <Banner kind='warning'>{result.relationshipsWithoutKeys} relationships were created as “Join not configured”.</Banner>
            )}
            {(result.martsFailed > 0 || result.schemasFailed > 0 || result.relationshipsFailed > 0) && (
              <Banner kind='warning'>
                Some objects need attention: {result.martsFailed} Data Marts, {result.schemasFailed} schemas, and {result.relationshipsFailed} relationships failed.
              </Banner>
            )}
            {result.errors.length > 0 && (
              <div className='dm-card'>
                <h3 className='font-semibold'>Import warnings</h3>
                <ul className='mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground'>
                  {result.errors.map((error, index) => <li key={`${index}:${error}`}>{error}</li>)}
                </ul>
              </div>
            )}
            <div className='flex flex-wrap justify-center gap-3'>
              <button className={buttonOutline} onClick={backToCatalog}><RefreshCw className='h-4 w-4' /> Import another</button>
              <button className={buttonPrimary} onClick={() => void openCanvas()} data-testid='open-canvas'>
                Open Model Canvas <ExternalLink className='h-4 w-4' />
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function StepIndicator({ screen }: { screen: Screen }) {
  const current = screen === 'catalog' ? 1 : screen === 'preview' ? 2 : 3;
  return (
    <ol className='flex items-center gap-2 text-xs text-muted-foreground'>
      {['Model', 'Review', 'Create'].map((label, index) => {
        const step = index + 1;
        return (
          <li key={label} className={`rounded-full px-3 py-1 ${current === step ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
            {step}. {label}
          </li>
        );
      })}
    </ol>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className='dm-card flex items-center gap-3'>
      <span className='text-primary'>{icon}</span>
      <div><div className='text-2xl font-semibold'>{value}</div><div className='text-xs text-muted-foreground'>{label}</div></div>
    </div>
  );
}

function Banner({ kind, children }: { kind: 'error' | 'warning'; children: React.ReactNode }) {
  const color = kind === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-800';
  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${color}`} role='alert'>
      <AlertCircle className='mt-0.5 h-4 w-4 shrink-0' /> <span>{children}</span>
    </div>
  );
}

function LoadingLine({ text }: { text: string }) {
  return <div className='flex items-center gap-2 py-4 text-sm text-muted-foreground'><Loader2 className='h-4 w-4 animate-spin' /> {text}</div>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
