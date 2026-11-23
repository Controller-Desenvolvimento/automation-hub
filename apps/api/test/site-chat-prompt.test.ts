// Instruções fixas do João (site-chat/system-prompt.ts): o que ele sabe do Hub precisa acompanhar o menu e os textos da tela.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { UserRole } from '@prisma/client';
import { SYSTEM_PROMPT_ADMIN, SYSTEM_PROMPT_BASE, systemPromptFor } from '../src/site-chat/system-prompt';
import { STATUS_LABELS, TYPE_LABELS, URGENCY_LABELS } from '../src/support/support-rules';

type U = Parameters<typeof systemPromptFor>[0];
const u = (role: UserRole, departments: string[] = []) => ({ id: 'x', role, departments }) as unknown as U;

const WEB = join(__dirname, '..', '..', 'web', 'src');
const read = (path: string) => readFileSync(join(WEB, path), 'utf8');

// Rotas do menu lateral, separadas entre o grupo "Administração" e o resto.
function menuRoutes() {
  const shell = read('components/app-shell.tsx');
  const start = shell.indexOf('const navGroups = [');
  const end = shell.indexOf('];', shell.indexOf("label: 'Administração'"));
  assert.ok(start > 0 && end > start, 'não achei o menu (navGroups) em app-shell.tsx');
  const block = shell.slice(start, end);
  const adminAt = block.indexOf("label: 'Administração'");
  const routes = (text: string) => [...text.matchAll(/to: '(\/[^']*)'/g)].map((m) => m[1]);
  return { everyone: routes(block.slice(0, adminAt)), admin: routes(block.slice(adminAt)) };
}

test('toda página do menu está nas instruções do João (página nova no menu = ensinar o João)', () => {
  const { everyone, admin } = menuRoutes();
  assert.ok(everyone.includes('/support') && admin.includes('/robot-health'), 'o leitor do menu deixou de achar as páginas');
  for (const route of everyone) assert.ok(SYSTEM_PROMPT_BASE.includes(`"${route}"`), `falta "${route}" na parte de todos`);
  const adminPrompt = systemPromptFor(u(UserRole.admin));
  for (const route of admin) assert.ok(adminPrompt.includes(`"${route}"`), `falta "${route}" para administradores`);
  // Páginas fora do menu lateral que o João também indica.
  for (const route of ['/support/new', '/executions/:id', '/automation-requests', '/dashboard-requests', '/notifications', '/profile']) {
    assert.ok(SYSTEM_PROMPT_BASE.includes(`"${route}"`), `falta "${route}"`);
  }
});

test('a parte de administradores só vai para administradores e para a Inovação', () => {
  assert.equal(systemPromptFor(u(UserRole.employee, ['fiscal'])), SYSTEM_PROMPT_BASE);
  assert.equal(systemPromptFor(u(UserRole.manager, ['fiscal'])), SYSTEM_PROMPT_BASE);
  for (const user of [u(UserRole.admin), u(UserRole.employee, ['inovacao'])]) {
    const prompt = systemPromptFor(user);
    assert.ok(prompt.includes(SYSTEM_PROMPT_ADMIN));
    // A base continua sendo o começo (cache de prompt da OpenAI).
    assert.ok(prompt.startsWith(SYSTEM_PROMPT_BASE));
  }
  // Para quem não é administrador o João só sabe que essas páginas existem e são de administradores, sem o conteúdo.
  assert.match(SYSTEM_PROMPT_BASE, /"Saúde dos robôs"[^\n]*"Robôs sem ganho"[^\n]*só para administradores/);
  for (const detail of ['"/robot-health"', 'Simular ganhos', 'Insights', 'Capacidade do servidor', 'nota interna', 'notas internas', 'T0/T1/T2']) {
    assert.ok(!SYSTEM_PROMPT_BASE.includes(detail), `"${detail}" é só da parte de administradores`);
  }
});

test('os nomes do Suporte que o João usa são os mesmos da tela', () => {
  const support = read('lib/support.ts');
  const labelsFrom = (name: string) => {
    const block = support.slice(support.indexOf(`export const ${name}`), support.indexOf('};', support.indexOf(`export const ${name}`)));
    return [...block.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
  };
  const expected = [
    ...Object.values(TYPE_LABELS),
    ...Object.values(URGENCY_LABELS),
    ...labelsFrom('SUBJECT_LABELS'),
    ...labelsFrom('URGENCY_HINTS').map((hint) => hint.toLowerCase()),
    // Situações como quem abriu vê: "Aguardando resposta" aparece para ele como "Aguardando você".
    ...Object.values(STATUS_LABELS).filter((label) => label !== 'Aguardando resposta'),
    'Aguardando você',
  ];
  assert.ok(expected.length >= 20);
  for (const label of expected) assert.ok(SYSTEM_PROMPT_BASE.includes(label), `o João não cita "${label}"`);
});

test('os botões citados pelo João existem na tela com o mesmo texto', () => {
  const screens: Array<[string, string[]]> = [
    ['pages/execution-page.tsx', ['Rodar novamente com as mesmas entradas', 'Rodar novamente com a planilha final como entrada', 'Reportar problema', 'Parâmetros']],
    ['pages/support-page.tsx', ['Abrir chamado']],
    ['pages/support-new-page.tsx', ['O que você quer fazer?', 'Sobre o quê?']],
    ['pages/support-ticket-page.tsx', ['Sim, obrigado(a)', 'Ainda acontece (reabrir)', 'Reabrir chamado']],
    ['pages/time-savings-page.tsx', ['Visão geral', 'Execuções', 'Robôs sem ganho']],
    ['components/time-savings/robots-without-gain.tsx', ['Configurar', 'Simular ganhos']],
    ['components/time-savings/gain-simulator.tsx', ['Usar estes tempos na configuração']],
    ['pages/robot-health-page.tsx', ['Gráficos', 'Insights', 'Capacidade do servidor', 'Agendamentos']],
    ['pages/sites-page.tsx', ['Painéis', 'Credenciais']],
  ];
  const prompt = systemPromptFor(u(UserRole.admin));
  for (const [file, texts] of screens) {
    const source = read(file);
    for (const text of texts) {
      assert.ok(source.includes(text), `"${text}" não está mais em ${file}: atualize o João`);
      assert.ok(prompt.includes(text), `o João não cita "${text}"`);
    }
  }
});

test('o João sabe o que não consegue fazer e não promete prazo no Suporte', () => {
  assert.match(SYSTEM_PROMPT_BASE, /NÃO consegue fazer[^\n]*abrir, responder ou encerrar chamados/);
  assert.match(SYSTEM_PROMPT_BASE, /nunca prometa prazo/);
  // A regra antiga ("nunca diga só 'fale com o suporte'") continua, agora apontando o caminho certo.
  assert.match(SYSTEM_PROMPT_BASE, /"Reportar problema" na tela da execução/);
  assert.match(SYSTEM_PROMPT_BASE, /REGRA DE SEGURANÇA — NUNCA PODE SER QUEBRADA/);
});
