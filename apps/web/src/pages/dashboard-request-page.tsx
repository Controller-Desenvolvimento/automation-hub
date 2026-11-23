import { Send } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Field } from '../components/field';
import { PageHeader } from '../components/page-header';
import { RequestTypeSwitch } from '../components/request-type-switch';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { useHub } from '../contexts/hub-context';
import { api } from '../lib/api';

type Draft = {
  title: string;
  audience: string;
  dataSource: string;
  metrics: string;
  notes: string;
};

export function DashboardRequestPage() {
  const { notify } = useHub();
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Draft>({
    title: '',
    audience: '',
    dataSource: '',
    metrics: '',
    notes: '',
  });

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!draft.title.trim() || !draft.metrics.trim()) {
      notify('Preencha pelo menos o nome do dashboard e o que ele precisa acompanhar.');
      return;
    }

    const description = [
      draft.metrics.trim() ? `O que precisa acompanhar: ${draft.metrics.trim()}` : null,
      draft.audience.trim() ? `Para quem é: ${draft.audience.trim()}` : null,
      draft.dataSource.trim() ? `Fonte de dados: ${draft.dataSource.trim()}` : null,
      draft.notes.trim() ? `Observações: ${draft.notes.trim()}` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join('\n');

    try {
      setSaving(true);
      await api('/automation-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Dashboard: ${draft.title.trim()}`,
          systemName: draft.dataSource.trim(),
          description,
          urgency: 'normal',
          cadence: 'once',
          requiresLogin: false,
          requiresCertificate: false,
          requiresCaptcha: false,
          kindLabel: 'dashboard',
          pageLabel: 'Solicitar dashboard',
        }),
      });

      setDraft({ title: '', audience: '', dataSource: '', metrics: '', notes: '' });
      notify('Solicitação de dashboard enviada. Depois acompanhe as notificações para ver o andamento.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível enviar a solicitação.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title={
          <>
            Solicitar <span className="text-sky-600 dark:text-sky-400">dashboard</span>
          </>
        }
        description="Envie um resumo rápido do dashboard que você precisa. Depois a gente entra em contato para entender os indicadores e a origem dos dados."
      />

      <RequestTypeSwitch current="dashboard" />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.15fr_0.85fr]">
        <Card className="rounded-3xl">
          <CardHeader>
            <CardTitle>Descreva o dashboard</CardTitle>
            <p className="text-sm text-slate-500 dark:text-zinc-400">
              Quanto mais claro o objetivo, mais fácil fica entender quais indicadores e fontes precisam entrar.
            </p>
          </CardHeader>
          <CardContent>
            <form className="grid grid-cols-1 gap-4" onSubmit={(event) => void submitRequest(event)}>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label="Nome do dashboard" hint="Um título curto para identificar o pedido">
                  <Input
                    value={draft.title}
                    onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                    placeholder="Ex.: Indicadores de produção"
                  />
                </Field>
                <Field label="Para quem é" hint="Área, diretoria ou time que vai usar">
                  <Input
                    value={draft.audience}
                    onChange={(event) => setDraft((current) => ({ ...current, audience: event.target.value }))}
                    placeholder="Ex.: diretoria, fiscal, operações"
                  />
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label="Fonte de dados" hint="Sistema, planilha ou base de onde saem os números">
                  <Input
                    value={draft.dataSource}
                    onChange={(event) => setDraft((current) => ({ ...current, dataSource: event.target.value }))}
                    placeholder="Ex.: sistema interno, planilha Excel, banco de dados"
                  />
                </Field>
                <Field label="O que precisa acompanhar" hint="Resumo dos indicadores que o dashboard deve mostrar">
                  <Input
                    value={draft.metrics}
                    onChange={(event) => setDraft((current) => ({ ...current, metrics: event.target.value }))}
                    placeholder="Ex.: vendas, status, prazos, pendências"
                  />
                </Field>
              </div>

              <Field label="Detalhes extras" hint="Se precisar, descreva filtros, período, regras ou observações">
                <Textarea
                  className="min-h-32"
                  value={draft.notes}
                  onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
                  placeholder="Ex.: considerar somente o mês atual, separar por unidade e permitir filtro por responsável..."
                />
              </Field>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                <p className="text-xs text-slate-500 dark:text-zinc-400">
                  Depois da solicitação, as etapas do processo serão informadas pelas notificações do sistema.
                </p>
                <Button type="submit" disabled={saving}>
                  <Send className="mr-2 h-4 w-4" />
                  {saving ? 'Enviando...' : 'Solicitar dashboard'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="rounded-3xl">
          <CardHeader>
            <CardTitle>Como funciona</CardTitle>
            <p className="text-sm text-slate-500 dark:text-zinc-400">
              A ideia é receber o básico rápido e seguir com o contato quando a gente precisar detalhar melhor.
            </p>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-slate-600 dark:text-zinc-300">
            <InfoRow title="1. Envie o resumo" text="Coloque o nome do dashboard, o público e o que precisa ser acompanhado." />
            <InfoRow title="2. A gente analisa" text="Depois verificamos a melhor forma de estruturar os indicadores e as fontes de dados." />
            <InfoRow title="3. Acompanhamento" text="As próximas informações e etapas vão aparecer nas notificações do sistema." />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function InfoRow({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-[8px] border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-zinc-400">{title}</div>
      <div className="mt-1 text-sm text-slate-700 dark:text-zinc-200">{text}</div>
    </div>
  );
}
