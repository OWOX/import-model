import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initializePlugin } from './lib/plugin-runtime';
import './styles.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className='p-8 text-sm text-destructive'>
        <h1 className='mb-2 text-base font-semibold'>Import Model stopped unexpectedly</h1>
        <p>{this.state.error.message}</p>
      </main>
    );
  }
}

async function bootstrap() {
  const root = createRoot(document.getElementById('root')!);
  try {
    const context = await initializePlugin();
    document.documentElement.classList.toggle('dark', context.theme === 'dark');
    root.render(<ErrorBoundary><App /></ErrorBoundary>);
  } catch (error) {
    root.render(
      <main className='p-8 text-sm text-destructive'>
        Could not connect to OWOX: {error instanceof Error ? error.message : String(error)}
      </main>,
    );
  }
}

void bootstrap();
