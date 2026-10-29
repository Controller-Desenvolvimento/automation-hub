import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ExecutionRunnerService } from '../src/executions/execution-runner.service';
import { failureReason, isPythonExceptionLine } from '../src/executions/failure-reason';

test('o motivo do erro é o que o robô declarou; sem isso, a exceção do Python; sem isso, o genérico', () => {
  assert.equal(failureReason(1, 'Nenhum certificado do CNPJ 13925723000577 na pasta.', "KeyError: 'x'"), 'Nenhum certificado do CNPJ 13925723000577 na pasta.');
  assert.equal(failureReason(1, undefined, "KeyError: 'empresas'"), "KeyError: 'empresas'");
  assert.equal(failureReason(1), 'Comando finalizado com codigo 1');
  assert.equal(failureReason(null, '', ''), 'Comando finalizado com codigo desconhecido');
  // símbolos de log no começo da linha ("✗ ", "! ") não vão para a tela
  assert.equal(failureReason(1, '✗ SEM CERTIFICADO: não existe certificado.'), 'SEM CERTIFICADO: não existe certificado.');
  assert.equal(failureReason(1, '! atenção: algo'), 'atenção: algo');
  assert.equal(failureReason(1, 'Erro! no meio'), 'Erro! no meio');
  // texto comprido e com quebras vira uma linha curta
  const longo = failureReason(1, `linha 1\n  linha 2 ${'x'.repeat(600)}`);
  assert.ok(longo.length <= 400 && !longo.includes('\n'), longo.length.toString());
});

test('só a última linha de uma exceção do Python conta (aviso e traceback comum não)', () => {
  for (const ok of ["KeyError: 'empresas'", 'ValueError: boom', 'requests.exceptions.ConnectionError: falhou', 'pyo3_runtime.PanicException: x', 'RuntimeError']) {
    assert.equal(isPythonExceptionLine(ok), true, ok);
  }
  for (const nao of ['<sys>:0: ResourceWarning: unclosed socket', '  File "main.py", line 3, in <module>', 'Traceback (most recent call last):', 'DeprecationWarning: x', 'erro qualquer']) {
    assert.equal(isPythonExceptionLine(nao), false, nao);
  }
});

// O runner de verdade rodando um processo de verdade (um script Python), com serviços de mentira.
async function rodar(script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-erro-'));
  writeFileSync(join(dir, 'robo.py'), script);
  const logs: Array<[string, string]> = [];
  const executionsService = {
    log: async (_id: string, level: string, message: string) => { logs.push([level, message]); },
    updateProgress: async () => undefined,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runner = new ExecutionRunnerService(executionsService as any, {} as any);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (runner as any).runCommandExecution('exec-teste', 'python robo.py', dir);
    return { erro: null as string | null, logs };
  } catch (e) {
    return { erro: (e as Error).message, logs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('processo de verdade: sai com erro e a mensagem é a que o robô declarou', async () => {
  const r = await rodar(`import sys
print('AH_LOG|info|começando', flush=True)
print('AH_LOG|error|Nenhum certificado do CNPJ 13.925.723/0005-77 na pasta. Use a matriz em Empresas.', flush=True)
print('<sys>:0: ResourceWarning: unclosed socket', file=sys.stderr, flush=True)
sys.exit(1)
`);
  assert.equal(r.erro, 'Nenhum certificado do CNPJ 13.925.723/0005-77 na pasta. Use a matriz em Empresas.');
});

test('processo de verdade: sem mensagem do robô, usa a exceção do Python', async () => {
  const r = await rodar(`d = {}
print('AH_LOG|info|vai quebrar', flush=True)
d['empresas']
`);
  assert.equal(r.erro, "KeyError: 'empresas'");
});

test('processo de verdade: sem nenhuma pista, mantém o genérico; e sucesso não é afetado por erro anterior', async () => {
  const sem = await rodar('import sys\nsys.exit(3)\n');
  assert.equal(sem.erro, 'Comando finalizado com codigo 3');
  const ok = await rodar(`print('AH_LOG|error|uma empresa falhou, as outras deram certo', flush=True)\n`);
  assert.equal(ok.erro, null);                      // código 0: terminou bem, mesmo com um erro registrado no meio
});
