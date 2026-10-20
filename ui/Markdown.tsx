import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getPluginContext } from './lib/plugin-runtime';

/**
 * Markdown a bundle wrote, rendered for a person to read.
 *
 * The text comes from any public repository a member pastes, so nothing in it is trusted:
 * react-markdown builds React elements and never passes raw HTML through, so a `<script>` or an
 * `onerror` in a description stays inert text. Images are dropped — the model diagram has its own
 * place on the screen, and a relative image could not load from the opaque origin anyway.
 *
 * Links open in a new tab through the host, because the sandbox denies popups. A bundle links its
 * own files relatively (`./purchases.md?field=line_net_revenue`); those resolve against the bundle
 * folder on github.com, where the file reads rendered. Anything that does not end up https stays
 * plain text.
 */
export function Markdown({ text, linkBase }: { text: string; linkBase?: string }) {
  const components: Components = {
    p: ({ children }) => <p className='my-2 first:mt-0 last:mb-0'>{children}</p>,
    ul: ({ children }) => <ul className='my-2 list-disc space-y-1 pl-5'>{children}</ul>,
    ol: ({ children }) => <ol className='my-2 list-decimal space-y-1 pl-5'>{children}</ol>,
    strong: ({ children }) => <strong className='font-semibold text-foreground'>{children}</strong>,
    h1: ({ children }) => <h3 className='mb-1 mt-3 font-semibold text-foreground first:mt-0'>{children}</h3>,
    h2: ({ children }) => <h3 className='mb-1 mt-3 font-semibold text-foreground first:mt-0'>{children}</h3>,
    h3: ({ children }) => <h4 className='mb-1 mt-3 font-semibold text-foreground first:mt-0'>{children}</h4>,
    h4: ({ children }) => <h4 className='mb-1 mt-3 font-semibold text-foreground first:mt-0'>{children}</h4>,
    blockquote: ({ children }) => <blockquote className='my-2 border-l-2 pl-3 italic'>{children}</blockquote>,
    code: ({ children }) => <code className='rounded bg-muted px-1 py-0.5 text-[0.85em]'>{children}</code>,
    pre: ({ children }) => <pre className='my-2 overflow-auto rounded bg-muted p-2 text-xs'>{children}</pre>,
    table: ({ children }) => (
      <div className='my-2 overflow-auto'>
        <table className='w-full text-left text-xs'>{children}</table>
      </div>
    ),
    th: ({ children }) => <th className='border-b px-2 py-1 font-medium text-foreground'>{children}</th>,
    td: ({ children }) => <td className='border-b px-2 py-1'>{children}</td>,
    hr: () => <hr className='my-3' />,
    img: () => null,
    a: ({ href, children }) => {
      const url = resolveLink(href, linkBase);
      if (!url) return <>{children}</>;
      return (
        <a
          href={url}
          className='text-primary underline-offset-2 hover:underline'
          onClick={event => {
            event.preventDefault();
            void getPluginContext().then(context => context.ui.openExternal(url));
          }}
        >
          {children}
        </a>
      );
    },
  };

  return (
    <div className='text-sm text-muted-foreground'>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** An https URL for a link, or undefined when it cannot become one. The `?field=` a bundle adds
 *  to point at a column means nothing to GitHub, so the query is dropped. */
export function resolveLink(href: string | undefined, base: string | undefined): string | undefined {
  if (!href || href.startsWith('#')) return undefined;
  let url: URL;
  try {
    url = base ? new URL(href, base) : new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (!/^https?:/i.test(href)) url.search = '';
  return url.href;
}
