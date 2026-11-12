import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { limparTmp } from './_limpar-tmp';
import test, { after, before } from 'node:test';

// O runner grava em <cwd>/storage: aponta para uma pasta temporária ANTES de importar o módulo.
const tmp = mkdtempSync(join(tmpdir(), 'alert-wiring-'));
const cwdOriginal = process.cwd();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Runner: any;

before(async () => {
  process.chdir(tmp);
  Runner = (await import('../src/executions/execution-runner.service')).ExecutionRunnerService;
});

after(() => {
  process.chdir(cwdOriginal);
  limparTmp(tmp);
});

const esperar = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function montar(opts: { agendada: boolean; command?: string | null; statusAtual?: string; smtpFalha?: boolean }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const alertas: any[] = [];
  const erros: Array<[string, string]> = [];
  const executionsService = {
    markAsRunning: async (id: string) => ({
      id,
      inputJson: {},
      files: [],
      robot: { id: 'r1', name: 'Robô X', command: opts.command ?? null, workingDirectory: null, unitMetricKey: null },
    }),
    log: async () => undefined,
    updateProgress: async () => undefined,
    getExecution: async () => ({ status: opts.statusAtual ?? 'running' }),
    markAsError: async (id: string, msg: string) => { erros.push([id, msg]); },
    getScheduledTaskId: async () => ({ scheduledTaskId: opts.agendada ? 't1' : null }),
    getScheduledExecutionForAlert: async () =>
      opts.agendada
        ? { robotName: 'Robô X', scheduleName: 'Agendamento X', startedAt: new Date(), finishedAt: new Date(), errorMessage: 'boom' }
        : null,
    findRunningOrphans: async () => [{ id: 'orfa-1', robot: { name: 'Robô X' } }],
    collectSkippedDependents: async () => [] as string[],
  };
  const notifications = { createForScheduledTaskExecution: async () => undefined };
  const mail = {
    sendScheduledExecutionAlert: async (input: unknown) => {
      if (opts.smtpFalha) throw new Error('SMTP fora do ar');
      alertas.push(input);
    },
  };
  const runner = new Runner(executionsService, notifications, mail);
  runner.zipOutputDirectory = async () => undefined;
  runner.registerOutputFiles = async () => [];
  runner.writeExecutionMetadata = async () => undefined;
  runner.processQueue = async () => undefined;
  return { runner, alertas, erros };
}

test('execução AGENDADA que falha dispara 1 alerta de erro com os dados do agendamento', async () => {
  const { runner, alertas, erros } = montar({ agendada: true });
  await runner.runExecution('exec-1');
  await esperar();
  assert.equal(erros.length, 1);
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].kind, 'error');
  assert.equal(alertas[0].executionId, 'exec-1');
  assert.equal(alertas[0].scheduleName, 'Agendamento X');
  assert.equal(alertas[0].robotName, 'Robô X');
});

test('execução MANUAL que falha não manda e-mail', async () => {
  const { runner, alertas, erros } = montar({ agendada: false });
  await runner.runExecution('exec-2');
  await esperar();
  assert.equal(erros.length, 1);
  assert.equal(alertas.length, 0);
});

test('execução cancelada pelo usuário não manda e-mail', async () => {
  const { runner, alertas, erros } = montar({ agendada: true, statusAtual: 'canceled' });
  await runner.runExecution('exec-3');
  await esperar();
  assert.equal(erros.length, 0);
  assert.equal(alertas.length, 0);
});

test('travamento (watchdog) vira alerta "stalled" com a mensagem do travamento', async () => {
  const { runner, alertas, erros } = montar({ agendada: true });
  runner.stalledExecutions.set('exec-4', 'Execução sem nenhuma saída há 45 min.');
  await runner.runExecution('exec-4');
  await esperar();
  assert.equal(erros[0][1], 'Execução sem nenhuma saída há 45 min.');
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].kind, 'stalled');
});

test('erro no envio do e-mail não atrapalha a execução nem gera rejeição sem tratamento', async () => {
  const rejeicoes: unknown[] = [];
  const handler = (reason: unknown) => rejeicoes.push(reason);
  process.on('unhandledRejection', handler);
  try {
    const { runner, erros } = montar({ agendada: true, smtpFalha: true });
    await runner.runExecution('exec-5');
    await esperar(60);
    assert.equal(erros.length, 1);
    assert.equal(rejeicoes.length, 0);
  } finally {
    process.off('unhandledRejection', handler);
  }
});

test('execução órfã após reinício do Hub dispara alerta "interrupted"', async () => {
  const { runner, alertas, erros } = montar({ agendada: true });
  await runner.reconcileOrphanedExecutions();
  await esperar();
  assert.equal(erros.length, 1);
  assert.match(erros[0][1], /Execução interrompida/);
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].kind, 'interrupted');
  assert.equal(alertas[0].executionId, 'orfa-1');
});

// ---- reinício automático (2ª tentativa): vira o e-mail final consolidado, não o simples ----
function montarReinicio() {
  const base = montar({ agendada: true });
  const final: any[] = [];
  const simples: any[] = [];
  base.runner.executionsService.getScheduledExecutionForAlert = async () => ({
    robotName: 'Robô X', scheduleName: 'Agendamento X', scheduledTaskId: 't1', attempt: 2,
    startedAt: new Date(), finishedAt: new Date(), errorMessage: 'falhou de novo',
    first: { executionId: 'e0', startedAt: new Date(), finishedAt: new Date(), outcome: 'travou na 1ª' },
  });
  base.runner.mailService.sendRestartFailedAlert = async (i: unknown) => { final.push(i); };
  base.runner.mailService.sendScheduledExecutionAlert = async (i: unknown) => { simples.push(i); };
  return { ...base, final, simples };
}

test('2ª tentativa (reinício) que falha: UM e-mail final com as duas tentativas, e nenhum e-mail simples', async () => {
  const { runner, final, simples } = montarReinicio();
  await runner.runExecution('exec-r1');
  await esperar();
  assert.equal(simples.length, 0);
  assert.equal(final.length, 1);
  assert.equal(final[0].first.executionId, 'e0');
  assert.equal(final[0].second.executionId, 'exec-r1');
  assert.equal(final[0].second.outcome, 'falhou de novo');
});

test('2ª tentativa interrompida pelo reinício do Hub também vira o e-mail final', async () => {
  const { runner, final, simples } = montarReinicio();
  await runner.reconcileOrphanedExecutions();
  await esperar();
  assert.equal(simples.length, 0);
  assert.equal(final.length, 1);
});

// ---- dependência entre agendamentos ----
test('falha definitiva do ciclo cita no e-mail os agendamentos que esperavam por ele ("Não executou")', async () => {
  const { runner, alertas } = montar({ agendada: true });
  const chamadas: string[] = [];
  runner.executionsService.collectSkippedDependents = async (id: string) => { chamadas.push(id); return ['Atualizar Planilhas Excel (BI) — Excel 06:55']; };
  runner.executionsService.getScheduledExecutionForAlert = async () => ({
    robotName: 'Gestta', scheduleName: 'Gestta 06:30', scheduledTaskId: 't1', attempt: 1, cycleFirstId: 'ciclo-1', restartExpected: true,
    startedAt: new Date(), finishedAt: new Date(), errorMessage: 'Download incompleto', first: null,
  });
  await runner.runExecution('ciclo-1');
  await esperar();
  assert.deepEqual(chamadas, ['ciclo-1']);
  assert.deepEqual(alertas[0].skipped, ['Atualizar Planilhas Excel (BI) — Excel 06:55']);
});

test('interrupção pelo reinício do Hub que AINDA será refeita não queima os agendamentos dependentes', async () => {
  const { runner, alertas } = montar({ agendada: true });
  let chamou = false;
  runner.executionsService.collectSkippedDependents = async () => { chamou = true; return ['X']; };
  runner.executionsService.getScheduledExecutionForAlert = async () => ({
    robotName: 'Gestta', scheduleName: 'Gestta 06:30', scheduledTaskId: 't1', attempt: 1, cycleFirstId: 'orfa-1', restartExpected: true,
    startedAt: new Date(), finishedAt: new Date(), errorMessage: 'interrompida', first: null,
  });
  await runner.reconcileOrphanedExecutions();
  await esperar();
  assert.equal(chamou, false);
  assert.equal(alertas.length, 1);
  assert.deepEqual(alertas[0].skipped, []);
});

test('interrupção sem verificação por tempo (nenhum reinício vem) é definitiva e cita os dependentes', async () => {
  const { runner, alertas } = montar({ agendada: true });
  runner.executionsService.collectSkippedDependents = async () => ['Excel'];
  runner.executionsService.getScheduledExecutionForAlert = async () => ({
    robotName: 'Gestta', scheduleName: 'Gestta 06:30', scheduledTaskId: 't1', attempt: 1, cycleFirstId: 'orfa-1', restartExpected: false,
    startedAt: new Date(), finishedAt: new Date(), errorMessage: 'interrompida', first: null,
  });
  await runner.reconcileOrphanedExecutions();
  await esperar();
  assert.deepEqual(alertas[0].skipped, ['Excel']);
});

test('execução retida por dependência não é iniciada e o motivo dela não é sobrescrito pela fila', async () => {
  const { runner } = montar({ agendada: true });
  const retida = { id: 'h1', robotId: 'r1', waitingOnExecutionId: 'ciclo-1', currentStep: 'Aguardando o agendamento "Gestta 06:30" terminar', robot: { name: 'Excel', maxConcurrency: 1, conflictKeys: null } };
  assert.equal(runner.getExecutionBlocker(retida, [], 4), 'Aguardando o agendamento "Gestta 06:30" terminar');
  const livre = { ...retida, id: 'l1', waitingOnExecutionId: null };
  assert.equal(runner.getExecutionBlocker(livre, [], 4), null);

  const gravados: string[] = [];
  runner.executionsService.updateQueueReason = async (id: string) => { gravados.push(id); };
  await runner.updateQueuedReasons([retida, livre], 'Aguardando capacidade do servidor');
  assert.deepEqual(gravados, ['l1'], 'só a execução livre recebe o motivo da fila');
});
