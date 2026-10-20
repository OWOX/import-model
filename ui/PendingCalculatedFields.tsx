import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Calculator, CheckCircle2, ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import {
  applyPendingFields,
  discardAllPending,
  dismissPendingFields,
  listPendingMarts,
  type PendingMart,
  type PendingState,
} from './lib/calculated-fields';
import { getPluginContext } from './lib/plugin-runtime';

const buttonSmall =
  'inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50';
const buttonSmallOutline =
  'inline-flex items-center justify-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50';
const linkButton = 'text-xs text-primary underline-offset-2 hover:underline disabled:opacity-50';
const quietLinkButton = 'text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50';

/**
 * Calculated fields an earlier import could not add yet, and the one click that adds them.
 *
 * The plugin hears nothing while it is closed, so this list is the follow-up, and it is read
 * days or weeks after the import: it says where the fields came from and why they wait before it
 * says anything else. Every time the plugin opens it asks ODM where each Data Mart stands; a
 * published one with connected columns gets an Add button, any other gets a way into the Data
 * Mart, where the missing step is taken. Nothing renders when nothing waits.
 */
export function PendingCalculatedFields() {
  const [marts, setMarts] = useState<PendingMart[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Array<{ title: string; count: number }>>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarded, setDiscarded] = useState(0);

  const refresh = useCallback(async () => {
    setLoadError('');
    try {
      const context = await getPluginContext();
      setMarts(await listPendingMarts(context));
    } catch (error) {
      setLoadError(`Could not check waiting calculated fields: ${errorMessage(error)}`);
      setMarts([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function add(targets: PendingMart[]) {
    setBusy(current => new Set([...current, ...targets.map(target => target.martId)]));
    const context = await getPluginContext();
    const done: Array<{ title: string; count: number }> = [];
    for (const target of targets) {
      try {
        const result = await applyPendingFields(context, target.martId, target.doc);
        if (result.added > 0) done.push({ title: target.doc.martTitle, count: result.added });
      } catch (error) {
        setLoadError(`“${target.doc.martTitle}”: ${errorMessage(error)}`);
      }
    }
    setAdded(current => [...current, ...done]);
    await refresh();
    setBusy(new Set());
  }

  async function dismiss(target: PendingMart) {
    setBusy(current => new Set([...current, target.martId]));
    try {
      await dismissPendingFields(await getPluginContext(), target.martId);
    } catch (error) {
      setLoadError(`“${target.doc.martTitle}”: ${errorMessage(error)}`);
    }
    await refresh();
    setBusy(new Set());
  }

  async function discardAll() {
    const all = marts ?? [];
    setBusy(new Set(all.map(mart => mart.martId)));
    const failed = await discardAllPending(await getPluginContext(), all.map(mart => mart.martId));
    if (failed.length) setLoadError(`Some could not be discarded: ${failed.join('; ')}`);
    setDiscarded(all.reduce((total, mart) => total + mart.doc.fields.length, 0));
    setConfirmDiscard(false);
    setAdded([]);
    await refresh();
    setBusy(new Set());
  }

  async function openMart(martId: string) {
    const context = await getPluginContext();
    context.ui.navigate(`/ui/${encodeURIComponent(context.projectId)}/data-marts/${encodeURIComponent(martId)}/data-setup`);
  }

  if (marts === null) return null;
  if (discarded > 0 && marts.length === 0) {
    return (
      <p className='flex items-center gap-1.5 text-xs text-muted-foreground' data-testid='pending-discarded'>
        <CheckCircle2 className='h-3.5 w-3.5' /> Discarded {discarded} waiting calculated fields.
      </p>
    );
  }
  if (marts.length === 0 && added.length === 0 && !loadError) return null;

  const ready = marts.filter(mart => mart.state.kind === 'ready');
  const readyCount = ready.reduce((total, mart) => total + mart.doc.fields.length, 0);
  const waitingCount = marts.reduce((total, mart) => total + mart.doc.fields.length, 0);
  const notReadyMarts = marts.length - ready.length;
  const summary = [
    ready.length > 0 && `${ready.length} ready to add`,
    notReadyMarts > 0 && `${notReadyMarts} waiting for publishing`,
  ].filter(Boolean).join(' · ');
  const groups = groupByModel(marts);
  const anyBusy = busy.size > 0;

  return (
    <div className='dm-card overflow-hidden p-0' data-testid='pending-calculated-fields'>
      <div className='flex flex-wrap items-center justify-between gap-2 px-4 py-3'>
        <button
          type='button'
          className='flex min-w-0 items-center gap-2 text-left'
          onClick={() => setCollapsed(current => !current)}
          aria-expanded={!collapsed}
          data-testid='pending-toggle'
        >
          {collapsed ? <ChevronRight className='h-4 w-4 shrink-0' /> : <ChevronDown className='h-4 w-4 shrink-0' />}
          <Calculator className='h-4 w-4 shrink-0 text-primary' />
          <span className='font-semibold'>Calculated fields waiting</span>
          {waitingCount > 0 && (
            <span className='truncate text-xs text-muted-foreground' data-testid='pending-summary'>
              {waitingCount} in {marts.length} Data Marts{summary && ` · ${summary}`}
            </span>
          )}
        </button>
        <div className='flex items-center gap-3'>
          <button className={linkButton} onClick={() => void refresh()} disabled={anyBusy} title='Check again' aria-label='Check again'>
            <RefreshCw className='inline h-3.5 w-3.5' />
          </button>
          {ready.length > 1 && (
            <button className={buttonSmall} onClick={() => void add(ready)} disabled={anyBusy} data-testid='add-all-ready'>
              Add all ready ({readyCount})
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className='border-t'>
          {marts.length > 0 && (
            <p className='px-4 py-3 text-xs text-muted-foreground' data-testid='pending-explainer'>
              You imported these Data Marts from a model whose files also define calculated fields. ODM adds a calculated
              field only to a <strong className='font-medium text-foreground'>published</strong> Data Mart, which needs a
              real input source, so they were saved here instead. Open each Data Mart, set its input source and publish it,
              then come back to add its fields.
            </p>
          )}

          {loadError && <p className='border-t px-4 py-2 text-xs text-red-700'>{loadError}</p>}

          {added.length > 0 && (
            <p className='flex items-start gap-1.5 border-t px-4 py-2 text-xs text-green-700' data-testid='pending-added'>
              <CheckCircle2 className='mt-0.5 h-3.5 w-3.5 shrink-0' />
              Added {added.map(entry => `${entry.count} to ${entry.title}`).join(', ')}.
            </p>
          )}

          {groups.map(group => (
            <div key={group.bundleName}>
              <div className='border-t bg-muted px-4 py-1.5 text-xs font-medium text-muted-foreground'>
                From the {group.bundleName} model{group.importedAt && ` · imported ${formatDate(group.importedAt)}`}
              </div>
              <ul className='divide-y border-t text-sm'>
                {group.marts.map(mart => {
                  const isBusy = busy.has(mart.martId);
                  const refused = mart.doc.fields.filter(field => field.lastError);
                  const names = mart.doc.fields.map(field => field.alias ?? field.name).join(', ');
                  return (
                    <li key={mart.martId} className='flex flex-col gap-1 px-4 py-2.5' data-testid={`pending-${mart.martId}`}>
                      <div className='flex flex-wrap items-center justify-between gap-3'>
                        <div className='min-w-0'>
                          <div className='flex flex-wrap items-center gap-2'>
                            <span className='font-medium'>{mart.doc.martTitle}</span>
                            <StatusBadge state={mart.state} />
                          </div>
                          <div className='truncate text-xs text-muted-foreground' title={names}>
                            {mart.doc.fields.length} calculated {mart.doc.fields.length === 1 ? 'field' : 'fields'} · {names}
                          </div>
                        </div>
                        <div className='flex shrink-0 items-center gap-3'>
                          {refused.length > 0 && (
                            <button className={quietLinkButton} onClick={() => void dismiss(mart)} disabled={isBusy}>
                              Dismiss
                            </button>
                          )}
                          {mart.state.kind === 'ready' ? (
                            <button className={buttonSmall} onClick={() => void add([mart])} disabled={isBusy} data-testid={`add-${mart.martId}`}>
                              {isBusy ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : null}
                              Add {mart.doc.fields.length} {mart.doc.fields.length === 1 ? 'field' : 'fields'}
                            </button>
                          ) : (
                            <button
                              className={buttonSmallOutline}
                              onClick={() => void openMart(mart.martId)}
                              data-testid={`open-${mart.martId}`}
                            >
                              Open Data Mart <ArrowRight className='h-3 w-3' />
                            </button>
                          )}
                        </div>
                      </div>
                      {mart.state.kind === 'needs-columns' && (
                        <p className='text-xs text-muted-foreground'>
                          Published, but these columns are not connected yet: {mart.state.missing.join(', ')}. Run
                          “Actualize schema” in the Data Mart, or check that its source has them.
                        </p>
                      )}
                      {mart.state.kind === 'error' && <p className='text-xs text-red-700'>{mart.state.message}</p>}
                      {refused.map(field => (
                        <p key={field.name} className='text-xs text-amber-800'>
                          <code className='rounded bg-muted px-1'>{field.name}</code>: {field.lastError}
                        </p>
                      ))}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          {marts.length > 0 && (
            <div className='flex flex-wrap items-center justify-end gap-3 border-t px-4 py-2.5'>
              {confirmDiscard ? (
                <>
                  <span className='min-w-0 flex-1 text-xs text-muted-foreground' data-testid='discard-confirm-text'>
                    Discard all {waitingCount} waiting calculated fields? The Data Marts stay as they are; only the saved
                    formulas are deleted, and this cannot be undone.
                  </span>
                  <div className='flex shrink-0 items-center gap-2'>
                    <button className={buttonSmallOutline} onClick={() => setConfirmDiscard(false)} disabled={anyBusy}>
                      Cancel
                    </button>
                    <button
                      className='inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50'
                      onClick={() => void discardAll()}
                      disabled={anyBusy}
                      data-testid='discard-all-confirm'
                    >
                      {anyBusy ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : null}
                      Discard all
                    </button>
                  </div>
                </>
              ) : (
                <button
                  className={quietLinkButton}
                  onClick={() => setConfirmDiscard(true)}
                  disabled={anyBusy}
                  data-testid='discard-all'
                >
                  Discard all waiting fields
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ state }: { state: PendingState }) {
  const [label, tone] =
    state.kind === 'ready'
      ? ['Ready to add', 'bg-green-50 text-green-700 border-green-200']
      : state.kind === 'needs-publish'
        ? ['Waiting for publishing', 'bg-amber-50 text-amber-800 border-amber-200']
        : state.kind === 'needs-columns'
          ? ['Columns not connected', 'bg-amber-50 text-amber-800 border-amber-200']
          : ['Could not check', 'bg-red-50 text-red-700 border-red-200'];
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}>{label}</span>;
}

/** Waiting Data Marts by the model they were imported from, earliest import date per model.
 *  Within a model the ones ready to add come first: they are what the member can act on now. */
function groupByModel(marts: PendingMart[]): Array<{ bundleName: string; importedAt?: string; marts: PendingMart[] }> {
  const groups = new Map<string, { bundleName: string; importedAt?: string; marts: PendingMart[] }>();
  for (const mart of marts) {
    const bundleName = mart.doc.bundleName || 'imported';
    const group = groups.get(bundleName) ?? { bundleName, marts: [] };
    group.marts.push(mart);
    if (mart.importedAt && (!group.importedAt || mart.importedAt < group.importedAt)) group.importedAt = mart.importedAt;
    groups.set(bundleName, group);
  }
  const rank = (mart: PendingMart) => (mart.state.kind === 'ready' ? 0 : 1);
  return [...groups.values()].map(group => ({ ...group, marts: [...group.marts].sort((a, b) => rank(a) - rank(b)) }));
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
