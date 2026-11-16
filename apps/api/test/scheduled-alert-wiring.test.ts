import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
    markAsSuccess: async () => undefined,
    getScheduledTaskId: async () => ({ scheduledTaskId: opts.agendada ? 't1' : null }),
    getScheduledExecutionForAlert: async () =>
      opts.agendada
        ? { robotName: 'Robô X', scheduleName: 'Agendamento X', startedAt: new Date(), finishedAt: new Date(), errorMessage: 'boom' }
        : null,
    findRunningOrphans: async () => [{ id: 'orfa-1', robot: { name: 'Robô X' } }],
    collectSkippedDependents: async () => [] as string[],
  };
  const notifications = { createForScheduledTaskExecution: async () => undefined };
  const avisos: any[] = [];
  const mail = {
    sendScheduledExecutionAlert: async (input: unknown) => {
      if (opts.smtpFalha) throw new Error('SMTP fora do ar');
      alertas.push(input);
    },
    sendScheduledWarningAlert: async (input: unknown) => { avisos.push(input); },
  };
  const runner = new Runner(executionsService, notifications, mail);
  runner.zipOutputDirectory = async () => undefined;
  runner.registerOutputFiles = async () => [];
  runner.writeExecutionMetadata = async () => undefined;
  runner.processQueue = async () => undefined;
  return { runner, alertas, erros, avisos };
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
function montarCiclo(opts: { attempt: number; restartExpected: boolean }) {
  const base = montar({ agendada: true });
  const chamadas: string[] = [];
  base.runner.executionsService.collectSkippedDependents = async (id: string) => { chamadas.push(id); return ['Atualizar Planilhas Excel (BI) — Excel 06:55']; };
  base.runner.executionsService.getScheduledExecutionForAlert = async () => ({
    robotName: 'Gestta', scheduleName: 'Gestta 06:30', scheduledTaskId: 't1', attempt: opts.attempt, cycleFirstId: 'ciclo-1', restartExpected: opts.restartExpected,
    startedAt: new Date(), finishedAt: new Date(), errorMessage: 'Download incompleto', first: null,
  });
  return { ...base, chamadas };
}

// Roda `fn` com SCHEDULE_RESTART_ON_ERROR = valor (e restaura no fim).
async function comReinicioPorErro(valor: string | undefined, fn: () => Promise<void>) {
  const antes = process.env.SCHEDULE_RESTART_ON_ERROR;
  if (valor === undefined) delete process.env.SCHEDULE_RESTART_ON_ERROR; else process.env.SCHEDULE_RESTART_ON_ERROR = valor;
  try { await fn(); } finally { if (antes === undefined) delete process.env.SCHEDULE_RESTART_ON_ERROR; else process.env.SCHEDULE_RESTART_ON_ERROR = antes; }
}

test('falha definitiva do ciclo (sem verificação por tempo: nenhum reinício vem) cita os agendamentos que esperavam ("Não executou")', async () => {
  const { runner, alertas, chamadas } = montarCiclo({ attempt: 1, restartExpected: false });
  await runner.runExecution('ciclo-1');
  await esperar();
  assert.deepEqual(chamadas, ['ciclo-1']);
  assert.equal(alertas.length, 1);
  assert.deepEqual(alertas[0].skipped, ['Atualizar Planilhas Excel (BI) — Excel 06:55']);
});

test('reinício por erro DESLIGADO (SCHEDULE_RESTART_ON_ERROR=false): erro na 1ª tentativa é definitivo, como antes', async () => {
  await comReinicioPorErro('false', async () => {
    const { runner, alertas, chamadas } = montarCiclo({ attempt: 1, restartExpected: true });
    await runner.runExecution('ciclo-1');
    await esperar();
    assert.deepEqual(chamadas, ['ciclo-1']);
    assert.equal(alertas.length, 1);
    assert.equal(alertas[0].kind, 'error');
  });
});

test('erro na 1ª tentativa COM verificação por tempo vai ser refeito: sem e-mail agora e sem queimar os dependentes', async () => {
  await comReinicioPorErro(undefined, async () => {
    const { runner, alertas, chamadas } = montarCiclo({ attempt: 1, restartExpected: true });
    await runner.runExecution('ciclo-1');
    await esperar();
    assert.equal(alertas.length, 0, 'o e-mail fica para o fim do ciclo');
    assert.deepEqual(chamadas, [], 'quem espera continua esperando o reinício');
  });
});

test('travamento (watchdog) na 1ª tentativa COM verificação por tempo também espera o reinício, sem e-mail', async () => {
  await comReinicioPorErro(undefined, async () => {
    const { runner, alertas, chamadas } = montarCiclo({ attempt: 1, restartExpected: true });
    runner.stalledExecutions.set('ciclo-1', 'Execução sem nenhuma saída há 45 min.');
    await runner.runExecution('ciclo-1');
    await esperar();
    assert.equal(alertas.length, 0);
    assert.deepEqual(chamadas, []);
  });
});

test('erro na 2ª tentativa (o reinício) é sempre o fim do ciclo: cita os dependentes no e-mail final', async () => {
  await comReinicioPorErro(undefined, async () => {
    const { runner, final, chamadas } = (() => {
      const b = montarReinicio();
      const chamadas: string[] = [];
      b.runner.executionsService.collectSkippedDependents = async (id: string) => { chamadas.push(id); return ['Excel']; };
      b.runner.executionsService.getScheduledExecutionForAlert = async () => ({
        robotName: 'Gestta', scheduleName: 'Gestta 06:30', scheduledTaskId: 't1', attempt: 2, cycleFirstId: 'e0', restartExpected: true,
        startedAt: new Date(), finishedAt: new Date(), errorMessage: 'falhou de novo',
        first: { executionId: 'e0', startedAt: new Date(), finishedAt: new Date(), outcome: 'Download incompleto' },
      });
      return { ...b, chamadas };
    })();
    await runner.runExecution('exec-r9');
    await esperar();
    assert.equal(final.length, 1);
    assert.deepEqual(chamadas, ['e0']);
    assert.deepEqual(final[0].skipped, ['Excel']);
  });
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

// ---- AH_ALERT (aviso sem parar o robô) e print da tela no e-mail de erro ----
function robo(nome: string, corpo: string) {
  writeFileSync(join(tmp, nome), corpo, 'utf8');
  return `node ${nome}`;
}
const PNG_MINIMO = 'Buffer.from("89504e470d0a1a0a", "hex")';

test('AH_ALERT: guarda o aviso, registra no log como AVISO e ignora vazio; "warning" vale como "warn"', async () => {
  const { runner } = montar({ agendada: true });
  const logs: Array<[string, string]> = [];
  runner.executionsService.log = async (_id: string, level: string, msg: string) => { logs.push([level, msg]); };
  await runner.handleProcessLine('e1', 'AH_ALERT|Coluna "Apontamento - Tempo" não encontrada', 'info');
  await runner.handleProcessLine('e1', 'AH_ALERT|   ', 'info');
  await runner.handleProcessLine('e1', 'AH_LOG|warning|algo estranho', 'info');
  await runner.handleProcessLine('e1', 'AH_LOG|warn|outro', 'info');
  assert.deepEqual(runner.robotAlerts.get('e1'), ['Coluna "Apontamento - Tempo" não encontrada']);
  assert.deepEqual(logs, [
    ['warn', 'AVISO: Coluna "Apontamento - Tempo" não encontrada'],
    ['warn', 'algo estranho'],
    ['warn', 'outro'],
  ]);
});

test('execução AGENDADA com SUCESSO e avisos: manda UM e-mail "Atenção" com os avisos (sem repetidos)', async () => {
  const { runner, alertas, avisos, erros } = montar({ agendada: true, command: robo('robo-aviso.js', "console.log('AH_ALERT|aviso um'); console.log('AH_ALERT|aviso um'); console.log('AH_ALERT|aviso dois');") });
  await runner.runExecution('exec-a1');
  await esperar(80);
  assert.equal(erros.length, 0);
  assert.equal(alertas.length, 0, 'sem e-mail de erro');
  assert.equal(avisos.length, 1);
  assert.deepEqual(avisos[0].warnings, ['aviso um', 'aviso dois']);
  assert.equal(avisos[0].executionId, 'exec-a1');
  assert.equal(avisos[0].scheduleName, 'Agendamento X');
});

test('sucesso SEM avisos não manda e-mail de aviso', async () => {
  const { runner, avisos } = montar({ agendada: true, command: robo('robo-ok.js', "console.log('tudo certo');") });
  await runner.runExecution('exec-a2');
  await esperar(80);
  assert.equal(avisos.length, 0);
});

test('execução MANUAL com avisos não manda e-mail (os avisos ficam só no log)', async () => {
  const { runner, avisos } = montar({ agendada: false, command: robo('robo-aviso2.js', "console.log('AH_ALERT|aviso manual');") });
  await runner.runExecution('exec-a3');
  await esperar(80);
  assert.equal(avisos.length, 0);
});

test('erro COM print e avisos: o e-mail de erro leva os avisos e a imagem (lida antes de a saída ser empacotada)', async () => {
  const corpo = `const fs=require('fs'),path=require('path');
console.log('AH_ALERT|aviso antes da falha');
fs.writeFileSync(path.join(process.env.AUTOMATION_OUTPUT_DIR,'erro_2026-11-16_11-20.png'), ${PNG_MINIMO});
fs.writeFileSync(path.join(process.env.AUTOMATION_OUTPUT_DIR,'relatorio.png'), ${PNG_MINIMO});
console.log('AH_LOG|error|Nao achei o botao Exportar');
process.exit(1);`;
  const { runner, alertas } = montar({ agendada: true, command: robo('robo-erro.js', corpo) });
  await runner.runExecution('exec-a4');
  await esperar(100);
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].kind, 'error');
  assert.match(alertas[0].errorMessage ?? 'boom', /./);
  assert.deepEqual(alertas[0].warnings, ['aviso antes da falha']);
  assert.equal(alertas[0].screenshots.length, 1, 'só erro_*.png, não o relatorio.png');
  assert.equal(alertas[0].screenshots[0].filename, 'erro_2026-11-16_11-20.png');
  assert.equal(alertas[0].screenshots[0].content.length, 8);
});

test('erro sem print nem avisos: o e-mail sai como sempre (listas vazias)', async () => {
  const { runner, alertas } = montar({ agendada: true });
  await runner.runExecution('exec-a5');
  await esperar();
  assert.equal(alertas.length, 1);
  assert.deepEqual(alertas[0].warnings, []);
  assert.deepEqual(alertas[0].screenshots, []);
});

test('2ª tentativa (reinício) que falha: o e-mail final leva os avisos e o print dela', async () => {
  const corpo = `const fs=require('fs'),path=require('path');
console.log('AH_ALERT|aviso do reinício');
fs.writeFileSync(path.join(process.env.AUTOMATION_OUTPUT_DIR,'erro_reinicio.png'), ${PNG_MINIMO});
process.exit(1);`;
  const base = montarReinicio();
  base.runner.executionsService.markAsRunning = async (id: string) => ({
    id, inputJson: {}, files: [], robot: { id: 'r1', name: 'Robô X', command: robo('robo-erro2.js', corpo), workingDirectory: null, unitMetricKey: null },
  });
  await base.runner.runExecution('exec-a6');
  await esperar(100);
  assert.equal(base.final.length, 1);
  assert.deepEqual(base.final[0].warnings, ['aviso do reinício']);
  assert.equal(base.final[0].screenshots.length, 1);
  assert.equal(base.final[0].screenshots[0].filename, 'erro_reinicio.png');
});
