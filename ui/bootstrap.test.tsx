import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap } from './bootstrap';
import type { PluginContext } from './sdk-mock';
import * as sdk from './sdk-mock';
import { resetPluginContextForTests } from './lib/plugin-runtime';

// The handshake is the one thing a test cannot let resolve on its own: the whole point of
// the connecting state is the window between announcing and being answered, and the mock
// SDK answers immediately. So connect() hands back a promise this test settles by hand.
const handshake = vi.hoisted(() => {
  let settle!: (context: unknown) => void;
  const promise = new Promise<unknown>(resolve => {
    settle = resolve;
  });
  return { promise, settle };
});

vi.mock('@owox/plugin-sdk', async () => {
  const actual = await vi.importActual<typeof import('./sdk-mock')>('@owox/plugin-sdk');
  return { ...actual, connect: () => handshake.promise };
});

describe('bootstrap', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sdk.__resetForTests();
    resetPluginContextForTests();
    document.body.innerHTML = '<div id="root"></div>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
  });

  it('shows a connecting state while the handshake is still pending', async () => {
    await act(async () => {
      void bootstrap();
    });

    expect(screen.getByTestId('connecting')).toBeInTheDocument();
  });

  it('replaces the connecting state with the app once the handshake resolves', async () => {
    let started!: Promise<void>;
    await act(async () => {
      started = bootstrap();
    });
    expect(screen.getByTestId('connecting')).toBeInTheDocument();

    const context = await realContext();
    await act(async () => {
      handshake.settle(context);
      await started;
    });

    await waitFor(() => expect(screen.getByTestId('catalog-screen')).toBeInTheDocument());
    expect(screen.queryByTestId('connecting')).not.toBeInTheDocument();
  });
});

async function realContext(): Promise<PluginContext> {
  const actual = await vi.importActual<typeof import('./sdk-mock')>('@owox/plugin-sdk');
  return actual.connect();
}
