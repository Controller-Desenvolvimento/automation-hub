import { Calendar, Clock, Pencil, Plus, Search, Trash2, Upload, Users, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Field } from '../components/field';
import { PageHeader } from '../components/page-header';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { ServerPathPicker } from '../components/server-path-picker';
import { Input } from '../components/ui/input';
import { Separator } from '../components/ui/separator';
import { Textarea } from '../components/ui/textarea';
import { useAuth } from '../contexts/auth-context';
import { useHub } from '../contexts/hub-context';
import { WEEKDAY_OPTIONS } from '../lib/constants';

import { api } from '../lib/api';
import type { Department, ManagedUser, RobotSchemaField, ScheduledTask } from '../lib/types';
import { departmentLabel, formatDate } from '../lib/utils';

type Draft = {
  id?: string;
  name: string;
  robotId: string;
  frequency: 'once' | 'daily' | 'weekly' | 'monthly';
  timesOfDay: string[];
  startDate: string;
  dayOfWeek: string;
  dayOfMonth: string;
  notes: string;
  isActive: boolean;
  parameters: Record<string, string | boolean>;
  recipientScope: 'none' | 'all' | 'departments' | 'specific';
  recipientDepartments: Department[];
  recipientUserIds: string[];
  creditMode: 'creator' | 'users' | 'department';
  creditUserIds: string[];
  creditDepartment: string;
};

export function SchedulesPage() {
  const { user } = useAuth();
  const { hub, hubError, notify, refreshHub, departments } = useHub();
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [templateFiles, setTemplateFiles] = useState<Record<string, File[]>>({});
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [allUsers, setAllUsers] = useState<ManagedUser[]>([]);
  const [query, setQuery] = useState('');

  const robots = useMemo(() => hub?.robots ?? [], [hub?.robots]);
  const selectedRobot = robots.find((robot) => robot.id === draft.robotId) ?? null;
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;

  const filteredTasks = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return tasks;
    return tasks.filter(
      (t) =>
        t.name.toLowerCase().includes(term) ||
        t.robot.name.toLowerCase().includes(term),
    );
  }, [tasks, query]);

  useEffect(() => {
    void loadTasks();
    if (user?.role === 'admin') {
      void api<ManagedUser[]>('/users').then(setAllUsers).catch(() => {});
    }
  }, [user?.role]);

  useEffect(() => {
    if (!selectedTask) {
      setDraft({
        ...emptyDraft(),
        robotId: robots[0]?.id ?? '',
      });
      setTemplateFiles({});
      return;
    }

    const scope = selectedTask.recipientScope ?? 'specific';
    setDraft({
      id: selectedTask.id,
      name: selectedTask.name,
      robotId: selectedTask.robotId,
      frequency: selectedTask.frequency,
      timesOfDay: selectedTask.timesOfDay?.length > 0 ? selectedTask.timesOfDay : [selectedTask.timeOfDay],
      startDate: toDateInputValue(selectedTask.startDate || selectedTask.nextRunAt),
      dayOfWeek:
        selectedTask.dayOfWeek === null || selectedTask.dayOfWeek === undefined
          ? ''
          : String(selectedTask.dayOfWeek),
      dayOfMonth:
        selectedTask.dayOfMonth === null || selectedTask.dayOfMonth === undefined
          ? ''
          : String(selectedTask.dayOfMonth),
      notes: selectedTask.notes ?? '',
      isActive: selectedTask.isActive,
      parameters: normalizeParameters(selectedTask.parameters ?? {}),
      recipientScope: scope === 'specific' && (selectedTask.recipientUserIds ?? []).length === 0 ? 'none' : scope as Draft['recipientScope'],
      recipientDepartments: (selectedTask.recipientDepartments ?? []) as Department[],
      recipientUserIds: selectedTask.recipientUserIds ?? [],
      creditMode: (selectedTask.creditMode as Draft['creditMode']) ?? 'creator',
      creditUserIds: selectedTask.creditUserIds ?? [],
      creditDepartment: selectedTask.creditDepartment ?? '',
    });
    setTemplateFiles({});
  }, [selectedTask, robots]);

  async function loadTasks() {
    try {
      const data = await api<ScheduledTask[]>('/scheduled-tasks');
      setTasks(data);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível carregar os agendamentos.');
    }
  }

  function startCreating() {
    setSelectedTaskId(null);
    setIsCreatingNew(true);
    setConfirmDeleteTaskId(null);
    setDraft((current) => ({
      ...emptyDraft(),
      robotId:
        current.robotId && robots.some((robot) => robot.id === current.robotId)
          ? current.robotId
          : robots[0]?.id || '',
    }));
    setTemplateFiles({});
  }

  async function handleDeleteTask(taskId: string, taskName: string) {
    try {
      await api(`/scheduled-tasks/${taskId}`, { method: 'DELETE' });
      notify(`Agendamento "${taskName}" excluído.`);
      setConfirmDeleteTaskId(null);
      if (selectedTaskId === taskId) {
        setSelectedTaskId(null);
      }
      await loadTasks();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível excluir o agendamento.');
      setConfirmDeleteTaskId(null);
    }
  }

  async function handleSave() {
    if (isSaving) return;
    setIsSaving(true);
    try {
      if (!draft.name.trim()) { notify('Informe um nome para o agendamento.'); return; }
      if (!draft.robotId) { notify('Selecione uma automação.'); return; }
      if (!draft.startDate) { notify('Selecione um dia para iniciar o agendamento.'); return; }
      const validTimes = draft.timesOfDay.filter((t) => /^\d{2}:\d{2}$/.test(t));
      if (validTimes.length === 0) { notify('Informe pelo menos um horário válido.'); return; }
      if (draft.frequency === 'weekly' && draft.dayOfWeek === '') { notify('Selecione o dia da semana.'); return; }
      if (draft.frequency === 'monthly') {
        const day = Number(draft.dayOfMonth);
        if (!Number.isInteger(day) || day < 1 || day > 31) { notify('Informe um dia do mês entre 1 e 31.'); return; }
      }
      const now = new Date();
      const testDate = new Date(`${draft.startDate}T${validTimes[0]}:00`);
      if (Number.isNaN(testDate.getTime())) { notify('Data ou horário inválido.'); return; }
      const originalStartDate = selectedTask ? toDateInputValue(selectedTask.startDate || selectedTask.nextRunAt) : null;
      const originalTimes = selectedTask
        ? (selectedTask.timesOfDay?.length > 0 ? selectedTask.timesOfDay : [selectedTask.timeOfDay])
        : [];
      const dateChanged =
        !draft.id ||
        draft.startDate !== originalStartDate ||
        JSON.stringify([...validTimes].sort()) !== JSON.stringify([...originalTimes].sort());
      if (dateChanged) {
        const today = todayDateInputValue();
        if (draft.startDate < today) { notify('Escolha uma data futura ou de hoje para o agendamento.'); return; }
        if (draft.startDate === today) {
          const anyFuture = validTimes.some((t) => new Date(`${draft.startDate}T${t}:00`) > now);
          if (!anyFuture) { notify('Para hoje, pelo menos um horário de disparo deve ser futuro.'); return; }
        }
      }
      const formData = new FormData();
      if (draft.id) formData.append('id', draft.id);
      formData.append('name', draft.name);
      formData.append('robotId', draft.robotId);
      formData.append('frequency', draft.frequency);
      formData.append('timesOfDay', JSON.stringify(validTimes));
      formData.append('startDate', draft.startDate);
      formData.append('dayOfWeek', draft.frequency === 'weekly' ? String(Number(draft.dayOfWeek)) : '');
      formData.append('dayOfMonth', draft.frequency === 'monthly' ? String(Number(draft.dayOfMonth)) : '');
      formData.append('notes', draft.notes);
      formData.append('isActive', String(draft.isActive));
      formData.append('parameters', JSON.stringify(draft.parameters));
      if (user?.role === 'admin') {
        const apiScope = draft.recipientScope === 'none' ? 'specific' : draft.recipientScope;
        formData.append('recipientScope', apiScope);
        formData.append('recipientDepartments', JSON.stringify(draft.recipientScope === 'departments' ? draft.recipientDepartments : []));
        formData.append('recipientUserIds', JSON.stringify(draft.recipientScope === 'specific' ? draft.recipientUserIds : []));
        formData.append('creditMode', draft.creditMode);
        formData.append('creditUserIds', JSON.stringify(draft.creditMode === 'users' ? draft.creditUserIds : []));
        if (draft.creditMode === 'department') {
          formData.append('creditDepartment', draft.creditDepartment);
        }
      }
      Object.values(templateFiles).forEach((files) => {
        files.forEach((file) => formData.append('templateFiles', file));
      });
      await api('/scheduled-tasks', { method: 'POST', body: formData });
      notify('Agendamento salvo com sucesso.');
      setTemplateFiles({});
      setIsCreatingNew(false);
      await loadTasks();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível salvar o agendamento.');
    } finally {
      setIsSaving(false);
    }
  }

  const isEditorOpen = Boolean(selectedTaskId) || isCreatingNew;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title={<>Agendamentos <span className="text-sky-600 dark:text-sky-400">automáticos</span></>}
        description="Programe robôs para rodar em horários fixos. O hub cria execuções reais usando a mesma fila e auditoria."
        actions={
          <Button onClick={startCreating}>
            <Plus className="mr-2 h-4 w-4" />
            Novo agendamento
          </Button>
        }
      />

      {hubError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600 dark:border-rose-500/30 dark:bg-rose-950/20 dark:text-rose-400">
          <span>Não foi possível carregar as automações do hub — o formulário pode estar incompleto.</span>
          <Button variant="outline" onClick={() => void refreshHub()}>
            Tentar novamente
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[360px_1fr] xl:items-start">
        <Card className="h-fit rounded-3xl">
          <CardHeader>
            <CardTitle>Agendamentos criados</CardTitle>
            <CardDescription>
              {user?.role === 'admin'
                ? 'Visão completa do ambiente.'
                : user?.role === 'manager'
                  ? 'Você vê os seus agendamentos e os do seu departamento.'
                  : 'Você vê apenas os seus agendamentos.'}
            </CardDescription>
            <div className="relative pt-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input className="h-9 pl-9 text-sm" placeholder="Buscar agendamento..." value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </CardHeader>
          <CardContent className="max-h-[62vh] overflow-y-auto px-2 pb-2">
            {filteredTasks.length === 0 ? (
              <p className="px-2 py-1 text-sm text-slate-500 dark:text-zinc-400">
                {query ? `Nenhum agendamento encontrado para "${query}".` : 'Nenhum agendamento criado ainda.'}
              </p>
            ) : null}
            {filteredTasks.map((task) => {
              const isSelected = task.id === selectedTaskId;
              const isConfirmingDelete = confirmDeleteTaskId === task.id;

              return (
                <div
                  key={task.id}
                  className={[
                    'group flex items-start gap-2 rounded-xl px-2 py-2 transition',
                    isSelected
                      ? 'bg-slate-100 dark:bg-[#1b1b20]'
                      : 'hover:bg-slate-50 dark:hover:bg-white/[0.03]',
                  ].join(' ')}
                >
                  {/* status dot */}
                  <div className="mt-[5px] flex-shrink-0">
                    <span className={`block h-2 w-2 rounded-full ${task.isActive ? 'bg-emerald-500' : 'bg-amber-400'}`} />
                  </div>

                  {/* name + robot + countdown */}
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => {
                      setSelectedTaskId(task.id);
                      setIsCreatingNew(false);
                      setConfirmDeleteTaskId(null);
                    }}
                  >
                    <span className={`block text-sm font-medium leading-snug ${task.isActive ? 'text-slate-900 dark:text-zinc-100' : 'text-slate-400 dark:text-zinc-500'}`}>
                      {task.name}
                    </span>
                    <span className="block text-xs text-slate-400 dark:text-zinc-500">
                      {task.robot.name}{!task.isActive ? ' · Pausado' : ''}
                    </span>
                    <CountdownLabel task={task} />
                  </button>

                  {/* actions */}
                  <div className="flex flex-shrink-0 items-center gap-0.5">
                    {isConfirmingDelete ? (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteTaskId(null)}
                          className="text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-zinc-500 dark:hover:text-zinc-300"
                        >
                          Não
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteTask(task.id, task.name)}
                          className="text-xs font-medium text-rose-500 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-300"
                        >
                          Excluir
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          aria-label={`Editar "${task.name}"`}
                          onClick={() => {
                            setSelectedTaskId(task.id);
                            setIsCreatingNew(false);
                            setConfirmDeleteTaskId(null);
                          }}
                          className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:text-zinc-600 dark:hover:bg-white/5 dark:hover:text-zinc-300"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Excluir "${task.name}"`}
                          onClick={() => setConfirmDeleteTaskId(task.id)}
                          className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-500 dark:text-zinc-600 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 gap-6">
          {isEditorOpen ? (
          <>
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500 dark:text-zinc-400">
            <Badge className="border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-500/35 dark:bg-slate-800 dark:text-zinc-200">
              Robô: {selectedRobot?.name ?? 'Selecione'}
            </Badge>
            <Badge className="border-indigo-200 bg-indigo-100 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-950 dark:text-indigo-200">
              Frequência: {frequencyLabel(draft.frequency)}
            </Badge>
            <Badge className="border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-500/40 dark:bg-sky-950 dark:text-sky-200">
              {draft.timesOfDay.length === 1
                ? `Horário ${draft.timesOfDay[0] || '--:--'}`
                : `${draft.timesOfDay.length} horários`}
            </Badge>
            <Badge variant={draft.isActive ? 'success' : 'muted'}>
              {draft.isActive ? 'Ativo' : 'Pausado'}
            </Badge>
          </div>

          <Card className="rounded-3xl">
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
              <div>
                <CardTitle>
                  {draft.id ? `Editar "${draft.name || 'agendamento'}"` : 'Novo agendamento'}
                </CardTitle>
                <CardDescription>
                  Defina quando o robô roda e com quais parâmetros e destinatários.
                </CardDescription>
              </div>
              <Button size="sm" variant="outline" disabled={isSaving} onClick={handleSave}>
                {isSaving ? 'Salvando...' : 'Salvar'}
              </Button>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-8">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label="Nome do agendamento">
                  <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </Field>
                <Field label="Automação">
                  <select
                    className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
                    value={draft.robotId}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        robotId: e.target.value,
                        parameters: {},
                      })
                    }
                  >
                    {robots.map((robot) => (
                      <option key={robot.id} value={robot.id}>
                        {robot.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Frequência">
                  <select
                    className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
                    value={draft.frequency}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        frequency: e.target.value as Draft['frequency'],
                      })
                    }
                  >
                    <option value="once">Uma vez</option>
                    <option value="daily">Diário</option>
                    <option value="weekly">Semanal</option>
                    <option value="monthly">Mensal</option>
                  </select>
                </Field>
                <Field label="Horários de disparo" hint="O robô dispara em cada horário listado, todos os dias válidos da frequência escolhida." className="md:col-span-2">
                  <div className="grid grid-cols-1 gap-2">
                    {draft.timesOfDay.map((t, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <Input
                          type="time"
                          value={t}
                          onChange={(e) => {
                            const next = [...draft.timesOfDay];
                            next[idx] = e.target.value;
                            setDraft({ ...draft, timesOfDay: next });
                          }}
                        />
                        {draft.timesOfDay.length > 1 && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={`Remover horário ${t || idx + 1}`}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                timesOfDay: draft.timesOfDay.filter((_, i) => i !== idx),
                              })
                            }
                            className="h-10 w-10 shrink-0 p-0 text-slate-400 hover:border-rose-300 hover:text-rose-500 dark:text-zinc-500 dark:hover:border-rose-700 dark:hover:text-rose-400"
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="justify-self-start"
                      onClick={() =>
                        setDraft({ ...draft, timesOfDay: [...draft.timesOfDay, '09:00'] })
                      }
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Adicionar horário
                    </Button>
                  </div>
                </Field>
                <Field label="Dia da primeira execução">
                  <Input
                    type="date"
                    min={todayDateInputValue()}
                    value={draft.startDate}
                    onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
                  />
                </Field>
                {draft.frequency === 'weekly' ? (
                  <Field label="Dia da semana">
                    <select
                      className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
                      value={draft.dayOfWeek}
                      onChange={(e) => setDraft({ ...draft, dayOfWeek: e.target.value })}
                    >
                      <option value="">Selecione</option>
                      {WEEKDAY_OPTIONS.map((option) => (
                        <option key={option.value} value={String(option.value)}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : null}
                {draft.frequency === 'monthly' ? (
                  <Field label="Dia do mês">
                    <Input
                      type="number"
                      min="1"
                      max="31"
                      value={draft.dayOfMonth}
                      onChange={(e) => setDraft({ ...draft, dayOfMonth: e.target.value })}
                    />
                  </Field>
                ) : null}
                <Field className="md:col-span-2" label="Observações">
                  <Textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
                </Field>
              </div>

              <Separator />

              <div className="grid grid-cols-1 gap-4">
                <div>
                  <h3 className="text-lg font-semibold">Parâmetros do robô</h3>
                  <p className="text-sm text-slate-500 dark:text-zinc-400">
                    Esses valores serão usados automaticamente a cada execução agendada.
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {(selectedRobot?.schema?.fields ?? []).map((field) => (
                    <FieldRenderer
                      key={field.name}
                      field={field}
                      robotId={selectedRobot?.id ?? ''}
                      value={draft.parameters[field.name]}
                      onChange={(value) =>
                        setDraft((current) => ({
                          ...current,
                          parameters: { ...current.parameters, [field.name]: value },
                        }))
                      }
                    />
                  ))}
                </div>
              </div>

              {(selectedRobot?.schema?.fileInputs ?? []).length > 0 ? (
                <div className="grid grid-cols-1 gap-4">
                  <div className="flex items-center gap-2">
                    <Upload className="h-4 w-4 text-slate-500 dark:text-zinc-400" />
                    <h3 className="text-lg font-semibold">Arquivos base do agendamento</h3>
                  </div>
                  <p className="text-sm text-slate-500 dark:text-zinc-400">
                    Os arquivos enviados aqui ficam vinculados ao agendamento e serão usados automaticamente.
                  </p>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {(selectedRobot?.schema?.fileInputs ?? []).map((fileInput) => (
                      <Field key={fileInput.name} label={fileInput.label} hint={fileInput.helperText}>
                        <Input
                          type="file"
                          multiple={fileInput.multiple}
                          accept={fileInput.accept}
                          onChange={(e) =>
                            setTemplateFiles((current) => ({
                              ...current,
                              [fileInput.name]: Array.from(e.target.files ?? []),
                            }))
                          }
                        />
                      </Field>
                    ))}
                  </div>
                  {selectedTask?.templateFiles && selectedTask.templateFiles.length > 0 ? (
                    <div className="rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-600 dark:border-slate-800 dark:text-zinc-300">
                      Arquivos atualmente salvos: {selectedTask.templateFiles.join(', ')}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {user?.role === 'admin' ? (
                <>
                  <Separator />
                  <div className="grid grid-cols-1 gap-4">
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4 text-slate-500 dark:text-zinc-400" />
                      <h3 className="text-lg font-semibold">Destinatários do resultado</h3>
                    </div>

                    <p className="text-sm text-slate-500 dark:text-zinc-400">
                      Quem receberá notificação com os arquivos gerados a cada execução.
                    </p>
                    <Field label="Escopo">
                      <select
                        className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
                        value={draft.recipientScope}
                        onChange={(e) =>
                          setDraft({ ...draft, recipientScope: e.target.value as Draft['recipientScope'], recipientDepartments: [], recipientUserIds: [] })
                        }
                      >
                        <option value="none">Somente o criador (sem notificações)</option>
                        <option value="all">Todos os usuários ativos</option>
                        <option value="departments">Por departamento</option>
                        <option value="specific">Usuários específicos</option>
                      </select>
                    </Field>

                    {draft.recipientScope === 'departments' ? (
                      <div className="grid grid-cols-1 gap-2">
                        <p className="text-sm font-medium">Selecione os departamentos</p>
                        <div className="flex flex-wrap gap-2">
                          {departments.filter((d) => d.isActive).map((dept) => {
                            const checked = draft.recipientDepartments.includes(dept.slug as Department);
                            return (
                              <label
                                key={dept.slug}
                                className={[
                                  'flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm transition',
                                  checked
                                    ? 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-300'
                                    : 'border-slate-200 bg-white text-slate-700 dark:border-[#2b2b31] dark:bg-[#111113] dark:text-zinc-300',
                                ].join(' ')}
                              >
                                <input
                                  type="checkbox"
                                  className="sr-only"
                                  checked={checked}
                                  onChange={(e) => {
                                    const val = dept.slug as Department;
                                    setDraft((cur) => ({
                                      ...cur,
                                      recipientDepartments: e.target.checked
                                        ? [...cur.recipientDepartments, val]
                                        : cur.recipientDepartments.filter((d) => d !== val),
                                    }));
                                  }}
                                />
                                {dept.name}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}

                    {draft.recipientScope === 'specific' ? (
                      <div className="grid grid-cols-1 gap-2">
                        <p className="text-sm font-medium">Selecione os usuários</p>
                        <div className="max-h-48 overflow-y-auto rounded-2xl border border-slate-200 dark:border-[#2b2b31]">
                          {allUsers.filter((u) => u.isActive).map((u) => {
                            const checked = draft.recipientUserIds.includes(u.id);
                            return (
                              <label
                                key={u.id}
                                className="flex cursor-pointer items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-0 hover:bg-slate-50 dark:border-[#2b2b31] dark:hover:bg-[#18181b]"
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    setDraft((cur) => ({
                                      ...cur,
                                      recipientUserIds: e.target.checked
                                        ? [...cur.recipientUserIds, u.id]
                                        : cur.recipientUserIds.filter((id) => id !== u.id),
                                    }));
                                  }}
                                />
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium">{u.name}</div>
                                  <div className="truncate text-xs text-slate-400">{u.email}</div>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <Separator />

                  <div className="grid grid-cols-1 gap-4">
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-slate-500 dark:text-zinc-400" />
                      <h3 className="text-lg font-semibold">Crédito de tempo ganho</h3>
                    </div>
                    <p className="text-sm text-slate-500 dark:text-zinc-400">
                      Defina a quem será atribuído o tempo economizado por este agendamento nos relatórios.
                    </p>
                    <Field label="Atribuir tempo ganho para">
                      <select
                        className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
                        value={draft.creditMode}
                        onChange={(e) =>
                          setDraft({ ...draft, creditMode: e.target.value as Draft['creditMode'], creditUserIds: [], creditDepartment: '' })
                        }
                      >
                        <option value="creator">Criador do agendamento</option>
                        <option value="users">Usuários específicos (divisão igual)</option>
                        <option value="department">Departamento específico</option>
                      </select>
                    </Field>

                    {draft.creditMode === 'users' ? (
                      <div className="grid grid-cols-1 gap-2">
                        <p className="text-sm font-medium">Selecione os usuários que receberão crédito</p>
                        <div className="max-h-48 overflow-y-auto rounded-2xl border border-slate-200 dark:border-[#2b2b31]">
                          {allUsers.filter((u) => u.isActive).map((u) => {
                            const checked = draft.creditUserIds.includes(u.id);
                            return (
                              <label
                                key={u.id}
                                className="flex cursor-pointer items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-0 hover:bg-slate-50 dark:border-[#2b2b31] dark:hover:bg-[#18181b]"
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    setDraft((cur) => ({
                                      ...cur,
                                      creditUserIds: e.target.checked
                                        ? [...cur.creditUserIds, u.id]
                                        : cur.creditUserIds.filter((id) => id !== u.id),
                                    }));
                                  }}
                                />
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium">{u.name}</div>
                                  <div className="truncate text-xs text-slate-400">{u.email}</div>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                        {draft.creditUserIds.length > 1 ? (
                          <p className="text-xs text-slate-400 dark:text-zinc-500">
                            Tempo dividido igualmente entre {draft.creditUserIds.length} usuários.
                          </p>
                        ) : null}
                      </div>
                    ) : null}

                    {draft.creditMode === 'department' ? (
                      <Field label="Departamento">
                        <select
                          className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
                          value={draft.creditDepartment}
                          onChange={(e) => setDraft({ ...draft, creditDepartment: e.target.value })}
                        >
                          <option value="">Selecione um departamento</option>
                          {departments.filter((d) => d.isActive).map((dept) => (
                            <option key={dept.slug} value={dept.slug}>{dept.name}</option>
                          ))}
                        </select>
                      </Field>
                    ) : null}
                  </div>
                </>
              ) : null}

              <div className="flex flex-wrap justify-between gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.isActive}
                    onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
                  />
                  Agendamento ativo
                </label>

                <div className="flex gap-3">
                  <Button disabled={isSaving} onClick={handleSave}>
                    {isSaving ? 'Salvando...' : 'Salvar agendamento'}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {selectedTask ? (
            <Card className="rounded-3xl">
              <CardHeader>
                <CardTitle>Resumo do agendamento</CardTitle>
                <CardDescription>Visão rápida da próxima execução e do histórico recente.</CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4">
                <InfoRow label="Solicitante" value={`${selectedTask.user.name} (${selectedTask.user.email})`} />
                <InfoRow label="Departamentos" value={selectedTask.user.departments.map((d) => departmentLabel(d, departments)).join(', ')} />
                <InfoRow label="Próxima execução" value={formatDate(selectedTask.nextRunAt)} />
                <InfoRow label="Última execução" value={selectedTask.lastRunAt ? formatDate(selectedTask.lastRunAt) : 'Ainda não executou'} />
                <InfoRow label="Último erro" value={selectedTask.lastError || 'Nenhum'} />
                {selectedTask.lastExecutionId ? (
                  <Button asChild variant="outline" size="sm" className="justify-center">
                    <Link to={`/executions/${selectedTask.lastExecutionId}`}>Abrir última execução</Link>
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
          </>
          ) : (
            <Card className="rounded-3xl">
              <CardContent className="grid grid-cols-1 justify-items-center gap-3 py-16 text-center">
                <div className="grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-[#18181b] dark:text-zinc-500">
                  <Calendar className="h-6 w-6" />
                </div>
                <div className="grid gap-1">
                  <p className="font-medium text-slate-900 dark:text-white">Nenhum agendamento selecionado</p>
                  <p className="text-sm text-slate-500 dark:text-zinc-400">
                    Escolha um agendamento à esquerda para editar, ou crie um novo.
                  </p>
                </div>
                <Button className="mt-2" onClick={startCreating}>
                  <Plus className="mr-2 h-4 w-4" />
                  Novo agendamento
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function FieldRenderer({
  field,
  robotId,
  value,
  onChange,
}: {
  field: RobotSchemaField;
  robotId: string;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  const className =
    field.type === 'textarea' || field.type === 'radio' || field.type === 'checkbox' || field.type === 'serverpath'
      ? 'md:col-span-2'
      : '';

  if (field.type === 'serverpath') {
    return (
      <Field className={className} label={field.label} hint={field.helperText}>
        <ServerPathPicker
          robotId={robotId}
          field={field}
          value={String(value ?? field.defaultValue ?? '')}
          onChange={(next) => onChange(next)}
        />
      </Field>
    );
  }

  if (field.type === 'textarea') {
    return (
      <Field className={className} label={field.label}>
        <Textarea value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      </Field>
    );
  }

  if (field.type === 'select') {
    return (
      <Field label={field.label}>
        <select
          className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
          value={String(value ?? field.defaultValue ?? field.options?.[0] ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  if (field.type === 'radio') {
    return (
      <Field className={className} label={field.label}>
        <div className="flex flex-wrap gap-3">
          {(field.options ?? []).map((option) => (
            <label key={option} className="flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm dark:border-slate-700">
              <input
                type="radio"
                name={field.name}
                checked={String(value ?? field.defaultValue ?? '') === option}
                onChange={() => onChange(option)}
              />
              {option}
            </label>
          ))}
        </div>
      </Field>
    );
  }

  if (field.type === 'checkbox') {
    return (
      <Field className={className} label={field.label}>
        <label className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 text-sm dark:border-slate-700">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          Ativar
        </label>
      </Field>
    );
  }

  return (
    <Field label={field.label}>
      <Input
        type={field.type || 'text'}
        value={String(value ?? field.defaultValue ?? '')}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
      />
    </Field>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 px-4 py-3 dark:border-slate-800">
      <span className="text-sm text-slate-500 dark:text-zinc-400">{label}</span>
      <span className="max-w-[70%] text-right text-sm font-medium leading-relaxed">{value}</span>
    </div>
  );
}

function CountdownLabel({ task }: { task: ScheduledTask }) {
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="text-xs text-slate-500 dark:text-zinc-400">
      {countdownLabel(task, nowTick)}
    </span>
  );
}

function emptyDraft(): Draft {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  return {
    name: '',
    robotId: '',
    frequency: 'once',
    timesOfDay: ['09:00'],
    startDate: `${yyyy}-${mm}-${dd}`,
    dayOfWeek: '1',
    dayOfMonth: '1',
    notes: '',
    isActive: true,
    parameters: {},
    recipientScope: 'none',
    recipientDepartments: [],
    recipientUserIds: [],
    creditMode: 'creator',
    creditUserIds: [],
    creditDepartment: '',
  };
}

function toDateInputValue(value?: string | null) {
  if (!value) return emptyDraft().startDate;
  const date = new Date(value);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function todayDateInputValue() {
  return emptyDraft().startDate;
}

function countdownLabel(task: ScheduledTask, nowTick: number) {
  if (!task.isActive) {
    if (task.frequency === 'once') {
      if (task.lastExecutionStatus === 'canceled') return 'Última execução cancelada';
      if (task.lastExecutionStatus === 'error') return 'Última execução com erro';
      if (task.lastExecutionStatus === 'success') return 'Execução concluída';
      if (task.lastExecutionStatus === 'running') return 'Execução em andamento';
      if (task.lastExecutionStatus === 'queued') return 'Execução em fila';
      return 'Agendamento finalizado';
    }
    return 'Agendamento pausado';
  }

  const diff = new Date(task.nextRunAt).getTime() - nowTick;
  if (diff <= 0) {
    return 'Executando em instantes';
  }

  const totalSec = Math.floor(diff / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  if (days > 0) {
    return `Falta ${days}d ${hours}h`;
  }

  return `Falta ${hours}h ${minutes}m ${seconds}s`;
}

function normalizeParameters(value: Record<string, unknown>) {
  return Object.entries(value).reduce<Record<string, string | boolean>>(
    (acc, [key, item]) => {
      if (typeof item === 'boolean') {
        acc[key] = item;
      } else if (item != null) {
        acc[key] = String(item);
      }
      return acc;
    },
    {},
  );
}

function frequencyLabel(value: Draft['frequency']) {
  return {
    once: 'Uma vez',
    daily: 'Diário',
    weekly: 'Semanal',
    monthly: 'Mensal',
  }[value];
}
