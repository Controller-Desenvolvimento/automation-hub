import { FileText, FileX, Paperclip, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ClipboardEvent, type DragEvent } from 'react';
import { API_BASE_URL, downloadWithFeedback, getStoredToken } from '../lib/api';
import {
  ACCEPT_ATTACHMENTS,
  MAX_ATTACHMENTS,
  attachmentProblem,
  formatSize,
  isImageName,
  type Attachment,
} from '../lib/support';
import { cn } from '../lib/utils';

/** Anexos de uma mensagem em preparo: escolher, arrastar ou colar (Ctrl+V) um print. Confere tipo/tamanho antes de enviar. */
export function useAttachments(notify: (message: string) => void) {
  const [files, setFiles] = useState<File[]>([]);

  const add = useCallback(
    (incoming: File[]) => {
      if (incoming.length === 0) return;
      setFiles((current) => {
        const next = [...current];
        for (const file of incoming) {
          if (next.length >= MAX_ATTACHMENTS) {
            notify(`Dá para anexar até ${MAX_ATTACHMENTS} arquivos por mensagem.`);
            break;
          }
          const problem = attachmentProblem(file);
          if (problem) {
            notify(problem);
            continue;
          }
          next.push(file);
        }
        return next;
      });
    },
    [notify],
  );

  const remove = useCallback((index: number) => setFiles((current) => current.filter((_, i) => i !== index)), []);
  const clear = useCallback(() => setFiles([]), []);

  // Ctrl+V com um print na área de transferência: vira anexo (o texto colado continua normal).
  const onPaste = useCallback(
    (event: ClipboardEvent) => {
      const pasted = Array.from(event.clipboardData?.files ?? []);
      if (pasted.length === 0) return;
      event.preventDefault();
      const stamp = new Date().toLocaleTimeString('pt-BR').replace(/:/g, '-');
      add(
        pasted.map((file, index) =>
          file.name && !/^image\.(png|jpe?g)$/i.test(file.name)
            ? file
            : new File([file], `print-${stamp}${pasted.length > 1 ? `-${index + 1}` : ''}.${file.type.split('/')[1] || 'png'}`, { type: file.type }),
        ),
      );
    },
    [add],
  );

  return { files, add, remove, clear, onPaste };
}

export type AttachmentsState = ReturnType<typeof useAttachments>;

/** Botão "Anexar", lista de anexos com miniatura e área para arrastar arquivos. */
export function AttachmentBar({ att, compact = false }: { att: AttachmentsState; compact?: boolean }) {
  const [dragging, setDragging] = useState(false);
  const previews = useMemo(
    () => att.files.map((file) => (isImageName(file.name) ? URL.createObjectURL(file) : null)),
    [att.files],
  );
  useEffect(() => () => previews.forEach((url) => url && URL.revokeObjectURL(url)), [previews]);

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    att.add(Array.from(event.dataTransfer.files));
  }

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        'rounded-xl border border-dashed p-3 transition',
        dragging ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30' : 'border-slate-300 dark:border-[#2b2b31]',
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg bg-slate-100 px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-200 dark:bg-[#27272a] dark:text-zinc-100 dark:hover:bg-[#323238]">
          <Paperclip className="h-3.5 w-3.5" />
          Anexar arquivo
          <input
            type="file"
            multiple
            accept={ACCEPT_ATTACHMENTS}
            className="sr-only"
            onChange={(event) => {
              att.add(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
        </label>
        <span className="text-xs text-slate-500 dark:text-zinc-400">
          {compact
            ? 'Cole um print (Ctrl+V) ou arraste arquivos aqui.'
            : 'Cole um print (Ctrl+V no texto), arraste ou escolha. Imagens, planilhas, PDF, Word e texto; até 5 por mensagem (imagens 10 MB, arquivos 25 MB).'}
        </span>
      </div>
      {att.files.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {att.files.map((file, index) => (
            <li
              key={`${file.name}-${index}`}
              className="flex max-w-full items-center gap-2 rounded-lg border border-slate-200 bg-white py-1 pl-1 pr-2 text-xs dark:border-[#2b2b31] dark:bg-[#0f0f10]"
            >
              {previews[index] ? (
                <img src={previews[index]!} alt="" className="h-9 w-9 rounded object-cover" />
              ) : (
                <span className="grid h-9 w-9 place-items-center rounded bg-slate-100 dark:bg-[#27272a]">
                  <FileText className="h-4 w-4 text-slate-500" />
                </span>
              )}
              <span className="min-w-0">
                <span className="block max-w-[200px] truncate font-medium text-slate-800 dark:text-zinc-100">{file.name}</span>
                <span className="text-slate-500 dark:text-zinc-400">{formatSize(file.size)}</span>
              </span>
              <button
                type="button"
                aria-label={`Remover ${file.name}`}
                onClick={() => att.remove(index)}
                className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-[#27272a] dark:hover:text-white"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Anexo já enviado: imagem com miniatura (abre em tamanho grande) ou arquivo para baixar. */
export function AttachmentView({ attachment, notify }: { attachment: Attachment; notify: (message: string) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // /storage exige Authorization e um <img> não manda: busca a imagem (até 10 MB) com a sessão e mostra o resultado.
  useEffect(() => {
    const address = attachment.downloadUrl;
    if (!attachment.isImage || attachment.removed || !address) return;
    let url: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const token = getStoredToken();
        const response = await fetch(address.startsWith('/storage/') ? address : `${API_BASE_URL}${address}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!response.ok) throw new Error(String(response.status));
        url = URL.createObjectURL(await response.blob());
        if (!cancelled) setSrc(url);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [attachment.downloadUrl, attachment.isImage, attachment.removed]);

  if (attachment.removed || !attachment.downloadUrl) {
    return (
      <div className="inline-flex max-w-full items-start gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-400">
        <FileX className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="min-w-0">
          <span className="block max-w-[320px] truncate font-medium text-slate-700 dark:text-zinc-200">{attachment.fileName} ({formatSize(attachment.size)})</span>
          <span>Arquivo apagado automaticamente, por segurança, 90 dias depois de o chamado ser encerrado.</span>
        </span>
      </div>
    );
  }

  if (attachment.isImage && !failed) {
    return src ? (
      <a href={src} target="_blank" rel="noopener noreferrer" title={`${attachment.fileName} (clique para ampliar)`}>
        <img src={src} alt={attachment.fileName} className="max-h-48 max-w-full rounded-lg border border-slate-200 object-contain dark:border-[#2b2b31]" />
      </a>
    ) : (
      <span className="grid h-24 w-40 animate-pulse place-items-center rounded-lg bg-slate-100 text-xs text-slate-400 dark:bg-slate-800/60">carregando…</span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void downloadWithFeedback(attachment.downloadUrl!, attachment.fileName, notify)}
      className="inline-flex max-w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-xs transition hover:bg-slate-50 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:hover:bg-[#18181b]"
    >
      <FileText className="h-4 w-4 shrink-0 text-slate-500" />
      <span className="min-w-0">
        <span className="block max-w-[260px] truncate font-medium text-slate-800 dark:text-zinc-100">{attachment.fileName}</span>
        <span className="text-slate-500 dark:text-zinc-400">{formatSize(attachment.size)} · baixar</span>
      </span>
    </button>
  );
}
