import { ClipboardCopy, Code2, Search, Tag, Terminal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/page-header';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { api } from '../lib/api';
import type { DevDoc } from '../lib/types';
import { cn } from '../lib/utils';
import { useHub } from '../contexts/hub-context';

// navigator.clipboard.writeText exige contexto seguro (HTTPS ou localhost) —
// em HTTP puro (ex: http://hubcontroller.com.br sem "s") ela falha
// silenciosamente, sem erro nenhum visível. Isso cai pro método antigo
// (execCommand), que funciona em qualquer contexto.
async function copyToClipboard(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // segue pro fallback abaixo
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function DevDocsPage() {
  const { notify } = useHub();
  const [docs, setDocs] = useState<DevDoc[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api<DevDoc[]>('/dev-docs').then((data) => {
      setDocs(data);
      if (data.length > 0) setSelectedId(data[0].id);
    }).catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    if (!query.trim()) return docs;
    const q = query.toLowerCase();
    return docs.filter(
      (d) =>
        d.title.toLowerCase().includes(q) ||
        d.category.toLowerCase().includes(q) ||
        d.summary.toLowerCase().includes(q) ||
        d.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [docs, query]);

  const byCategory = useMemo(() => {
    const map = new Map<string, DevDoc[]>();
    for (const doc of filtered) {
      const list = map.get(doc.category) ?? [];
      list.push(doc);
      map.set(doc.category, list);
    }
    return map;
  }, [filtered]);

  const selected = docs.find((d) => d.id === selectedId) ?? null;

  function copyAsPrompt(doc: DevDoc) {
    const lines: string[] = [
      `## ${doc.title}`,
      `**Categoria:** ${doc.category}`,
      `**Resumo:** ${doc.summary}`,
      '',
      '**Como usar:**',
      doc.howToUse,
    ];
    if (doc.codeExample) {
      lines.push('', `**Exemplo de código${doc.language ? ` (${doc.language})` : ''}:**`);
      lines.push('```' + (doc.language ?? ''));
      lines.push(doc.codeExample);
      lines.push('```');
    }
    if (doc.endpoint) lines.push('', `**Endpoint:** \`${doc.endpoint}\``);
    if (doc.tags.length > 0) lines.push('', `**Tags:** ${doc.tags.join(', ')}`);
    void copyToClipboard(lines.join('\n')).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        notify('Não foi possível copiar — copie o texto manualmente selecionando-o.');
      }
    });
  }

  function copyAll() {
    const sections = docs.map((doc) => {
      const lines: string[] = [
        `## ${doc.title}`,
        `**Categoria:** ${doc.category}`,
        `**Resumo:** ${doc.summary}`,
        '',
        '**Como usar:**',
        doc.howToUse,
      ];
      if (doc.codeExample) {
        lines.push('', `**Exemplo${doc.language ? ` (${doc.language})` : ''}:**`);
        lines.push('```' + (doc.language ?? ''));
        lines.push(doc.codeExample);
        lines.push('```');
      }
      if (doc.endpoint) lines.push('', `**Endpoint:** \`${doc.endpoint}\``);
      return lines.join('\n');
    });
    const full = `# Documentação Técnica — Automation Hub\n\n${sections.join('\n\n---\n\n')}`;
    void copyToClipboard(full).then((ok) => {
      notify(ok ? 'Toda a documentação copiada como prompt!' : 'Não foi possível copiar — copie o texto manualmente selecionando-o.');
    });
  }

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title={<>Dev <span className="text-sky-600 dark:text-sky-400">Docs</span></>}
        description="Documentação técnica de integrações e funcionalidades do hub."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={copyAll} disabled={docs.length === 0}>
              <ClipboardCopy className="mr-2 h-4 w-4" />
              Copiar tudo como prompt
            </Button>
            <Button variant="ghost" asChild>
              <Link to="/settings?tab=docs">Gerenciar</Link>
            </Button>
          </div>
        }
      />

      {docs.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-slate-200 py-24 text-center dark:border-[#27272a]">
          <Code2 className="mb-3 h-10 w-10 text-slate-300 dark:text-zinc-600" />
          <p className="text-sm font-medium text-slate-500">Nenhuma feature documentada ainda.</p>
          <p className="mt-1 text-xs text-slate-400">
            Vá em{' '}
            <Link to="/settings?tab=docs" className="text-sky-500 hover:underline">
              Configurações → Dev Docs
            </Link>{' '}
            para adicionar a primeira.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[260px_1fr] lg:items-start">
          {/* Sidebar */}
          <div className="flex flex-col gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                className="h-9 pl-9"
                placeholder="Buscar feature..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <nav className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-[#27272a] dark:bg-[#111113]">
              {byCategory.size === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-slate-400">Nenhum resultado.</p>
              ) : (
                Array.from(byCategory.entries()).map(([category, items], gi) => (
                  <div key={category}>
                    {gi > 0 && <div className="mx-3 border-t border-slate-100 dark:border-white/[0.05]" />}
                    <div className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-widest text-slate-400 dark:text-zinc-500">
                      {category}
                    </div>
                    {items.map((doc) => (
                      <button
                        key={doc.id}
                        type="button"
                        onClick={() => setSelectedId(doc.id)}
                        className={cn(
                          'flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition',
                          selectedId === doc.id
                            ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/30 dark:text-sky-300'
                            : 'text-slate-700 hover:bg-slate-50 dark:text-zinc-300 dark:hover:bg-white/[0.03]',
                        )}
                      >
                        <Code2 className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', selectedId === doc.id ? 'text-sky-500' : 'text-slate-400 dark:text-zinc-500')} />
                        <span className="text-sm font-medium leading-tight">{doc.title}</span>
                      </button>
                    ))}
                  </div>
                ))
              )}
            </nav>
          </div>

          {/* Detalhe */}
          {selected ? (
            <article className="overflow-hidden rounded-3xl border border-slate-200 bg-white dark:border-[#27272a] dark:bg-[#111113]">
              {/* Header do doc */}
              <div className="border-b border-slate-100 px-8 py-6 dark:border-white/[0.06]">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <Badge variant="muted" className="text-xs font-medium">
                    {selected.category}
                  </Badge>
                  {selected.language && (
                    <span className="flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600 dark:bg-white/[0.06] dark:text-zinc-300">
                      <Terminal className="h-3 w-3" />
                      {selected.language}
                    </span>
                  )}
                  {selected.endpoint && (
                    <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-mono font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400">
                      {selected.endpoint}
                    </span>
                  )}
                </div>

                <h1 className="text-xl font-semibold text-slate-900 dark:text-white">{selected.title}</h1>

                <div className="mt-4 flex items-center justify-between gap-4">
                  <p className="text-sm text-slate-500 dark:text-zinc-400">{selected.summary}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => copyAsPrompt(selected)}
                  >
                    <ClipboardCopy className="mr-1.5 h-3.5 w-3.5" />
                    {copied ? 'Copiado!' : 'Copiar como prompt'}
                  </Button>
                </div>
              </div>

              {/* Corpo */}
              <div className="space-y-6 px-8 py-6">
                {/* Como usar */}
                <section>
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-zinc-500">
                    Como usar
                  </h2>
                  <div className="rounded-2xl bg-slate-50 px-5 py-4 dark:bg-white/[0.03]">
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700 dark:text-zinc-300">
                      {selected.howToUse}
                    </p>
                  </div>
                </section>

                {/* Exemplo de código */}
                {selected.codeExample && (
                  <section>
                    <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-zinc-500">
                      Exemplo de código
                    </h2>
                    <div className="overflow-hidden rounded-2xl bg-slate-950 dark:bg-[#0d0d0f]">
                      {selected.language && (
                        <div className="flex items-center gap-2 border-b border-white/[0.08] px-4 py-2.5">
                          <span className="text-xs font-medium text-slate-400">{selected.language}</span>
                          <button
                            type="button"
                            onClick={() =>
                              void copyToClipboard(selected.codeExample ?? '').then((ok) => {
                                if (!ok) notify('Não foi possível copiar — copie o texto manualmente selecionando-o.');
                              })
                            }
                            className="ml-auto text-xs text-slate-500 transition hover:text-slate-300"
                          >
                            copiar
                          </button>
                        </div>
                      )}
                      <pre className="overflow-x-auto px-5 py-4 text-sm leading-relaxed text-slate-100">
                        <code>{selected.codeExample}</code>
                      </pre>
                    </div>
                  </section>
                )}

                {/* Tags */}
                {selected.tags.length > 0 && (
                  <section>
                    <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-zinc-500">
                      Tags
                    </h2>
                    <div className="flex flex-wrap gap-2">
                      {selected.tags.map((tag) => (
                        <span
                          key={tag}
                          className="flex items-center gap-1 rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 dark:border-white/[0.08] dark:text-zinc-400"
                        >
                          <Tag className="h-3 w-3" />
                          {tag}
                        </span>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            </article>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-slate-200 py-24 text-center dark:border-[#27272a]">
              <Code2 className="mb-3 h-8 w-8 text-slate-300 dark:text-zinc-600" />
              <p className="text-sm text-slate-400">Selecione uma feature ao lado</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
