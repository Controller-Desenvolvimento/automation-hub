import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkAttachment,
  parseListQuery,
  cleanText,
  computeKpis,
  suggestMergeGroups,
  toBool,
  type KpiTicket,
} from '../src/support/support-rules';

const MB = 1024 * 1024;
const day = 24 * 60 * 60 * 1000;

test('anexos: tipos aceitos, tamanhos e tipo vindo da extensão', () => {
  assert.deepEqual(checkAttachment('print.PNG', 1000), { ok: true, isImage: true, mimeType: 'image/png', extension: 'png' });
  assert.equal((checkAttachment('planilha.xlsx', 5 * MB) as { ok: true }).ok, true);
  assert.equal((checkAttachment('a.csv', 10) as { isImage: boolean }).isImage, false);
  for (const ruim of ['virus.exe', 'pagina.html', 'imagem.svg', 'sem-extensao', 'script.js', 'x.png.exe']) {
    assert.equal(checkAttachment(ruim, 100).ok, false, ruim);
  }
  assert.equal(checkAttachment('foto.jpg', 10 * MB + 1).ok, false, 'imagem acima de 10 MB');
  assert.equal(checkAttachment('foto.jpg', 10 * MB).ok, true);
  assert.equal(checkAttachment('dados.xlsx', 25 * MB + 1).ok, false, 'arquivo acima de 25 MB');
  assert.equal(checkAttachment('dados.xlsx', 25 * MB).ok, true);
  assert.equal(checkAttachment('vazio.pdf', 0).ok, false);
});

test('texto: corta no limite, tira espaços e ignora o que não é texto', () => {
  assert.equal(cleanText('  oi  ', 10), 'oi');
  assert.equal(cleanText('abcdef', 3), 'abc');
  assert.equal(cleanText(42, 10), '');
  assert.equal(cleanText('a\r\nb', 10), 'a\nb');
  assert.equal(toBool('true'), true);
  assert.equal(toBool('false'), false);
  assert.equal(toBool(undefined), false);
});

const t = (id: string, over: Partial<Parameters<typeof suggestMergeGroups>[0][0]> = {}, daysAgo = 0) => ({
  id, type: 'problem', subject: 'robot', robotId: 'r1', dashboardId: null, hubArea: null,
  createdAt: new Date(Date.now() - daysAgo * day), ...over,
});

test('juntar: sugere só mesmo tipo + mesmo assunto, com até 14 dias entre um e o próximo', () => {
  const groups = suggestMergeGroups([
    t('a', {}, 3), t('b', {}, 2), t('c', {}, 1),                  // mesmo robô: um grupo
    t('d', { robotId: 'r2' }, 1),                                  // outro robô: sozinho
    t('e', { type: 'question' }, 1),                               // outro tipo: sozinho
    t('f', { subject: 'other', robotId: null }, 1), t('g', { subject: 'other', robotId: null }, 1), // "outro": nunca sugere
  ]);
  assert.deepEqual(groups, [['a', 'b', 'c']]);
});

test('juntar: mais de 14 dias de diferença separa os grupos; a janela vale entre vizinhos', () => {
  const groups = suggestMergeGroups([t('a', {}, 40), t('b', {}, 39), t('c', {}, 10), t('d', {}, 9)]);
  assert.deepEqual(groups, [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(suggestMergeGroups([t('a', {}, 20), t('b', {}, 0)]), []);
  assert.deepEqual(suggestMergeGroups([t('x', {}, 0)]), []);
});

test('juntar: parte do Hub compara sem diferenciar maiúsculas; painel por id', () => {
  const hub = (id: string, area: string) => t(id, { subject: 'hub', robotId: null, hubArea: area });
  assert.deepEqual(suggestMergeGroups([hub('a', 'Login'), hub('b', ' login ')]), [['a', 'b']]);
  assert.deepEqual(suggestMergeGroups([hub('a', 'Login'), hub('b', 'Histórico')]), []);
  const dash = (id: string, d: string) => t(id, { subject: 'dashboard', robotId: null, dashboardId: d });
  assert.deepEqual(suggestMergeGroups([dash('a', 'p1'), dash('b', 'p1'), dash('c', 'p2')]), [['a', 'b']]);
});

const k = (id: string, over: Partial<KpiTicket> = {}, daysAgo = 1): KpiTicket => ({
  id, status: 'open', urgency: 'low', createdAt: new Date(Date.now() - daysAgo * day),
  robotId: null, robotName: null, mainTicketId: null, ...over,
});

test('indicadores: abertos, sem resposta, tempo até a 1ª resposta e robô com mais chamados', () => {
  const now = new Date();
  const created = (h: number) => new Date(now.getTime() - h * 3600_000);
  const tickets = [
    k('1', { urgency: 'critical', createdAt: created(10), robotId: 'r', robotName: 'Gestta' }),
    k('2', { urgency: 'high', status: 'review', createdAt: created(8), robotId: 'r', robotName: 'Gestta' }),
    k('3', { status: 'resolved', createdAt: created(6), robotId: 'q', robotName: 'NFSe' }),
    k('4', { createdAt: created(4), mainTicketId: '1' }),   // ligado: não conta nas contas
  ];
  const firstReply = new Map<string, Date>([
    ['2', new Date(created(8).getTime() + 2 * 3600_000)],   // 2 h
    ['3', new Date(created(6).getTime() + 4 * 3600_000)],   // 4 h
  ]);
  const kpi = computeKpis(tickets, firstReply, now);
  assert.equal(kpi.open, 2);
  assert.equal(kpi.openCritical, 1);
  assert.equal(kpi.openHigh, 1);
  assert.equal(kpi.withoutReply, 1, 'só o #1 está aberto e sem resposta; o ligado não conta');
  assert.equal(kpi.avgFirstReplySeconds, 3 * 3600);
  assert.equal(kpi.firstReplySample, 2);
  assert.deepEqual(kpi.topRobot, { name: 'Gestta', count: 2 });
});

test('indicadores: sem dados não quebra', () => {
  const kpi = computeKpis([], new Map());
  assert.equal(kpi.open, 0);
  assert.equal(kpi.avgFirstReplySeconds, null);
  assert.equal(kpi.topRobot, null);
  assert.equal(kpi.oldestWithoutReplyAt, null);
});

test('lista: lê os filtros da URL e cai no padrão quando o valor é inválido', () => {
  const padrao = parseListQuery({});
  assert.equal(padrao.page, 1);
  assert.equal(padrao.pageSize, 25);
  assert.equal(padrao.situation, 'open');
  assert.equal(padrao.sort, 'recent');
  assert.equal(padrao.tab, 'all');
  assert.equal(padrao.urgency, null);
  const q = parseListQuery({ page: '3', pageSize: '50', situation: 'closed', tab: 'mine', urgency: 'critical', type: 'question', person: ' p1 ', robot: 'r1', department: 'fiscal', q: '#1049', sort: 'urgency' });
  assert.deepEqual([q.page, q.pageSize, q.situation, q.tab, q.urgency, q.type, q.person, q.robot, q.department, q.q, q.sort], [3, 50, 'closed', 'mine', 'critical', 'question', 'p1', 'r1', 'fiscal', '1049', 'urgency']);
  const ruim = parseListQuery({ page: '-5', pageSize: '100000', situation: 'x', urgency: 'x', type: 'x', sort: 'x', tab: 'x' });
  assert.equal(ruim.page, 1);
  assert.equal(ruim.pageSize, 100, 'teto do tamanho da página');
  assert.deepEqual([ruim.situation, ruim.urgency, ruim.type, ruim.sort, ruim.tab], ['open', null, null, 'recent', 'all']);
  assert.equal(parseListQuery({ pageSize: '1' }).pageSize, 5, 'mínimo de 5 por página');
  assert.equal(parseListQuery({ page: ['1'], q: 5 }).q, '', 'valores que não são texto são ignorados');
});

