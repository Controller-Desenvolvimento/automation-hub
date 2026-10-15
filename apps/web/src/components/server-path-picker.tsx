import { ArrowUp, File as FileIcon, Folder, FolderSearch, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { RobotSchemaField } from '../lib/types';
import { Button } from './ui/button';
import { Input } from './ui/input';

type Listing = {
  root: string;
  current: string;
  parent: string | null;
  entries: Array<{ name: string; kind: 'dir' | 'file'; path: string }>;
  truncated: boolean;
};

/**
 * Campo de caminho "tipo upload": em vez de enviar o arquivo, o usuário navega pelas
 * pastas que o SERVIDOR enxerga (ex.: X:) e o robô recebe só o caminho escolhido.
 * O input mantém `name`, então o envio do formulário lê o valor como qualquer campo de texto.
 */
export function ServerPathPicker({
  robotId,
  field,
  value: controlledValue,
  onChange,
}: {
  robotId: string;
  field: RobotSchemaField;
  value?: string;
  onChange?: (value: string) => void;
}) {
  const [inner, setInner] = useState(field.defaultValue ?? '');
  const value = controlledValue ?? inner;
  const setValue = (next: string) => {
    setInner(next);
    onChange?.(next);
  };
  const [open, setOpen] = useState(false);
  const isFile = field.pick === 'file';

  return (
    <>
      <div className="flex gap-2">
        <Input
          name={field.name}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={field.placeholder}
          required={field.required}
        />
        <Button type="button" variant="outline" className="shrink-0" onClick={() => setOpen(true)}>
          <FolderSearch className="mr-2 h-4 w-4" />
          Procurar
        </Button>
      </div>
      {open ? (
        <PickerModal
          robotId={robotId}
          field={field}
          startAt={value}
          onClose={() => setOpen(false)}
          onPick={(path) => {
            setValue(path);
            setOpen(false);
          }}
          isFile={isFile}
        />
      ) : null}
    </>
  );
}

function PickerModal({
  robotId,
  field,
  startAt,
  isFile,
  onClose,
  onPick,
}: {
  robotId: string;
  field: RobotSchemaField;
  startAt: string;
  isFile: boolean;
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [target, setTarget] = useState(startAt);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api<Listing>(`/robots/${robotId}/browse?field=${encodeURIComponent(field.name)}&path=${encodeURIComponent(target)}`)
      .then((data) => {
        if (!cancelled) setListing(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Caminho digitado que não abre: volta pra raiz do campo em vez de travar.
        if (target) {
          setTarget('');
        } else {
          setError(err instanceof Error ? err.message : 'Não foi possível listar as pastas.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [robotId, field.name, target]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={field.label}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-[#0f0f10]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="min-w-0">
            <div className="text-sm font-semibold">{field.label}</div>
            <div className="truncate text-xs text-slate-500 dark:text-zinc-400" title={listing?.current}>
              {listing?.current ?? '...'}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar" className="rounded-lg p-1 hover:bg-slate-100 dark:hover:bg-zinc-800">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {listing?.parent != null ? (
            <button
              type="button"
              onClick={() => setTarget(listing.parent ?? '')}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-zinc-800"
            >
              <ArrowUp className="h-4 w-4 text-slate-500" />
              Voltar (pasta acima)
            </button>
          ) : null}

          {loading ? (
            <div className="flex items-center gap-2 px-3 py-6 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Abrindo pasta...
            </div>
          ) : null}

          {error ? <div className="px-3 py-4 text-sm text-red-600">{error}</div> : null}

          {!loading && !error && listing && listing.entries.length === 0 ? (
            <div className="px-3 py-6 text-sm text-slate-500">
              {isFile ? 'Nenhuma subpasta ou arquivo compatível aqui.' : 'Nenhuma subpasta aqui.'}
            </div>
          ) : null}

          {!loading
            ? listing?.entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => (entry.kind === 'dir' ? setTarget(entry.path) : onPick(entry.path))}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-zinc-800"
                >
                  {entry.kind === 'dir' ? (
                    <Folder className="h-4 w-4 shrink-0 text-sky-500" />
                  ) : (
                    <FileIcon className="h-4 w-4 shrink-0 text-slate-500" />
                  )}
                  <span className="min-w-0 break-words">{entry.name}</span>
                </button>
              ))
            : null}

          {listing?.truncated ? (
            <div className="px-3 py-2 text-xs text-slate-500">Lista limitada aos primeiros itens desta pasta.</div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-5 py-4 dark:border-slate-800">
          <span className="text-xs text-slate-500 dark:text-zinc-400">
            {isFile ? 'Clique no arquivo para escolher.' : 'Entre na pasta desejada e confirme.'}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            {!isFile ? (
              <Button type="button" disabled={!listing || loading} onClick={() => listing && onPick(listing.current)}>
                Selecionar esta pasta
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
