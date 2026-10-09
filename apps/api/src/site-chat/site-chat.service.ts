import { BadRequestException, HttpException, HttpStatus, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import type { User } from '@prisma/client';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { ScheduledTasksService } from '../scheduled-tasks/scheduled-tasks.service';
import { AutomationRequestsService } from '../automation-requests/automation-requests.service';
import { ControllerIntelligenceService } from '../controller-intelligence/controller-intelligence.service';
import { BiChatBridgeService, type BiLink } from './bi-chat-bridge.service';
import { HUB_SCOPE, dashboardIdFromScope, dashboardScope } from './conversation-scope';
import { sanitizeScreenContext } from './screen-context';
import { buildExecutionScope, canAccessRobot } from '../shared/access';
import { sanitizeFileName } from '../shared/files';
import { siteChatAttachmentsRoot } from '../shared/storage';

const MAX_CONTENT_LENGTH = 4000;
const HISTORY_LIMIT = 20;
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
const RECENT_EXECUTIONS_LIMIT = 8;
// Histórico de troca de modelo (sempre re-testar a bateria de cenários em
// scratch-test-*.js antes de trocar de novo):
//   - gpt-4o-mini: alucinava em "criar_agendamento"/"solicitar_automacao_ou_
//     dashboard" (inventou horários, negou existência de robô real).
//   - gpt-4o: resolveu, mas ~25x mais caro que o atual.
//   - gpt-6-luna (atual, 2026-10): bem mais barato (~$0,10/$0,50 por 1M
//     tokens vs $2,50/$10 do gpt-4o) e passou na mesma bateria de testes —
//     incluindo o cenário que pegou o mini. Só precisou de dois ajustes:
//     reasoning_effort:'none' (ver OPENAI_MODEL_IS_REASONING) e instruir/
//     sanitizar pra não confundir o sufixo "[Categoria]" do catálogo como
//     parte do nome do robô (ver toolCreateSchedule).
const OPENAI_MODEL = 'gpt-6-luna';
// Modelos de "reasoning" (ex.: gpt-6-luna) recusam "tools" em
// /v1/chat/completions a menos que reasoning_effort seja explicitamente
// "none" — mas gpt-4o (não-reasoning) recusa esse mesmo parâmetro com 400.
// Ajustar junto ao trocar OPENAI_MODEL.
const OPENAI_MODEL_IS_REASONING = true;
const OPENAI_TIMEOUT_MS = 30 * 1000;
const MAX_TOKENS = 700;
const MAX_TOOL_ROUNDS = 3;

const EXPORT_REPORT_TYPES = ['balancete', 'dre', 'balanco', 'razao', 'faturamento', 'livrofiscal'] as const;
// Medido: ~5s por dia no razão com todas as contas (1 semana = 46s, 1 mês passou
// de 90s e derrubou o login do serviço deles por alguns minutos).
const RAZAO_MAX_EXPORT_DAYS = 3;

function formatTodayForPrompt(now = new Date()): string {
  const weekday = now.toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'America/Fortaleza' });
  const date = now.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Fortaleza' });
  const iso = date.split('/').reverse().join('-');
  return `${weekday}, ${date} (${iso})`;
}

const REPORT_LABELS: Record<string, string> = {
  balancete: 'Balancete',
  dre: 'DRE',
  balanco: 'Balanço',
  razao: 'Razão',
  faturamento: 'Faturamento',
  livrofiscal: 'Livro Fiscal',
};

// Nome amigável pro download: o do serviço traz código interno da empresa (ex.: faturamento_976_0_102025-102026.pdf).
function friendlyExportName(tipo: string, formato: 'xlsx' | 'pdf', ano: number, mes: number, dtIni?: string, dtFim?: string): string {
  const label = REPORT_LABELS[tipo] ?? 'Relatório';
  const my = (iso: string) => `${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
  const periodo = dtIni && dtFim ? (my(dtIni) === my(dtFim) ? `${dtIni.slice(8, 10)}-${my(dtIni)} a ${dtFim.slice(8, 10)}-${my(dtFim)}` : `${my(dtIni)} a ${my(dtFim)}`) : `${String(mes).padStart(2, '0')}-${ano}`;
  return `${label} ${periodo}.${formato}`;
}

// Meses fechados: o mês corrente não conta (ainda está aberto).
function closedMonthsHint(now = new Date()): string {
  const [d, m, y] = now.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Fortaleza' }).split('/').map(Number);
  void d;
  const iso = (year: number, month: number, day: number) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const lastDay = new Date(Date.UTC(y, m - 1, 0));
  const fim = iso(lastDay.getUTCFullYear(), lastDay.getUTCMonth() + 1, lastDay.getUTCDate());
  const parts = [3, 6, 12].map((n) => {
    const start = new Date(Date.UTC(y, m - 1 - n, 1));
    return `últimos ${n} meses = ${iso(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)} a ${fim}`;
  });
  return `${parts.join('; ')}; mês passado = ${iso(lastDay.getUTCFullYear(), lastDay.getUTCMonth() + 1, 1)} a ${fim}`;
}

function parseIsoDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) ? null : time;
}

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_MESSAGES = 30;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(userId: string) {
  const now = Date.now();
  if (rateLimitMap.size > 500) {
    for (const [key, value] of rateLimitMap) {
      if (value.resetAt < now) rateLimitMap.delete(key);
    }
  }
  const entry = rateLimitMap.get(userId);
  if (!entry || entry.resetAt < now) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return;
  }
  if (entry.count >= RATE_LIMIT_MAX_MESSAGES) {
    throw new HttpException('Muitas mensagens em pouco tempo. Aguarde alguns minutos e tente de novo.', HttpStatus.TOO_MANY_REQUESTS);
  }
  entry.count += 1;
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'na fila',
  running: 'rodando',
  success: 'sucesso',
  error: 'erro',
  canceled: 'cancelada',
};

const SENSITIVE_FIELD_PATTERN = /senha|password|pin\b|token|secret|credencial/i;

const SYSTEM_PROMPT_BASE = `Você é o assistente virtual do Automation Hub, um sistema interno da empresa usado por gestores e funcionários para monitorar e executar automações (robôs RPA).

O que você deve saber sobre o site — use os nomes exatos que aparecem no menu, e SEMPRE indique a página certa em vez de inventar/generalizar uma resposta:
- "/" (Dashboard) — visão geral: robôs favoritos, execuções recentes, atalhos.
- "/robots" (Robôs) — catálogo de robôs disponíveis. Cada robô abre em "/robots/:id" com o formulário de execução (parâmetros e arquivos, quando aplicável).
- "/executions/:id" — acompanhamento em tempo real de uma execução específica (progresso, logs).
- "/history" (Histórico) — lista de execuções passadas do usuário (ou do departamento, se for gestor; todas, se admin).
- "/results" (Resultados) — é AQUI que ficam os arquivos gerados pelas automações (PDFs, planilhas etc.), agrupados por data, com botão de download. Sempre que alguém perguntar "onde ficam os arquivos" ou "onde eu baixo o resultado", a resposta é essa página — nunca invente caminho de pasta, rede ou servidor.
- "/schedules" (Agendamentos) — agendamentos recorrentes (uma vez, diário, semanal, mensal) de robôs.
- "/time-savings" (Tempo ganho) — relatório de tempo economizado pelas automações, com filtros por período, robô, usuário e departamento.
- "/sites" (Sites) — tem 4 abas: "Sistema" (links de sistemas internos), "BI" (relatórios Power BI), "Painéis" (dashboards internos do Hub) e "Credenciais" (credenciais compartilhadas, conforme permissão).
- "/automation-requests" (Solicitar automação) e "/dashboard-requests" (Solicitar dashboard) — formulários pra pedir uma automação ou dashboard que ainda não existe (você também consegue preencher isso pelo chat, ver ferramentas abaixo). Administradores também têm "/admin/quadro" (Quadro de pedidos), uma visão kanban desses pedidos pra triagem.
- "/notifications" (Notificações) — avisos de conclusão de execuções agendadas e de atualização nos pedidos de automação/dashboard.
- "/profile" (Perfil) — dados da própria conta.
- "/settings" (Configurações, só admin) — gestão de robôs, usuários, painéis (dashboards) e credenciais compartilhadas.
- "/docs" (Dev Docs, só admin) — documentação técnica de integração de robôs.
- Toda execução tem status: na fila, rodando, sucesso, erro ou cancelada. Dá pra cancelar uma execução em andamento, e reiniciar uma execução com erro ou cancelada usando os mesmos parâmetros de entrada.
- Existem 3 perfis de usuário: "employee" (só vê e executa as próprias execuções/agendamentos), "manager" (vê também as do seu departamento) e "admin" (acesso total, incluindo Configurações).
- Cadastro de novo usuário fica inativo até um admin ativar em Configurações.

O que você pode FAZER (não só responder) — via as ferramentas disponíveis:
- Criar um agendamento recorrente (ou único) para um robô que já existe no catálogo, usando "criar_agendamento". Antes de chamar, converse com o usuário pra reunir: qual robô, frequência (uma vez/diário/semanal/mensal), horário(s), dia da semana (se semanal) ou dia do mês (se mensal), e os parâmetros não sensíveis que o robô pedir (veja os campos de cada robô na lista abaixo). SEMPRE confirme um resumo com o usuário antes de efetivamente criar.
- Registrar um pedido de nova automação ou de novo dashboard (quando o usuário quer algo que não existe ainda), usando "solicitar_automacao_ou_dashboard". Pergunte o que precisa ser feito, pra que serve, e (se for automação) se envolve login, certificado digital ou captcha, antes de registrar. SEMPRE confirme com o usuário antes de registrar.
- Quando alguém perguntar "existe automação pra X" e a resposta for não, ofereça ativamente registrar esse pedido pra ela — não espere ser pedido.
- Consultar relatórios contábeis REAIS de uma empresa (dados de verdade do Athenas, via "consultar_balancete", "consultar_balanco", "consultar_dre", "consultar_razao", "consultar_faturamento" e "consultar_livro_fiscal"):
  - "consultar_balancete": exige empresa + ano + mês (os três — nunca chame só com ano, pergunte o mês se faltar). Desambigua nome de empresa sozinho (mostra opções, ver abaixo).
  - "consultar_balanco": exige empresa + período (dtIni/dtFim, formato YYYY-MM-DD). Desambigua nome de empresa sozinho.
  - "consultar_dre": exige empresa + ano (mês é opcional — sem mês, traz o ano inteiro). Aceita nome ou código; desambigua sozinho como as demais.
  - "consultar_razao", "consultar_faturamento", "consultar_livro_fiscal": aceitam o código numérico ("empresaCodigo") OU o nome ("empresaNome") — se o usuário só disser o nome, passe o nome direto; o sistema identifica a empresa sozinho (e devolve "ambiguous" com opções se houver mais de uma). Não precisa consultar o balancete antes só pra descobrir o código.
  - Regra geral pra todas: se vier "status: ambiguous", mostre as opções de empresa retornadas e pergunte qual delas — depois chame de novo com o "codigo" escolhido em "empresaCodigo". Se vier "status: empty", diga que não há dados nesse período. Se vier "status: error" (ou um "error" direto), mostre a mensagem pro usuário (geralmente é parâmetro faltando/inválido) — nunca troque isso por uma resposta genérica de "tente mais tarde" ou "contate o suporte". Se o usuário mencionar "matriz" ou "filial X" junto do nome da empresa (ex.: "Kalzone Matriz"), tente primeiro SEM esse termo (só "Kalzone") — normalmente não faz parte do nome cadastrado. NUNCA calcule, estime ou complete valores por conta própria — use exatamente o "resumo"/dado que a ferramenta devolve; se pedirem um detalhe que não veio na resposta (ex.: uma conta específica do balancete), diga que só tem o resumo geral por enquanto.
- Gerar o arquivo (Excel ou PDF) de um relatório já consultado, usando "exportar_relatorio" — funciona pra balancete, DRE, balanço, razão, faturamento e livro fiscal (pergunte o formato se o usuário não disser; xlsx é o padrão mais comum). Balancete e DRE pedem ano e mês; os demais pedem período (data inicial e final). O razão só exporta períodos de até 3 dias (é uma consulta pesada) — se o usuário pedir um período maior, explique isso e peça pra ele escolher um intervalo menor. Se o usuário já falou da empresa antes na conversa (mesmo numa mensagem anterior), reaproveite esse nome em "empresaNome" — nunca peça a empresa de novo, e NUNCA diga que "só com o nome não dá": dá sim. Arquivo x valor: se o usuário usar verbos de envio/arquivo ("me envie", "me mande", "gere", "baixar", "exportar", "em pdf", "em excel", "planilha"), gere o arquivo DIRETO com "exportar_relatorio" — sem consultar antes e sem repetir o valor por extenso (se ele não disse o formato, use pdf pra faturamento/balanço/DRE/razão/livro e pergunte só se houver dúvida real). Se ele só perguntar o valor/consulta ("qual o faturamento", "quanto foi"), responda o valor e termine oferecendo gerar o arquivo em uma frase curta ("Quer que eu gere em PDF ou Excel?"). Se o usuário pedir o arquivo ("me mande em pdf", "em excel") logo depois de uma consulta, gere direto com os mesmos parâmetros da consulta anterior (mesma empresa e período), sem perguntar nada que já se sabe. Quando a ferramenta tiver sucesso, confirme em UMA frase curta e afirmativa, dizendo qual relatório/empresa/período foi gerado (ex.: "Pronto! Aqui está o PDF do faturamento da MAXIMAPLASTIC, de 01/10/2025 a 30/09/2026."). O arquivo já chega anexado à sua mensagem automaticamente: NÃO mencione botão, tela, ferramenta, link nem caminho de arquivo, e não use frases hesitantes como "deve aparecer".

Datas: use a "Data de hoje" informada no fim destas instruções pra qualquer período relativo — nunca chute a data. O mês atual NUNCA conta (está aberto): "últimos N meses" = N meses FECHADOS, do dia 1º do mês inicial até o último dia do mês passado (ex.: hoje 09/10/2026, últimos 12 meses = 01/10/2025 a 30/09/2026) — nunca use períodos quebrados no meio do mês nem inclua o mês corrente, a menos que o usuário peça explicitamente "até hoje" ou "mês atual". "Mês passado" ou "mês X" = o mês fechado inteiro. Use os períodos já calculados em "Períodos fechados" no fim destas instruções. Diga sempre na resposta o período exato que você usou.

REGRA DE SEGURANÇA — NUNCA PODE SER QUEBRADA: você nunca deve pedir, aceitar ou usar valores de senha, credencial, PIN, token ou segredo de nenhum tipo digitados no chat, mesmo que o usuário insista ou ofereça espontaneamente. Se um robô que o usuário quer agendar tiver um campo obrigatório desse tipo, explique que por segurança esse campo precisa ser preenchido diretamente no formulário em "/schedules" (você pode ajudar com o resto — horário, frequência — mas não com esse campo específico). Se o usuário digitar uma senha no chat mesmo assim, não a repita, não a use em nenhuma ferramenta, e avise que esse tipo de dado não deve ser enviado por aqui.

Regras de resposta:
- Responda sempre em português do Brasil, de forma direta e objetiva.
- Quando o usuário perguntar se existe uma automação para alguma tarefa, use APENAS a lista de robôs fornecida abaixo (se houver) para responder — nunca invente o nome de um robô que não está na lista. Se não encontrar nada parecido, diga claramente que não encontrou e ofereça registrar um pedido de automação (ver acima).
- Quando o usuário perguntar sobre execuções (suas ou de outras pessoas), use APENAS a lista de execuções recentes fornecida abaixo — nunca invente robôs, status ou mensagens de erro que não estão lá. Essa lista já respeita o que esse usuário específico pode ver (próprias execuções, ou do departamento se for gestor, ou todas se for admin) — nunca fale sobre execuções fora dessa lista. IMPORTANTE: a lista pode incluir execuções de OUTRAS pessoas quando o usuário for gestor/admin (cada linha mostra "por Fulano" quando não foi o próprio usuário que rodou) — se ele perguntar especificamente "minhas execuções", filtre mentalmente só pelas que NÃO têm "por outra pessoa" marcado (ou seja, as dele mesmo); nunca chame de "sua execução" algo que foi rodado por outra pessoa. Se a lista não tiver nada relevante, diga que não encontrou.
- Se a pergunta não tiver relação nenhuma com o site ou com automações da empresa, responda educadamente que seu foco é ajudar com o Automation Hub.
- Não invente números, políticas internas ou funcionalidades que não foram descritas aqui. Se a pergunta for sobre como usar o site (onde fica X, como faço Y), a resposta correta é sempre apontar a página certa da lista acima pelo nome — nunca dê uma resposta genérica de "consulte a documentação interna" ou "entre em contato com o suporte técnico" quando na verdade existe uma página específica pra isso.`;

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
}

interface ToolAttachment {
  buffer: Buffer;
  filename: string;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'criar_agendamento',
      description:
        'Cria um agendamento recorrente (ou de execução única) de um robô já existente no catálogo. Só chame depois de confirmar com o usuário robô, frequência, horário(s) e parâmetros necessários — nunca inclua senha/credencial em "parameters".',
      parameters: {
        type: 'object',
        properties: {
          robotName: {
            type: 'string',
            description:
              'Nome exato do robô, como aparece no catálogo — SEM o sufixo de categoria entre colchetes (ex.: "[Inovação]", "[Fiscal]"). Isso é só a categoria, nunca faz parte do nome real.',
          },
          name: { type: 'string', description: 'Nome curto pra identificar esse agendamento.' },
          frequency: { type: 'string', enum: ['once', 'daily', 'weekly', 'monthly'] },
          timesOfDay: { type: 'array', items: { type: 'string' }, description: 'Horário(s) no formato HH:mm, ex: ["08:00"].' },
          startDate: { type: 'string', description: 'Data no formato YYYY-MM-DD. Obrigatória se frequency="once".' },
          dayOfWeek: { type: 'integer', description: '0=domingo .. 6=sábado. Obrigatório se frequency="weekly".' },
          dayOfMonth: { type: 'integer', description: '1 a 31. Obrigatório se frequency="monthly".' },
          parameters: { type: 'object', description: 'Parâmetros não sensíveis exigidos pelo robô (nunca senha/credencial).' },
          notes: { type: 'string' },
        },
        required: ['robotName', 'name', 'frequency', 'timesOfDay'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'solicitar_automacao_ou_dashboard',
      description:
        'Registra um pedido de nova automação ou novo dashboard pro time de Inovação avaliar. Só chame depois de confirmar os detalhes com o usuário.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['automation', 'dashboard'] },
          title: { type: 'string', description: 'Título curto do pedido.' },
          description: { type: 'string', description: 'O que precisa ser feito e pra que serve — obrigatório.' },
          systemName: { type: 'string', description: 'Sistema/portal envolvido, se houver.' },
          portalUrl: { type: 'string' },
          urgency: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
          cadence: { type: 'string', enum: ['once', 'daily', 'weekly', 'monthly'], description: 'Com que frequência isso precisaria rodar (só faz sentido pra automação).' },
          requiresLogin: { type: 'boolean' },
          requiresCertificate: { type: 'boolean' },
          requiresCaptcha: { type: 'boolean' },
        },
        required: ['kind', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_balancete',
      description:
        'Consulta o balancete contábil real de uma empresa (dados do ERP Athenas via Controller Intelligence). Use quando alguém pedir o balancete de uma empresa/período. O endpoint exige ano E mês — nunca chame sem mês, pergunte ao usuário antes. Se a resposta vier "ambiguous", apresente as opções de empresa e pergunte qual delas antes de tentar de novo com o código exato.',
      parameters: {
        type: 'object',
        properties: {
          empresaNome: { type: 'string', description: 'Nome ou parte do nome da empresa (use isso na primeira tentativa).' },
          empresaCodigo: { type: 'integer', description: 'Código numérico exato da empresa — use depois que o usuário escolher entre opções ambíguas.' },
          ano: { type: 'integer', description: 'Ano de referência.' },
          mes: { type: 'integer', description: 'Mês de referência (1-12) — obrigatório, pergunte ao usuário se ele não disser.' },
        },
        required: ['ano', 'mes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_balanco',
      description:
        'Consulta o balanço patrimonial real de uma empresa (dados do ERP Athenas). Use quando alguém pedir o balanço de uma empresa/período. Exige o período (dt_ini/dt_fim), não ano/mês. Se vier "ambiguous", apresente as opções de empresa e pergunte qual delas.',
      parameters: {
        type: 'object',
        properties: {
          empresaNome: { type: 'string', description: 'Nome ou parte do nome da empresa (use isso na primeira tentativa).' },
          empresaCodigo: { type: 'integer', description: 'Código numérico exato da empresa — use depois de desambiguar.' },
          dtIni: { type: 'string', description: 'Data inicial do período, formato YYYY-MM-DD. Se o usuário mencionar um mês/ano (ex.: "dezembro de 2025"), calcule você mesmo o primeiro dia desse mês — não precisa perguntar a data exata.' },
          dtFim: { type: 'string', description: 'Data final do período, formato YYYY-MM-DD. Se o usuário mencionar um mês/ano, calcule você mesmo o último dia desse mês.' },
        },
        required: ['dtIni', 'dtFim'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_dre',
      description:
        'Consulta a DRE (Demonstrativo de Resultado) real de uma empresa. Use quando alguém pedir a DRE de uma empresa/período. Ano é obrigatório; mês é opcional (omitir = ano inteiro). Aceita o código numérico OU o nome da empresa (o sistema identifica sozinho; se houver mais de uma, devolve "ambiguous" com opções).',
      parameters: {
        type: 'object',
        properties: {
          empresaNome: { type: 'string', description: 'Nome ou parte do nome da empresa.' },
          empresaCodigo: { type: 'integer', description: 'Código numérico exato da empresa (preferível — esse endpoint não desambigua nome).' },
          ano: { type: 'integer', description: 'Ano de referência.' },
          mes: { type: 'integer', description: 'Mês de referência (1-12). Se omitido, considera o ano inteiro.' },
        },
        required: ['ano'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_razao',
      description:
        'Consulta o razão contábil real de uma empresa (lançamentos detalhados). Use quando alguém pedir o razão/extrato de lançamentos de uma empresa/período. Aceita o código numérico OU o nome da empresa (o sistema identifica sozinho).',
      parameters: {
        type: 'object',
        properties: {
          empresaCodigo: { type: 'integer', description: 'Código numérico da empresa, se o usuário informou. Se disser algo como "empresa 16" ou "código 16", 16 JÁ É esse código — extraia o número diretamente.' },
          empresaNome: { type: 'string', description: 'Nome ou parte do nome da empresa — use quando não houver código.' },
          anoFiscal: { type: 'integer', description: 'Ano fiscal de referência.' },
          dtIni: { type: 'string', description: 'Data inicial do período, formato YYYY-MM-DD. Se o usuário mencionar um mês/ano (ex.: "dezembro de 2025"), calcule você mesmo o primeiro dia desse mês — não precisa perguntar a data exata.' },
          dtFim: { type: 'string', description: 'Data final do período, formato YYYY-MM-DD. Se o usuário mencionar um mês/ano, calcule você mesmo o último dia desse mês.' },
        },
        required: ['anoFiscal', 'dtIni', 'dtFim'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_faturamento',
      description:
        'Consulta o faturamento real de uma empresa (receita bruta e tributos: Simples, IRPJ, ICMS, ISS, PIS/COFINS) por período. Aceita o código numérico OU o nome da empresa (o sistema identifica sozinho).',
      parameters: {
        type: 'object',
        properties: {
          empresaCodigo: { type: 'integer', description: 'Código numérico da empresa, se o usuário informou. Se disser algo como "empresa 16" ou "código 16", 16 JÁ É esse código — extraia o número diretamente.' },
          empresaNome: { type: 'string', description: 'Nome ou parte do nome da empresa — use quando não houver código.' },
          dtIni: { type: 'string', description: 'Data inicial do período, formato YYYY-MM-DD. Se o usuário mencionar um mês/ano (ex.: "dezembro de 2025"), calcule você mesmo o primeiro dia desse mês — não precisa perguntar a data exata.' },
          dtFim: { type: 'string', description: 'Data final do período, formato YYYY-MM-DD. Se o usuário mencionar um mês/ano, calcule você mesmo o último dia desse mês.' },
        },
        required: ['dtIni', 'dtFim'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_livro_fiscal',
      description:
        'Consulta o livro fiscal real de uma empresa (notas fiscais emitidas/recebidas) por período. Aceita o código numérico OU o nome da empresa (o sistema identifica sozinho).',
      parameters: {
        type: 'object',
        properties: {
          empresaCodigo: { type: 'integer', description: 'Código numérico da empresa, se o usuário informou. Se disser algo como "empresa 16" ou "código 16", 16 JÁ É esse código — extraia o número diretamente.' },
          empresaNome: { type: 'string', description: 'Nome ou parte do nome da empresa — use quando não houver código.' },
          dtIni: { type: 'string', description: 'Data inicial do período, formato YYYY-MM-DD. Se o usuário mencionar um mês/ano (ex.: "dezembro de 2025"), calcule você mesmo o primeiro dia desse mês — não precisa perguntar a data exata.' },
          dtFim: { type: 'string', description: 'Data final do período, formato YYYY-MM-DD. Se o usuário mencionar um mês/ano, calcule você mesmo o último dia desse mês.' },
          tipoRelatorio: {
            type: 'string',
            enum: ['00', '01', '02', '10', '11'],
            description: '00=saídas (padrão), 01=entradas, 02=inconsistências, 10=serviços prestados, 11=serviços tomados.',
          },
        },
        required: ['dtIni', 'dtFim'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exportar_relatorio',
      description:
        'Gera um arquivo (Excel ou PDF) de um relatório pra download. Aceita o código numérico OU o nome da empresa (o sistema identifica sozinho) — se o usuário já citou a empresa antes na conversa, reaproveite o nome. "balancete" e "dre" exigem ano e mês. "balanco", "razao", "faturamento" e "livrofiscal" exigem o período (dtIni e dtFim); o "razao" só aceita até 3 dias de período.',
      parameters: {
        type: 'object',
        properties: {
          tipoRelatorio: { type: 'string', enum: ['balancete', 'dre', 'balanco', 'razao', 'faturamento', 'livrofiscal'] },
          empresaCodigo: { type: 'integer', description: 'Código numérico da empresa, se o usuário informou.' },
          empresaNome: { type: 'string', description: 'Nome ou parte do nome da empresa — use quando não houver código.' },
          ano: { type: 'integer', description: 'Obrigatório pra "balancete" e "dre". Nos demais, se omitido, é deduzido do ano de dtFim.' },
          mes: { type: 'integer', description: 'Obrigatório pra "balancete" e "dre". Nos demais, se omitido, é deduzido do mês de dtFim.' },
          dtIni: { type: 'string', description: 'Data inicial YYYY-MM-DD. Obrigatória pra balanco, razao, faturamento e livrofiscal. Se o usuário citar só um mês/ano, calcule o primeiro dia.' },
          dtFim: { type: 'string', description: 'Data final YYYY-MM-DD. Obrigatória pra balanco, razao, faturamento e livrofiscal. Se o usuário citar só um mês/ano, calcule o último dia.' },
          formato: { type: 'string', enum: ['xlsx', 'pdf'] },
        },
        required: ['tipoRelatorio', 'formato'],
      },
    },
  },
] as const;

@Injectable()
export class SiteChatService {
  private readonly logger = new Logger(SiteChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledTasksService: ScheduledTasksService,
    private readonly automationRequestsService: AutomationRequestsService,
    private readonly controllerIntelligenceService: ControllerIntelligenceService,
    private readonly biBridge: BiChatBridgeService,
  ) {}

  async listMessages(userId: string, scope: string = HUB_SCOPE) {
    const cutoff = new Date(Date.now() - HISTORY_TTL_MS);
    return this.prisma.siteChatMessage.findMany({
      where: { userId, scope, createdAt: { gte: cutoff } },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { id: true, role: true, content: true, createdAt: true, attachmentName: true },
    });
  }

  async getAttachment(userId: string, messageId: string) {
    const message = await this.prisma.siteChatMessage.findUnique({ where: { id: messageId } });
    if (!message || message.userId !== userId || !message.attachmentPath || !message.attachmentName) {
      return null;
    }
    return { path: message.attachmentPath, name: message.attachmentName };
  }

  // Limpa só a conversa indicada (a do hub ou a de um painel), não as outras.
  async clearMessages(userId: string, scope: string = HUB_SCOPE) {
    await this.prisma.siteChatMessage.deleteMany({ where: { userId, scope } });
    const dashboardId = dashboardIdFromScope(scope);
    if (dashboardId) this.biBridge.forgetThread(userId, dashboardId);
    return { success: true };
  }

  async sendMessage(user: User, content: string) {
    const { userMessage, messages } = await this.prepareTurn(user, content);
    const { text, usage, attachment } = await this.converse(user, messages);
    const assistantMessage = await this.persistAssistant(user.id, text, usage, attachment);
    return { userMessage, assistantMessage };
  }

  async streamMessage(
    user: User,
    content: string,
    onDelta: (text: string) => void,
    options?: { siteId?: string; dashboardId?: string; screen?: unknown; onProgress?: (text: string) => void; signal?: AbortSignal },
  ) {
    // Usuário olhando um BI vinculado a um painel, ou o próprio painel, em "Ver":
    // a pergunta vai direto pro chat de IA do painel. Sem vínculo/permissão,
    // segue o fluxo normal.
    if (options?.dashboardId || options?.siteId) {
      const link = options.dashboardId
        ? await this.biBridge.resolveDashboardLink(user, options.dashboardId)
        : await this.biBridge.resolveLink(user, options.siteId as string);
      if (link) return this.streamBiMessage(user, content, link, onDelta, options);
    }

    const { userMessage, messages } = await this.prepareTurn(user, content);
    const { text, usage, attachment } = await this.converse(user, messages, onDelta);
    const assistantMessage = await this.persistAssistant(user.id, text, usage, attachment);
    return { userMessage, assistantMessage };
  }

  private async streamBiMessage(
    user: User,
    content: string,
    link: BiLink,
    onDelta: (text: string) => void,
    options: { screen?: unknown; onProgress?: (text: string) => void; signal?: AbortSignal },
  ) {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new BadRequestException('Mensagem vazia.');
    }
    if (trimmed.length > MAX_CONTENT_LENGTH) {
      throw new BadRequestException(`Mensagem muito longa (máximo ${MAX_CONTENT_LENGTH} caracteres).`);
    }
    checkRateLimit(user.id);

    const text = await this.biBridge.ask({
      user,
      link,
      question: trimmed,
      screen: sanitizeScreenContext(options.screen),
      onDelta,
      onProgress: options.onProgress,
      signal: options.signal,
    });

    // Só grava depois da resposta: se o painel falhar, não sobra uma pergunta
    // sem resposta no histórico (o chat restaura o texto digitado).
    const scope = dashboardScope(link.dashboardId);
    const userMessage = await this.prisma.siteChatMessage.create({
      data: { userId: user.id, role: 'user', content: trimmed, scope },
    });
    const assistantMessage = await this.persistAssistant(user.id, text, {}, undefined, scope);
    return { userMessage, assistantMessage };
  }

  private async persistAssistant(userId: string, text: string, usage: TokenUsage, attachment?: ToolAttachment, scope: string = HUB_SCOPE) {
    const message = await this.prisma.siteChatMessage.create({
      data: { userId, role: 'assistant', content: text, scope, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens },
    });
    if (!attachment) return message;

    try {
      const safeName = sanitizeFileName(attachment.filename) || 'relatorio.xlsx';
      const dir = join(siteChatAttachmentsRoot, message.id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, safeName), attachment.buffer);
      return await this.prisma.siteChatMessage.update({
        where: { id: message.id },
        data: { attachmentPath: join('site-chat-attachments', message.id, safeName), attachmentName: safeName },
      });
    } catch (err) {
      this.logger.error(`Falha ao salvar anexo da mensagem ${message.id}: ${err instanceof Error ? err.message : String(err)}`);
      return message;
    }
  }

  private async prepareTurn(user: User, content: string) {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new BadRequestException('Mensagem vazia.');
    }
    if (trimmed.length > MAX_CONTENT_LENGTH) {
      throw new BadRequestException(`Mensagem muito longa (máximo ${MAX_CONTENT_LENGTH} caracteres).`);
    }
    checkRateLimit(user.id);

    const cutoff = new Date(Date.now() - HISTORY_TTL_MS);
    const history = await this.prisma.siteChatMessage.findMany({
      // Só a conversa do hub: o que foi falado com o chat de um painel não entra no contexto do modelo do hub.
      where: { userId: user.id, scope: HUB_SCOPE, createdAt: { gte: cutoff } },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
    });
    history.reverse();

    const userMessage = await this.prisma.siteChatMessage.create({
      data: { userId: user.id, role: 'user', content: trimmed },
    });

    const systemPrompt = await this.buildSystemPrompt(user);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((m): ChatMessage => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      { role: 'user', content: trimmed },
    ];

    return { userMessage, messages };
  }

  private async buildSystemPrompt(user: User): Promise<string> {
    const executionScope = buildExecutionScope(user);
    const [robots, executions] = await Promise.all([
      this.prisma.robot.findMany({
        where: { isActive: true },
        select: { name: true, summary: true, description: true, category: true, schema: true, allowedDepartments: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.execution.findMany({
        where: executionScope ? { AND: [executionScope] } : undefined,
        orderBy: { createdAt: 'desc' },
        take: RECENT_EXECUTIONS_LIMIT,
        select: {
          status: true,
          errorMessage: true,
          currentStep: true,
          createdAt: true,
          finishedAt: true,
          robot: { select: { name: true } },
          user: { select: { name: true } },
        },
      }),
    ]);

    let prompt = SYSTEM_PROMPT_BASE;

    const visibleRobots = robots.filter((r) => canAccessRobot(user, { allowedDepartments: r.allowedDepartments }));
    if (visibleRobots.length > 0) {
      const catalog = visibleRobots
        .map((r) => {
          const desc = r.summary || r.description || '';
          const cat = r.category ? ` [${r.category}]` : '';
          const fieldsSummary = describeRobotFields(r.schema);
          return `- ${r.name}${cat}${desc ? `: ${desc}` : ''}${fieldsSummary ? `\n  Campos: ${fieldsSummary}` : ''}`;
        })
        .join('\n');
      prompt += `\n\nLista de robôs (automações) disponíveis para este usuário:\n${catalog}`;
    }

    if (executions.length > 0) {
      const recent = executions
        .map((e) => {
          const label = STATUS_LABELS[e.status] ?? e.status;
          const when = e.createdAt.toISOString().slice(0, 16).replace('T', ' ');
          const detail = e.status === 'error' && e.errorMessage ? ` — erro: ${e.errorMessage}` : e.currentStep ? ` — ${e.currentStep}` : '';
          const who = e.user?.name ? ` (por ${e.user.name})` : '';
          return `- ${e.robot.name}: ${label} (${when})${who}${detail}`;
        })
        .join('\n');
      prompt += `\n\nExecuções recentes visíveis para este usuário (mais recente primeiro):\n${recent}`;
    }

    // No fim de propósito: muda todo dia, e o início do prompt (estático)
    // continua elegível pro cache de prompt da OpenAI.
    prompt += `\n\nData de hoje: ${formatTodayForPrompt()}.`;

    return prompt;
  }

  // Executa a ferramenta pedida pelo modelo e devolve o resultado como texto
  // (JSON) pra virar uma mensagem role:"tool" na próxima chamada. Erros de
  // validação/permissão viram um {error: "..."} — nunca uma exceção que
  // derrubaria a conversa inteira.
  //
  // `terminalMessage`, quando presente, é um texto já pronto pro usuário
  // (erro claro, "não há dados" etc.) — nesses casos o `converse()` pula a
  // segunda chamada ao modelo (que só reformularia esse texto, gastando
  // tokens à toa) e devolve `terminalMessage` direto. Casos que precisam de
  // interpretação/continuidade (ex.: lista de empresas ambíguas, resumo de
  // balancete) não setam isso, e seguem o fluxo normal.
  private async executeTool(
    user: User,
    toolName: string,
    rawArgs: string,
  ): Promise<{ content: string; terminalMessage?: string; attachment?: ToolAttachment }> {
    let args: Record<string, unknown>;
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      const message = 'Argumentos inválidos recebidos pela ferramenta.';
      return { content: JSON.stringify({ error: message }), terminalMessage: message };
    }

    try {
      if (toolName === 'criar_agendamento') {
        const result = await this.toolCreateSchedule(user, args);
        return { content: JSON.stringify(result), terminalMessage: 'error' in result ? result.error : undefined };
      }
      if (toolName === 'solicitar_automacao_ou_dashboard') {
        const result = await this.toolCreateRequest(user, args);
        return { content: JSON.stringify(result), terminalMessage: 'error' in result ? result.error : undefined };
      }
      if (toolName === 'consultar_balancete') {
        const result = await this.toolConsultarBalancete(args);
        return { content: JSON.stringify(result), terminalMessage: this.reportTerminalMessage(result) };
      }
      if (toolName === 'consultar_balanco') {
        const result = await this.toolConsultarBalanco(args);
        return { content: JSON.stringify(result), terminalMessage: this.reportTerminalMessage(result) };
      }
      if (toolName === 'consultar_dre') {
        const result = await this.toolConsultarDRE(args);
        return { content: JSON.stringify(result), terminalMessage: this.reportTerminalMessage(result) };
      }
      if (toolName === 'consultar_razao') {
        const result = await this.toolConsultarRazao(args);
        return { content: JSON.stringify(result), terminalMessage: this.reportTerminalMessage(result) };
      }
      if (toolName === 'consultar_faturamento') {
        const result = await this.toolConsultarFaturamento(args);
        return { content: JSON.stringify(result), terminalMessage: this.reportTerminalMessage(result) };
      }
      if (toolName === 'consultar_livro_fiscal') {
        const result = await this.toolConsultarLivroFiscal(args);
        return { content: JSON.stringify(result), terminalMessage: this.reportTerminalMessage(result) };
      }
      if (toolName === 'exportar_relatorio') {
        const result = await this.toolExportarRelatorio(args);
        if ('attachment' in result) {
          const { attachment, ...rest } = result;
          return { content: JSON.stringify(rest), attachment };
        }
        return { content: JSON.stringify(result), terminalMessage: 'error' in result ? result.error : undefined };
      }
      const message = 'Ferramenta desconhecida.';
      return { content: JSON.stringify({ error: message }), terminalMessage: message };
    } catch (err) {
      const message = this.extractErrorMessage(err);
      this.logger.warn(`Ferramenta "${toolName}" falhou para usuário ${user.id}: ${message}`);
      return { content: JSON.stringify({ error: message }), terminalMessage: message };
    }
  }

  private extractErrorMessage(err: unknown): string {
    if (err instanceof HttpException) {
      const response = err.getResponse();
      if (typeof response === 'object' && response && 'message' in response) {
        const msg = (response as { message: unknown }).message;
        return Array.isArray(msg) ? msg.join(' ') : String(msg);
      }
      return err.message;
    }
    return err instanceof Error ? err.message : 'Erro inesperado.';
  }

  private async toolCreateSchedule(user: User, args: Record<string, unknown>) {
    // Rede de segurança: o catálogo mostra "Nome do robô [Categoria]", e
    // alguns modelos (ex.: gpt-6-luna) às vezes incluem o sufixo de
    // categoria como se fizesse parte do nome — nenhum robô real termina
    // assim, então remover é sempre seguro.
    const robotName = (typeof args.robotName === 'string' ? args.robotName : '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();
    if (!robotName) return { error: 'Informe o nome do robô.' };

    const robot = await this.prisma.robot.findFirst({
      where: { isActive: true, name: { equals: robotName, mode: 'insensitive' } },
    });
    if (!robot || !canAccessRobot(user, robot)) {
      return { error: `Não encontrei o robô "${robotName}" disponível para este usuário.` };
    }

    const parameters = (typeof args.parameters === 'object' && args.parameters !== null ? args.parameters : {}) as Record<string, unknown>;
    const missingSensitive = findMissingSensitiveFields(robot.schema, parameters);
    if (missingSensitive.length > 0) {
      return {
        error: `Esse robô exige ${missingSensitive.join(', ')}, que não posso coletar pelo chat por segurança. Crie ou complete esse campo em "/schedules" — posso te ajudar com o resto.`,
      };
    }

    const created = await this.scheduledTasksService.saveTask(
      user,
      {
        name: typeof args.name === 'string' && args.name.trim() ? args.name.trim() : `${robot.name} — agendado via chat`,
        robotId: robot.id,
        frequency: typeof args.frequency === 'string' ? args.frequency : undefined,
        timesOfDay: Array.isArray(args.timesOfDay) ? args.timesOfDay.filter((t): t is string => typeof t === 'string') : undefined,
        startDate: typeof args.startDate === 'string' ? args.startDate : undefined,
        dayOfWeek: typeof args.dayOfWeek === 'number' ? args.dayOfWeek : null,
        dayOfMonth: typeof args.dayOfMonth === 'number' ? args.dayOfMonth : null,
        parameters,
        notes: typeof args.notes === 'string' ? args.notes : undefined,
      },
      [],
    );

    return {
      success: true,
      scheduledTaskId: created.id,
      robot: robot.name,
      nextRunAt: created.nextRunAt,
    };
  }

  private async toolCreateRequest(user: User, args: Record<string, unknown>) {
    const description = typeof args.description === 'string' ? args.description.trim() : '';
    if (!description) return { error: 'Preciso de uma descrição do que precisa ser feito.' };

    const isDashboard = args.kind === 'dashboard';
    const rawTitle = typeof args.title === 'string' ? args.title.trim() : '';
    const title = rawTitle ? (isDashboard ? `Dashboard: ${rawTitle}` : rawTitle) : undefined;

    const created = await this.automationRequestsService.create(user, {
      title,
      description,
      systemName: typeof args.systemName === 'string' ? args.systemName : undefined,
      portalUrl: typeof args.portalUrl === 'string' ? args.portalUrl : undefined,
      urgency: typeof args.urgency === 'string' ? args.urgency : undefined,
      cadence: typeof args.cadence === 'string' ? args.cadence : undefined,
      requiresLogin: args.requiresLogin === true,
      requiresCertificate: args.requiresCertificate === true,
      requiresCaptcha: args.requiresCaptcha === true,
      kindLabel: isDashboard ? 'dashboard' : 'automação',
      pageLabel: isDashboard ? 'Solicitar dashboard' : 'Solicitar automação',
    });

    return { success: true, requestId: created.id, title: created.title };
  }

  // Formato padronizado de retorno pra todas as ferramentas de relatório
  // contábil, e helper pra decidir se dá pra pular a segunda chamada ao
  // modelo (erro claro / sem dados — ver comentário em `executeTool`).
  private formatReportResult(result: { status: string; text: string; meta?: Record<string, unknown>; empresaSuggestions?: { codigo: number; razao: string; exibicao?: string }[] }) {
    if (result.status === 'ambiguous') {
      return {
        status: 'ambiguous' as const,
        message: result.text,
        opcoes: result.empresaSuggestions?.map((e) => ({ codigo: e.codigo, nome: e.exibicao ?? e.razao })),
      };
    }
    if (result.status === 'empty' || result.status === 'error') {
      return { status: result.status as 'empty' | 'error', message: result.text };
    }
    return { status: 'ok' as const, resumo: result.text, empresa: result.meta };
  }

  private reportTerminalMessage(result: { error?: string; status?: string; message?: string }): string | undefined {
    if ('error' in result && result.error) return result.error;
    if (result.status === 'error' || result.status === 'empty') return result.message;
    return undefined;
  }

  private async toolConsultarBalancete(args: Record<string, unknown>) {
    const ano = typeof args.ano === 'number' ? args.ano : undefined;
    if (!ano) return { error: 'Informe o ano de referência.' };

    const mes = typeof args.mes === 'number' ? args.mes : undefined;
    if (!mes) return { error: 'Informe o mês de referência (esse relatório exige ano e mês juntos).' };

    const empresaCodigo = typeof args.empresaCodigo === 'number' ? args.empresaCodigo : undefined;
    const empresaNome = typeof args.empresaNome === 'string' ? args.empresaNome.trim() : undefined;
    if (!empresaCodigo && !empresaNome) return { error: 'Informe o nome ou o código da empresa.' };

    const result = await this.controllerIntelligenceService.consultarBalancete({ empresaCodigo, empresaNome, ano, mes });
    return this.formatReportResult(result);
  }

  private async toolConsultarBalanco(args: Record<string, unknown>) {
    const dtIni = typeof args.dtIni === 'string' ? args.dtIni : undefined;
    const dtFim = typeof args.dtFim === 'string' ? args.dtFim : undefined;
    if (!dtIni || !dtFim) return { error: 'Informe o período (data inicial e final).' };

    const empresaCodigo = typeof args.empresaCodigo === 'number' ? args.empresaCodigo : undefined;
    const empresaNome = typeof args.empresaNome === 'string' ? args.empresaNome.trim() : undefined;
    if (!empresaCodigo && !empresaNome) return { error: 'Informe o nome ou o código da empresa.' };

    const result = await this.controllerIntelligenceService.consultarBalanco({ empresaCodigo, empresaNome, dtIni, dtFim });
    return this.formatReportResult(result);
  }

  private async toolConsultarDRE(args: Record<string, unknown>) {
    const ano = typeof args.ano === 'number' ? args.ano : undefined;
    if (!ano) return { error: 'Informe o ano de referência.' };

    // A API do DRE não desambigua nome sozinha; resolve aqui pro código.
    const empresa = await this.resolveEmpresaCodigo(args);
    if ('response' in empresa) return empresa.response;
    const mes = typeof args.mes === 'number' ? args.mes : undefined;

    const result = await this.controllerIntelligenceService.consultarDRE({ empresaCodigo: empresa.codigo, ano, mes });
    return this.formatReportResult(result);
  }

  // Aceita código ou nome: com código usa direto; só com nome, resolve no
  // servidor (ver resolverEmpresa). Quando não dá pra seguir (nome ambíguo,
  // inexistente ou faltando), `response` já é o resultado pronto da ferramenta.
  private async resolveEmpresaCodigo(
    args: Record<string, unknown>,
  ): Promise<
    | { codigo: number }
    | {
        response:
          | { error: string }
          | { status: 'ambiguous'; message: string; opcoes: Array<{ codigo: number; nome: string }> };
      }
  > {
    if (typeof args.empresaCodigo === 'number' && args.empresaCodigo > 0) return { codigo: args.empresaCodigo };

    const nome = typeof args.empresaNome === 'string' ? args.empresaNome.trim() : '';
    if (!nome) return { response: { error: 'Informe o nome ou o código da empresa.' } };

    const resolved = await this.controllerIntelligenceService.resolverEmpresa(nome);
    if (resolved.status === 'ok') return { codigo: resolved.codigo };
    if (resolved.status === 'ambiguous') {
      return { response: { status: 'ambiguous', message: resolved.message, opcoes: resolved.opcoes } };
    }
    return { response: { error: resolved.message } };
  }

  private async toolConsultarRazao(args: Record<string, unknown>) {
    const empresa = await this.resolveEmpresaCodigo(args);
    if ('response' in empresa) return empresa.response;
    const empresaCodigo = empresa.codigo;

    const anoFiscal = typeof args.anoFiscal === 'number' ? args.anoFiscal : undefined;
    const dtIni = typeof args.dtIni === 'string' ? args.dtIni : undefined;
    const dtFim = typeof args.dtFim === 'string' ? args.dtFim : undefined;
    if (!anoFiscal || !dtIni || !dtFim) return { error: 'Informe o ano fiscal e o período (data inicial e final).' };

    const result = await this.controllerIntelligenceService.consultarRazao({ empresaCodigo, anoFiscal, dtIni, dtFim });
    return this.formatReportResult(result);
  }

  private async toolConsultarFaturamento(args: Record<string, unknown>) {
    const empresa = await this.resolveEmpresaCodigo(args);
    if ('response' in empresa) return empresa.response;
    const empresaCodigo = empresa.codigo;

    const dtIni = typeof args.dtIni === 'string' ? args.dtIni : undefined;
    const dtFim = typeof args.dtFim === 'string' ? args.dtFim : undefined;
    if (!dtIni || !dtFim) return { error: 'Informe o período (data inicial e final).' };

    const result = await this.controllerIntelligenceService.consultarFaturamento({ empresaCodigo, dtIni, dtFim });
    return this.formatReportResult(result);
  }

  private async toolConsultarLivroFiscal(args: Record<string, unknown>) {
    const empresa = await this.resolveEmpresaCodigo(args);
    if ('response' in empresa) return empresa.response;
    const empresaCodigo = empresa.codigo;

    const dtIni = typeof args.dtIni === 'string' ? args.dtIni : undefined;
    const dtFim = typeof args.dtFim === 'string' ? args.dtFim : undefined;
    if (!dtIni || !dtFim) return { error: 'Informe o período (data inicial e final).' };

    const tipoRelatorio = typeof args.tipoRelatorio === 'string' ? (args.tipoRelatorio as '00' | '01' | '02' | '10' | '11') : undefined;

    const result = await this.controllerIntelligenceService.consultarLivroFiscal({ empresaCodigo, dtIni, dtFim, tipoRelatorio });
    return this.formatReportResult(result);
  }

  private async toolExportarRelatorio(args: Record<string, unknown>) {
    const tipoRelatorio = EXPORT_REPORT_TYPES.find((t) => t === args.tipoRelatorio);
    if (!tipoRelatorio) return { error: 'Tipo de relatório inválido pra exportar arquivo.' };

    const empresa = await this.resolveEmpresaCodigo(args);
    if ('response' in empresa) return empresa.response;
    const empresaCodigo = empresa.codigo;

    const formato = args.formato === 'pdf' ? ('pdf' as const) : ('xlsx' as const);

    // Balancete e DRE são por ano+mês (o DRE sem mês dá erro 500 na exportação,
    // mesmo a consulta aceitando só o ano); os demais são por período.
    if (tipoRelatorio === 'balancete' || tipoRelatorio === 'dre') {
      const ano = typeof args.ano === 'number' ? args.ano : undefined;
      const mes = typeof args.mes === 'number' ? args.mes : undefined;
      if (!ano) return { error: 'Informe o ano de referência.' };
      if (!mes || mes < 1 || mes > 12) return { error: `Informe o mês de referência (obrigatório pra exportar ${tipoRelatorio === 'dre' ? 'DRE' : 'balancete'}).` };

      const result = await this.controllerIntelligenceService.exportarArquivo({ tipoRelatorio, empresaCodigo, ano, mes, formato });
      if (!result.ok) return { error: result.error };
      const name = friendlyExportName(tipoRelatorio, formato, ano, mes);
      return { success: true, attachment: { buffer: result.buffer, filename: name } };
    }

    const dtIni = typeof args.dtIni === 'string' ? args.dtIni : undefined;
    const dtFim = typeof args.dtFim === 'string' ? args.dtFim : undefined;
    if (!dtIni || !dtFim) return { error: 'Informe o período (data inicial e final).' };
    const ini = parseIsoDate(dtIni);
    const fim = parseIsoDate(dtFim);
    if (!ini || !fim) return { error: 'As datas do período precisam estar no formato AAAA-MM-DD.' };
    if (ini > fim) return { error: 'A data inicial não pode ser depois da data final.' };

    if (tipoRelatorio === 'razao') {
      const dias = Math.round((fim - ini) / 86_400_000) + 1;
      if (dias > RAZAO_MAX_EXPORT_DAYS) {
        return { error: `O razão é uma consulta pesada: só dá pra exportar períodos de até ${RAZAO_MAX_EXPORT_DAYS} dias por vez (você pediu ${dias}). Escolha um intervalo menor.` };
      }
    }

    // Fim do período define o ano/mês de referência quando não vierem explícitos.
    const ano = typeof args.ano === 'number' ? args.ano : Number(dtFim.slice(0, 4));
    const mes = typeof args.mes === 'number' ? args.mes : Number(dtFim.slice(5, 7));

    const result = await this.controllerIntelligenceService.exportarArquivo({ tipoRelatorio, empresaCodigo, ano, mes, dtIni, dtFim, formato });
    if (!result.ok) return { error: result.error };

    const name = friendlyExportName(tipoRelatorio, formato, ano, mes, dtIni, dtFim);
    return { success: true, attachment: { buffer: result.buffer, filename: name } };
  }

  // Orquestra a conversa com o modelo, incluindo chamadas de ferramenta: o
  // primeiro round pode vir sem texto nenhum (só tool_calls) — nesse caso
  // executa as ferramentas, devolve o resultado como mensagens role:"tool" e
  // faz outra chamada, até no máximo MAX_TOOL_ROUNDS vezes ou até o modelo
  // responder com texto final.
  private async converse(
    user: User,
    initialMessages: ChatMessage[],
    onDelta?: (text: string) => void,
  ): Promise<{ text: string; usage: TokenUsage; attachment?: ToolAttachment }> {
    const messages = [...initialMessages];
    const totalUsage: TokenUsage = {};
    let attachment: ToolAttachment | undefined;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const isFinalAttempt = round === MAX_TOOL_ROUNDS - 1;
      const result = await this.streamChatCompletion(messages, isFinalAttempt ? undefined : TOOLS, onDelta);

      if (result.usage.promptTokens) totalUsage.promptTokens = result.usage.promptTokens;
      if (result.usage.completionTokens) {
        totalUsage.completionTokens = (totalUsage.completionTokens ?? 0) + result.usage.completionTokens;
      }

      if (result.toolCalls.length === 0) {
        if (!result.text) {
          throw new InternalServerErrorException('Resposta vazia do assistente.');
        }
        return { text: result.text, usage: totalUsage, attachment };
      }

      messages.push({ role: 'assistant', content: result.text, tool_calls: result.toolCalls });
      const toolResults = await Promise.all(
        result.toolCalls.map((call) => this.executeTool(user, call.function.name, call.function.arguments)),
      );
      for (const [i, call] of result.toolCalls.entries()) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolResults[i].content });
        if (toolResults[i].attachment) attachment = toolResults[i].attachment;
      }

      // Atalho de economia: se só teve UMA ferramenta chamada nessa rodada e
      // ela já devolveu um texto "fechado" (erro claro, "não há dados"),
      // não vale a pena gastar mais uma chamada inteira ao modelo só pra
      // reformular algo que já está pronto pro usuário.
      if (result.toolCalls.length === 1 && toolResults[0].terminalMessage) {
        onDelta?.(toolResults[0].terminalMessage);
        return { text: toolResults[0].terminalMessage, usage: totalUsage, attachment };
      }
    }

    throw new InternalServerErrorException('O assistente não conseguiu concluir a ação a tempo. Tente novamente.');
  }

  // Sempre usa a API de streaming da OpenAI por baixo (mesmo quando ninguém
  // vai ler os deltas — onDelta fica opcional) pra não manter dois clientes
  // HTTP/parsers de resposta em paralelo. Acumula tanto o texto quanto
  // tool_calls (que também chegam fragmentados, por índice).
  private async streamChatCompletion(
    messages: ChatMessage[],
    tools: typeof TOOLS | undefined,
    onDelta?: (text: string) => void,
  ): Promise<{ text: string; toolCalls: ToolCall[]; usage: TokenUsage }> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new InternalServerErrorException('Chat de IA não configurado (falta OPENAI_API_KEY).');
    }

    const requestBody = JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      // "max_tokens" foi descontinuado a favor de "max_completion_tokens" —
      // gpt-4o ainda aceita o antigo, mas modelos mais novos (ex.: gpt-6-luna)
      // já exigem o novo nome.
      max_completion_tokens: MAX_TOKENS,
      temperature: 0.3,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools ? { tools, tool_choice: 'auto' } : {}),
      ...(OPENAI_MODEL_IS_REASONING ? { reasoning_effort: 'none' } : {}),
    });

    let response: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: requestBody,
          signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
        });
      } catch (err) {
        this.logger.error(`Erro ao chamar OpenAI: ${err instanceof Error ? err.message : String(err)}`);
        throw new InternalServerErrorException('Não foi possível falar com o assistente agora. Tente novamente em instantes.');
      }

      // 429 de rate limit (tokens/min da conta) é comum com um system prompt
      // grande (catálogo completo) em rajadas de mensagens — vale uma
      // retentativa curta antes de desistir, em vez de falhar a mensagem do
      // usuário por um limite que se resolve sozinho em poucos segundos.
      if (response.status === 429 && attempt < 2) {
        const retryAfterHeader = Number(response.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : 6000;
        this.logger.warn(`OpenAI 429 (rate limit) — retentativa em ${waitMs}ms (tentativa ${attempt + 1})`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      break;
    }

    if (!response.ok || !response.body) {
      const errBody = await response.text().catch(() => '');
      this.logger.error(`OpenAI respondeu ${response.status}: ${errBody.slice(0, 500)}`);
      const friendly = response.status === 429
        ? 'O assistente está sobrecarregado no momento. Aguarde um pouco e tente de novo.'
        : 'Não foi possível obter resposta do assistente agora.';
      throw new InternalServerErrorException(friendly);
    }

    let full = '';
    const usage: TokenUsage = {};
    const toolCallsByIndex = new Map<number, { id: string; name: string; arguments: string }>();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine.startsWith('data:')) continue;
        const payload = trimmedLine.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
          const json = JSON.parse(payload) as {
            choices?: {
              delta?: {
                content?: string;
                tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
              };
            }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };

          const delta = json.choices?.[0]?.delta;
          if (delta?.content) {
            full += delta.content;
            onDelta?.(delta.content);
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const entry = toolCallsByIndex.get(tc.index) ?? { id: '', name: '', arguments: '' };
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name += tc.function.name;
              if (tc.function?.arguments) entry.arguments += tc.function.arguments;
              toolCallsByIndex.set(tc.index, entry);
            }
          }
          if (json.usage) {
            usage.promptTokens = json.usage.prompt_tokens;
            usage.completionTokens = json.usage.completion_tokens;
          }
        } catch {
          // linha incompleta/malformada no meio do stream — ignora, o buffer cuida do resto
        }
      }
    }

    const toolCalls: ToolCall[] = Array.from(toolCallsByIndex.values())
      .filter((tc) => tc.id && tc.name)
      .map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }));

    return { text: full.trim(), toolCalls, usage };
  }
}

function describeRobotFields(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return '';
  const { fields, fileInputs } = schema as {
    fields?: Array<{ name: string; label?: string; type?: string; required?: boolean }>;
    fileInputs?: Array<{ name: string; label?: string; required?: boolean }>;
  };

  const parts: string[] = [];
  for (const f of fields ?? []) {
    const label = f.label || f.name;
    const sensitive = SENSITIVE_FIELD_PATTERN.test(`${f.name} ${label}`);
    const tag = sensitive ? ' (sensível — só pelo formulário)' : f.required ? ' (obrigatório)' : ' (opcional)';
    parts.push(`${label}${tag}`);
  }
  for (const f of fileInputs ?? []) {
    const label = f.label || f.name;
    parts.push(`${label} (arquivo${f.required ? ', obrigatório — só pelo formulário' : ''})`);
  }
  return parts.join('; ');
}

function findMissingSensitiveFields(schema: unknown, providedParams: Record<string, unknown>): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const { fields } = schema as { fields?: Array<{ name: string; label?: string; required?: boolean }> };
  return (fields ?? [])
    .filter((f) => f.required && SENSITIVE_FIELD_PATTERN.test(`${f.name} ${f.label ?? ''}`))
    .filter((f) => providedParams[f.name] === undefined || providedParams[f.name] === '')
    .map((f) => f.label || f.name);
}
