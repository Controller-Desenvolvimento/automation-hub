import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { DashboardService } from '../src/dashboard/dashboard.service';
import { WINDOWS_HIDE } from '../src/shared/process-options';

// No Windows, processo de console iniciado pelo hub abria uma janela de prompt na sessão do servidor (um cmd por painel).
// Detalhe que importa para testar: o hub roda SEM console (o PM2 o inicia assim), e só nessa condição os filhos criam janela.
// Um Node iniciado de um terminal herda o console do terminal e seus filhos NÃO abrem janela — por isso o teste de ponta a
// ponta usa um processo auxiliar "desanexado" (sem console), igual ao hub em produção.
const SO_WINDOWS = process.platform === 'win32';

const PS_DETECTOR = String.raw`
param([string]$raizes)
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class Jan {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<uint> Consoles() {
    var r = new List<uint>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (c.ToString() == "ConsoleWindowClass" || c.ToString() == "CASCADIA_HOSTING_WINDOW_CLASS") { uint pid; GetWindowThreadProcessId(h, out pid); r.Add(pid); }
      return true; }, IntPtr.Zero);
    return r; }
}
"@
$todos = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$arvore = New-Object System.Collections.Generic.HashSet[uint32]
foreach ($r in ($raizes -split ',')) { [void]$arvore.Add([uint32]$r) }
do { $antes = $arvore.Count; foreach ($p in $todos) { if ($arvore.Contains([uint32]$p.ParentProcessId)) { [void]$arvore.Add([uint32]$p.ProcessId) } } } while ($arvore.Count -ne $antes)
$visiveis = [Jan]::Consoles() | Where-Object { $arvore.Contains($_) }
Write-Output ("JANELAS=" + @($visiveis).Count)
`;

// Roda sem console (desanexado), inicia `ping` por um shell como o hub inicia os painéis e informa o pid.
const AJUDANTE = `
const { spawn } = require('node:child_process');
const esconder = process.argv[2] === 'esconder';
const filho = spawn('ping -n 30 127.0.0.1', [], { shell: true, windowsHide: esconder, stdio: 'ignore' });
console.log('PID=' + filho.pid);
setInterval(() => {}, 1000);
`;

function janelasDeConsoleVisiveis(pidRaiz: number): number {
  const dir = mkdtempSync(join(tmpdir(), 'jan-'));
  try {
    const script = join(dir, 'janelas.ps1');
    writeFileSync(script, PS_DETECTOR, 'utf8');
    const saida = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-raizes', String(pidRaiz)], { encoding: 'utf8', windowsHide: true });
    const m = /JANELAS=(\d+)/.exec(saida);
    assert.ok(m, `saída inesperada do PowerShell: ${saida}`);
    return Number(m![1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function matar(pid: number | undefined) {
  if (!pid) return;
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true }); } catch { /* já morreu */ }
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Inicia o ajudante sem console, espera o filho dele subir e devolve quantas janelas de console visíveis existem na árvore. */
async function janelasDoAjudante(esconder: boolean): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'ajudante-'));
  const arquivo = join(dir, 'ajudante.js');
  writeFileSync(arquivo, AJUDANTE, 'utf8');
  const ajudante = spawn(process.execPath, [arquivo, esconder ? 'esconder' : 'mostrar'], {
    detached: true,                       // DETACHED_PROCESS: sem console, como o hub iniciado pelo PM2
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const limite = setTimeout(() => reject(new Error('o ajudante não informou o pid')), 10_000);
      ajudante.stdout!.on('data', (d) => { if (/PID=\d+/.test(String(d))) { clearTimeout(limite); resolve(); } });
    });
    await esperar(2000);                  // dá tempo de o cmd criar (ou não) a janela
    return janelasDeConsoleVisiveis(ajudante.pid!);
  } finally {
    matar(ajudante.pid);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a opção de esconder as janelas vem ligada por padrão', () => {
  assert.equal(WINDOWS_HIDE, process.env.HUB_SHOW_CONSOLES !== 'true');
  assert.equal(WINDOWS_HIDE, true);
});

test('o hub inicia painéis com windowsHide (e o taskkill/netstat que ele usa também)', async () => {
  const chamadas: Array<{ cmd: string; opts: Record<string, unknown> }> = [];
  const espiaoSpawn = mock.method(childProcess, 'spawn', (cmd: string, argsOuOpts: unknown, maybeOpts?: unknown) => {
    const opts = (Array.isArray(argsOuOpts) ? maybeOpts : argsOuOpts) as Record<string, unknown>;
    chamadas.push({ cmd: String(cmd), opts: opts ?? {} });
    return { pid: 4242, stdout: null, stderr: null, on: () => undefined, kill: () => true } as never;
  });
  const dir = mkdtempSync(join(tmpdir(), 'painel-spawn-'));
  const db: Record<string, unknown> = {
    id: 'd1', slug: 'painel', type: 'server', streamlitPort: 8595, streamlitStatus: 'stopped',
    serverCommand: 'python server.py {PORT}', serverWorkingDirectory: dir, mainFile: null,
  };
  const prisma = {
    dashboard: {
      findUniqueOrThrow: async () => ({ ...db }),
      update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(db, data); return { ...db }; },
      findMany: async () => [],
    },
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DashboardService(prisma as any);
    await svc.startServer('d1');
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].cmd, 'python server.py 8595');
    assert.equal(chamadas[0].opts.windowsHide, true, 'o painel foi iniciado sem windowsHide: abriria uma janela de prompt');
    assert.equal(chamadas[0].opts.shell, true);
  } finally {
    espiaoSpawn.mock.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ponta a ponta: com windowsHide o filho do hub (sem console) NÃO abre janela', { skip: !SO_WINDOWS }, async () => {
  assert.equal(await janelasDoAjudante(true), 0, 'abriu uma janela de console visível mesmo com windowsHide');
});

// CONTROLE: prova que o detector enxerga a janela quando ela EXISTE (o jeito antigo, sem windowsHide). Abre uma janela por
// ~2 s na tela de quem roda, por isso só roda com TEST_CONSOLE_CONTROL=1.
test('controle: sem windowsHide a janela aparece e o detector a vê', { skip: !SO_WINDOWS || process.env.TEST_CONSOLE_CONTROL !== '1' }, async () => {
  assert.ok((await janelasDoAjudante(false)) >= 1, 'o detector não viu a janela que o jeito antigo cria');
});

// TRAVA para o futuro: toda chamada que inicia processo no hub precisa passar windowsHide, senão o painel/robô/comando
// volta a abrir uma janela de prompt na tela do servidor. Confere o código-fonte (as chamadas com `windowsHide: true` fixo ou
// WINDOWS_HIDE valem).
test('toda chamada que inicia processo em src/ passa windowsHide', () => {
  const { readdirSync, readFileSync, statSync } = require('node:fs') as typeof import('node:fs');
  const raiz = join(__dirname, '..', 'src');
  const arquivos: string[] = [];
  const percorrer = (dir: string) => {
    for (const nome of readdirSync(dir)) {
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) percorrer(caminho);
      else if (caminho.endsWith('.ts')) arquivos.push(caminho);
    }
  };
  percorrer(raiz);

  const chamada = /(?<![\w.])(spawn|spawnSync|execSync|execFileSync|execFile)\s*\(|child_process'\)\.(execSync|spawn|execFileSync)\s*\(/g;
  const sem: string[] = [];
  let total = 0;
  for (const arquivo of arquivos) {
    const texto = readFileSync(arquivo, 'utf8');
    for (const m of texto.matchAll(chamada)) {
      const antes = texto.slice(Math.max(0, m.index! - 40), m.index!);
      if (/(import|from)\s.*$/.test(antes.split('\n').pop() ?? '') && /import\s*\{[^}]*$/.test(antes)) continue;   // linha de import
      total += 1;
      const trecho = texto.slice(m.index!, m.index! + 700);
      const fim = trecho.search(/\n\s*\n|\n  (?:async )?[a-zA-Z_]+\(/);          // até o fim aproximado da chamada
      if (!/windowsHide/.test(fim > 0 ? trecho.slice(0, fim) : trecho)) {
        sem.push(`${arquivo.replace(raiz, 'src')}:${texto.slice(0, m.index!).split('\n').length}`);
      }
    }
  }
  assert.ok(total >= 8, `o teste deveria achar as chamadas de processo do hub (achou ${total})`);
  assert.deepEqual(sem, [], `chamadas que iniciam processo sem windowsHide: ${sem.join(', ')}`);
});
