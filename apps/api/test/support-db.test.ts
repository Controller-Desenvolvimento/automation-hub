// Suporte (chamados) contra um PostgreSQL REAL e DESCARTÁVEL (mesma trava dos outros testes com banco: hub_dev, porta 5544).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { limparTmp } from './_limpar-tmp';

/* eslint-disable @typescript-eslint/no-explicit-any */
const url = process.env.TEST_DATABASE_URL ?? '';
const skip = !/\/hub_dev(\?|$)/.test(url) || !/:5544\//.test(url)
  ? 'defina TEST_DATABASE_URL apontando para o banco descartável (hub_dev na porta 5544)'
  : false;

const tmp = mkdtempSync(join(tmpdir(), 'sup-db-'));
const cwdOriginal = process.cwd();
let prisma: any;
let support: any;
let canAccessStoragePath: any;
const emails: any[] = [];
const fakeMail = { sendSupportAlert: async (input: any) => { emails.push(input); } };
let U: Record<string, any> = {};
let n = 0;

before(async () => {
  if (skip) return;
  process.chdir(tmp);
  process.env.DATABASE_URL = url;
  const { PrismaService } = await import('../src/prisma/prisma.service');
  const { SupportService } = await import('../src/support/support.service');
  ({ canAccessStoragePath } = await import('../src/shared/storage-access'));
  prisma = new PrismaService();
  await prisma.$connect();
  support = new SupportService(prisma, fakeMail as any);
  await cleanup();
  const mk = (id: string, name: string, role: string, departments: string[] = []) =>
    prisma.user.upsert({
      where: { id },
      update: { role, departments, isActive: true },
      create: { id, name, email: `${id}@example.invalid`, passwordHash: 'x', role, departments },
    });
  U = {
    ana: await mk('s-ana', 'Ana', 'employee', ['fiscal']),
    bia: await mk('s-bia', 'Bia', 'employee', ['fiscal']),
    caio: await mk('s-caio', 'Caio', 'manager', ['fiscal']), // gestor: NÃO vê chamado dos outros
    ino: await mk('s-ino', 'Davi', 'employee', ['inovacao']), // Inovação = administrador
    adm: await mk('s-adm', 'Admin', 'admin'),
  };
  await prisma.robot.upsert({ where: { id: 's-robo' }, update: {}, create: { id: 's-robo', slug: 's-robo', name: 'Robô Teste', command: 'echo', allowedDepartments: ['fiscal'] } });
  await prisma.robot.upsert({ where: { id: 's-robo-rh' }, update: {}, create: { id: 's-robo-rh', slug: 's-robo-rh', name: 'Robô RH', command: 'echo', allowedDepartments: ['rh'] } });
});

async function cleanup() {
  await prisma.notification.deleteMany({ where: { supportTicketId: { not: null } } });
  await prisma.supportTicket.deleteMany();
}

after(async () => {
  process.chdir(cwdOriginal);
  if (prisma) {
    await cleanup();
    await prisma.onModuleDestroy();
  }
  limparTmp(tmp);
});

beforeEach(async () => {
  emails.length = 0;
  if (!skip) await cleanup();
});

const open = (user: any, over: Record<string, unknown> = {}, files: any[] = []) =>
  support.create(user, { type: 'problem', subject: 'robot', robotId: 's-robo', urgency: 'high', title: 'Robô parou', body: 'Deu erro na linha 5', ...over }, files);

function upload(name: string, bytes = 'conteudo') {
  const path = join(tmp, `up-${++n}`);
  writeFileSync(path, bytes);
  return { originalname: name, size: Buffer.byteLength(bytes), path, mimetype: 'x' };
}
const status = async (id: string) => (await prisma.supportTicket.findUnique({ where: { id } })).status;
const storageFile = (downloadUrl: string) => join(tmp, 'storage', downloadUrl.replace('/storage/', ''));

test('abrir: valida campos, guarda número, avisa a Inovação (não quem abriu) e conta no menu', { skip }, async () => {
  await assert.rejects(() => support.create(U.ana, { type: 'x', subject: 'hub', title: 'abc', body: 'x' }), /tipo/);
  await assert.rejects(() => support.create(U.ana, { type: 'problem', subject: 'hub', title: 'a', body: 'x' }), /título/);
  await assert.rejects(() => support.create(U.ana, { type: 'problem', subject: 'hub', title: 'abc', body: '' }), /Descreva/);
  const { id, number } = await open(U.ana);
  assert.ok(number > 0);
  const notified = (await prisma.notification.findMany({ where: { supportTicketId: id } })).map((x: any) => x.userId).filter((u: string) => u.startsWith('s-')).sort(); // (o banco de teste pode ter outros admins de outros testes)
  assert.deepEqual(notified, ['s-adm', 's-ino'], 'administradores e Inovação, nunca quem abriu');
  assert.equal((await support.summary(U.ino)).forAdmin, 1);
  assert.equal((await support.summary(U.ana)).unread, 0);
});

test('acesso: pessoa vê só os próprios; gestor também não vê os do departamento; admin e Inovação veem todos', { skip }, async () => {
  const a = await open(U.ana);
  const b = await open(U.bia, { title: 'Do Bia' });
  const mine = await support.list(U.ana);
  assert.deepEqual(mine.tickets.map((t: any) => t.id), [a.id]);
  assert.equal(mine.kpis, undefined, 'sem indicadores para quem não é admin');
  assert.equal(mine.tickets[0].author, undefined, 'sem dados de quem abriu na lista da pessoa');
  assert.equal((await support.list(U.caio)).tickets.length, 0, 'gestor não vê chamado do departamento');
  await assert.rejects(() => support.get(b.id, U.ana), /não encontrado/);
  await assert.rejects(() => support.get(b.id, U.caio), /não encontrado/);
  await assert.rejects(() => support.addMessage(b.id, U.ana, { body: 'oi' }), /não encontrado/);
  assert.equal((await support.list(U.ino)).tickets.length, 2);
  assert.equal((await support.list(U.adm)).tickets.length, 2);
  assert.ok((await support.get(b.id, U.ino)).author.name);
});

test('abrir com robô sem acesso: o robô é ignorado (não vaza nome nem vincula)', { skip }, async () => {
  const { id } = await open(U.ana, { robotId: 's-robo-rh' });
  assert.equal((await prisma.supportTicket.findUnique({ where: { id } })).robotId, null);
  const ok = await open(U.ana, { robotId: 's-robo' });
  assert.equal((await prisma.supportTicket.findUnique({ where: { id: ok.id } })).robotId, 's-robo');
  const opts = await support.options(U.ana);
  assert.ok(opts.robots.some((r: any) => r.id === 's-robo'));
  assert.equal(opts.robots.some((r: any) => r.id === 's-robo-rh'), false);
  assert.deepEqual(opts.admins, []);
  assert.ok((await support.options(U.ino)).admins.length >= 2);
});

test('conversa: resposta da Inovação avisa quem abriu; nota interna nunca aparece para ele; abrir limpa a novidade', { skip }, async () => {
  const { id } = await open(U.ana);
  await support.addMessage(id, U.ino, { body: 'Estou olhando', internal: 'true' });
  assert.equal((await support.summary(U.ana)).unread, 0, 'nota interna não avisa');
  await support.addMessage(id, U.ino, { body: 'Já estamos vendo' });
  assert.equal((await support.summary(U.ana)).forAuthor, 1);
  assert.equal(await status(id), 'review', 'resposta num chamado aberto passa para Em análise');
  assert.equal((await support.summary(U.ino)).forAdmin, 0, 'a Inovação respondeu: sai da fila');
  const seen = await support.get(id, U.ana);
  assert.equal(seen.messages.some((m: any) => m.kind === 'internal' || m.kind === 'system_admin'), false);
  assert.equal(seen.messages.some((m: any) => m.body === 'Estou olhando'), false);
  assert.ok(seen.messages.some((m: any) => m.body === 'Já estamos vendo'));
  assert.equal((await support.summary(U.ana)).unread, 0, 'abrir tira a novidade');
  const admin = await support.get(id, U.ino);
  assert.ok(admin.messages.some((m: any) => m.body === 'Estou olhando' && m.kind === 'internal'));
  await assert.rejects(() => support.addMessage(id, U.ana, { body: 'x', internal: 'true' }), /notas internas/);
});

test('status: aguardando → autor responde volta para Em análise e para a fila; resolvido → confirmar/reabrir', { skip }, async () => {
  const { id } = await open(U.ana);
  await support.update(id, U.ino, { status: 'waiting' });
  assert.equal(await status(id), 'waiting');
  assert.equal((await support.summary(U.ana)).forAuthor, 1);
  await support.addMessage(id, U.ana, { body: 'Segue o print' });
  assert.equal(await status(id), 'review');
  assert.equal((await support.summary(U.ino)).forAdmin, 1);
  await support.update(id, U.ino, { status: 'resolved' });
  const closed = await prisma.supportTicket.findUnique({ where: { id } });
  assert.equal(closed.status, 'resolved');
  assert.ok(closed.closedAt);
  await assert.rejects(() => support.reopen(id, U.bia), /não encontrado/);
  await support.confirm(id, U.ana);
  assert.equal((await prisma.supportTicket.findUnique({ where: { id } })).authorConfirmed, true);
  await support.reopen(id, U.ana);
  const re = await prisma.supportTicket.findUnique({ where: { id } });
  assert.equal(re.status, 'open');
  assert.equal(re.closedAt, null);
  assert.equal(re.authorConfirmed, false);
  assert.equal(re.needsAdmin, true);
  await assert.rejects(() => support.confirm(id, U.ana), /ainda não foi encerrado/);
  await assert.rejects(() => support.update(id, U.ana, { status: 'resolved' }), /administradores/);
  await assert.rejects(() => support.update(id, U.ino, { status: 'xyz' }), /Status/);
});

test('urgência e responsável: só admin; responsável precisa ser da Inovação/admin; o registro só aparece para admin', { skip }, async () => {
  const { id } = await open(U.ana);
  await support.update(id, U.ino, { urgency: 'critical', assigneeId: 's-adm' });
  const t = await prisma.supportTicket.findUnique({ where: { id } });
  assert.equal(t.urgency, 'critical');
  assert.equal(t.assigneeId, 's-adm');
  await assert.rejects(() => support.update(id, U.ino, { assigneeId: 's-bia' }), /Inovação/);
  const seenByAuthor = await support.get(id, U.ana);
  assert.equal(seenByAuthor.messages.some((m: any) => m.kind === 'system_admin'), false);
  assert.equal(seenByAuthor.assignee, undefined);
  assert.ok((await support.get(id, U.ino)).messages.some((m: any) => m.kind === 'system_admin' && /Urgência/.test(m.body)));
  assert.ok(await prisma.notification.findFirst({ where: { userId: 's-adm', type: 'support_assigned', supportTicketId: id } }));
});

test('anexos: gravam em storage/support/<chamado>, só quem abriu e admin acessam, tipo ruim é recusado', { skip }, async () => {
  await assert.rejects(() => open(U.ana, {}, [upload('virus.exe')]), /não aceito/);
  assert.equal(await prisma.supportTicket.count(), 0, 'recusa antes de criar o chamado');
  const { id } = await open(U.ana, {}, [upload('print.png'), upload('planilha.xlsx')]);
  const detail = await support.get(id, U.ana);
  const att = detail.messages[0].attachments;
  assert.equal(att.length, 2);
  assert.ok(att.find((a: any) => a.isImage && a.fileName === 'print.png'));
  for (const a of att) {
    const rel = a.downloadUrl.replace('/storage/', '');
    assert.match(a.downloadUrl, new RegExp(`^/storage/support/${id}/`));
    assert.ok(existsSync(storageFile(a.downloadUrl)));
    assert.equal(await canAccessStoragePath(prisma, U.ana, rel), true);
    assert.equal(await canAccessStoragePath(prisma, U.ino, rel), true);
    assert.equal(await canAccessStoragePath(prisma, U.bia, rel), false, 'outra pessoa');
    assert.equal(await canAccessStoragePath(prisma, U.caio, rel), false, 'gestor do mesmo departamento');
  }
  assert.equal(await canAccessStoragePath(prisma, U.ana, 'support/nao-existe/x.png'), false);
  await assert.rejects(() => support.addMessage(id, U.ana, { body: '' }, []), /Escreva uma mensagem/);
  await support.addMessage(id, U.ana, { body: '' }, [upload('outro.pdf')]); // só anexo vale
  assert.equal((await support.get(id, U.ana)).messages.at(-1).attachments.length, 1);
  const seis = Array.from({ length: 6 }, (_, i) => upload(`a${i}.png`));
  await assert.rejects(() => support.addMessage(id, U.ana, { body: 'x' }, seis), /até 5/);
});

test('limpeza: anexos de chamado encerrado há mais de N dias somem do disco e do banco; o texto fica', { skip }, async () => {
  const { id } = await open(U.ana, {}, [upload('print.png')]);
  const url0 = (await support.get(id, U.ana)).messages[0].attachments[0].downloadUrl;
  assert.equal(await support.cleanOldAttachments(90), 0, 'aberto: nada a limpar');
  await support.update(id, U.ino, { status: 'resolved' });
  assert.equal(await support.cleanOldAttachments(90), 0, 'encerrado agora: ainda não passou o prazo');
  await prisma.supportTicket.update({ where: { id }, data: { closedAt: new Date(Date.now() - 91 * 86400_000) } });
  assert.equal(await support.cleanOldAttachments(0), 0, '0 = nunca apagar');
  assert.equal(await support.cleanOldAttachments(90), 1);
  assert.equal(existsSync(storageFile(url0)), false);
  const depois = await support.get(id, U.ana);
  assert.equal(depois.messages[0].attachments.length, 1, 'o registro fica (nome e tamanho)');
  assert.equal(depois.messages[0].attachments[0].removed, true);
  assert.equal(depois.messages[0].attachments[0].downloadUrl, null);
  assert.equal(depois.messages[0].attachments[0].fileName, 'print.png');
  assert.ok(depois.messages[0].body.length > 0);
  assert.ok(depois.attachmentsCleanedAt);
  assert.equal(await support.cleanOldAttachments(90), 0, 'não repete');
});

test('execução: "Reportar problema" leva erro, parâmetros SEM senha e fim do log; só de execução que a pessoa pode ver', { skip }, async () => {
  const ids = ['s-ex1', 's-ex2'];
  const wipe = async () => {
    await prisma.supportTicket.deleteMany();
    await prisma.executionLog.deleteMany({ where: { executionId: { in: ids } } });
    await prisma.execution.deleteMany({ where: { id: { in: ids } } });
  };
  const mkExec = async (id: string, userId: string) => {
    await prisma.execution.create({
      data: { id, robotId: 's-robo', userId, status: 'error', errorMessage: 'KeyError: x', inputJson: { empresa: '123', senha: 'segredo', outro: 'ok' }, startedAt: new Date(), finishedAt: new Date() },
    });
    await prisma.executionLog.createMany({ data: Array.from({ length: 35 }, (_, i) => ({ executionId: id, message: `linha ${i}` })) });
  };
  await wipe();
  await mkExec('s-ex1', 's-ana');
  await mkExec('s-ex2', 's-bia');
  try {
    const { id } = await open(U.ana, { executionId: 's-ex1' });
    const t = await support.get(id, U.ana);
    assert.equal(t.executionId, 's-ex1');
    assert.equal(t.context.errorMessage, 'KeyError: x');
    assert.deepEqual(t.context.parameters, { empresa: '123', outro: 'ok' });
    assert.deepEqual(t.context.hiddenParameters, ['senha']);
    assert.equal(JSON.stringify(t).includes('segredo'), false, 'a senha não vaza em lugar nenhum');
    assert.equal(t.context.logTail.length, 30);
    assert.equal(t.context.logTail.at(-1).message, 'linha 34');
    // execução de outra pessoa: ignorada, sem vazar nada
    const other = await open(U.ana, { executionId: 's-ex2' });
    const o = await support.get(other.id, U.ana);
    assert.equal(o.executionId, null);
    assert.equal(o.context, null);
  } finally {
    await wipe();
  }
});

test('juntar: o principal mostra o que cada autor escreveu; responder uma vez entrega a todos (com anexo); status propaga', { skip }, async () => {
  const a = await open(U.ana, { title: 'Gestta A' });
  const b = await open(U.bia, { title: 'Gestta B', body: 'Mesmo erro aqui' });
  const c = await open(U.caio, { title: 'Gestta C' });
  await assert.rejects(() => support.merge(U.ana, { mainId: a.id, ticketIds: [b.id] }), /administradores/);
  await assert.rejects(() => support.merge(U.ino, { mainId: a.id, ticketIds: [a.id] }), /pelo menos mais um/);
  const res = await support.merge(U.ino, { mainId: a.id, ticketIds: [b.id, c.id] });
  assert.equal(res.linked, 2);
  assert.equal((await support.summary(U.ino)).forAdmin, 1, 'os ligados saem da fila: só o principal conta');

  const main = await support.get(a.id, U.ino);
  assert.equal(main.linked.length, 2);
  const fromBia = main.messages.find((m: any) => m.body === 'Mesmo erro aqui');
  assert.equal(fromBia.fromTicket.authorName, 'Bia');
  assert.equal(fromBia.fromTicket.number, b.number);

  await support.addMessage(a.id, U.ino, { body: 'Corrigido, pode rodar de novo', alsoLinked: 'true' }, [upload('manual.pdf')]);
  for (const t of [b, c]) {
    const own = await support.get(t.id, t.id === b.id ? U.bia : U.caio);
    const reply = own.messages.find((m: any) => m.body === 'Corrigido, pode rodar de novo');
    assert.ok(reply, 'a resposta chegou na conversa do autor');
    assert.equal(reply.attachments.length, 1, 'com o anexo copiado');
    assert.match(reply.attachments[0].downloadUrl, new RegExp(`/support/${t.id}/`), 'cópia no diretório do chamado dele');
    assert.ok(existsSync(storageFile(reply.attachments[0].downloadUrl)));
    assert.equal(own.main, null);
    assert.equal(own.linked, undefined, 'o autor não vê a ligação');
    assert.ok(own.messages.some((m: any) => /ligado a um problema/.test(m.body)));
    assert.equal(own.messages.some((m: any) => m.fromTicket), false, 'nada de outros autores');
  }
  // nota interna não propaga
  await support.addMessage(a.id, U.ino, { body: 'segredo da equipe', internal: 'true' });
  assert.equal((await support.get(b.id, U.bia)).messages.some((m: any) => /segredo da equipe/.test(m.body)), false);
  // sem marcar a caixa: não propaga
  await support.addMessage(a.id, U.ino, { body: 'só no principal', alsoLinked: 'false' });
  assert.equal((await support.get(b.id, U.bia)).messages.some((m: any) => m.body === 'só no principal'), false);
  // status do principal vale para todos
  await support.update(a.id, U.ino, { status: 'resolved' });
  for (const id of [a.id, b.id, c.id]) assert.equal(await status(id), 'resolved');
  assert.ok((await prisma.supportTicket.findUnique({ where: { id: b.id } })).closedAt);
  // quem foi ligado reabre: o principal volta para a fila
  await support.reopen(b.id, U.bia);
  assert.equal((await prisma.supportTicket.findUnique({ where: { id: a.id } })).needsAdmin, true);
  // desligar
  await support.unlink(b.id, U.ino);
  assert.equal((await prisma.supportTicket.findUnique({ where: { id: b.id } })).mainTicketId, null);
  await assert.rejects(() => support.unlink(b.id, U.ino), /não está ligado/);
});

test('juntar: ligar um que já era principal leva os dele junto; principal já ligado é recusado', { skip }, async () => {
  const a = await open(U.ana);
  const b = await open(U.bia);
  const c = await open(U.caio);
  const d = await open(U.ana, { title: 'Chamado D' });
  await support.merge(U.ino, { mainId: b.id, ticketIds: [c.id] }); // b é principal de c
  await assert.rejects(() => support.merge(U.ino, { mainId: c.id, ticketIds: [d.id] }), /já está ligado/);
  await support.merge(U.ino, { mainId: a.id, ticketIds: [b.id, d.id] }); // b (e o c dele) vão para a
  const rows = await prisma.supportTicket.findMany({ where: { id: { in: [b.id, c.id, d.id] } }, select: { id: true, mainTicketId: true } });
  for (const r of rows) assert.equal(r.mainTicketId, a.id);
});

test('lista do admin: indicadores, chamados parecidos sugeridos e tempo até a 1ª resposta', { skip }, async () => {
  const a = await open(U.ana, { urgency: 'critical' });
  const b = await open(U.bia);
  await open(U.caio, { subject: 'other', robotId: null });
  const antes = await support.list(U.ino);
  assert.equal(antes.kpis.open, 3);
  assert.equal(antes.kpis.openCritical, 1);
  assert.equal(antes.kpis.withoutReply, 3);
  assert.equal(antes.kpis.avgFirstReplySeconds, null);
  assert.deepEqual(antes.suggestions.map((g: any[]) => g.map((t) => t.id).sort()), [[a.id, b.id].sort()], 'mesmo robô e tipo: sugere juntar');
  await support.addMessage(a.id, U.ino, { body: 'Olá' });
  const depois = await support.list(U.ino);
  assert.equal(depois.kpis.withoutReply, 2);
  assert.equal(depois.kpis.firstReplySample, 1);
  assert.ok(depois.kpis.avgFirstReplySeconds >= 0);
  assert.equal(depois.kpis.topRobot.name, 'Robô Teste');
});

test('lista do admin: depois de juntar, os ligados não voltam a ser sugeridos (mas um novo parecido sim)', { skip }, async () => {
  const a = await open(U.ana);
  const b = await open(U.bia);
  assert.equal((await support.list(U.ino)).suggestions.length, 1);
  await support.merge(U.ino, { mainId: a.id, ticketIds: [b.id] });
  assert.equal((await support.list(U.ino)).suggestions.length, 0, 'principal + ligado: nada a sugerir');
  const c = await open(U.caio);
  const groups = (await support.list(U.ino)).suggestions.map((g: any[]) => g.map((t) => t.id).sort());
  assert.deepEqual(groups, [[a.id, c.id].sort()], 'o novo chamado parecido é sugerido junto do principal');
});

test('paginação: páginas, total, contagens, ordem e página fora do limite', { skip }, async () => {
  for (let i = 1; i <= 7; i++) {
    await open(i % 2 ? U.ana : U.bia, { title: `Chamado numero ${i}`, urgency: i === 7 ? 'critical' : 'low' });
  }
  const p1 = await support.list(U.ino, { pageSize: '5' });
  assert.equal(p1.tickets.length, 5);
  assert.equal(p1.total, 7);
  assert.equal(p1.totalPages, 2);
  assert.deepEqual(p1.counts, { open: 7, closed: 0, all: 7 });
  const p2 = await support.list(U.ino, { pageSize: '5', page: '2' });
  assert.equal(p2.tickets.length, 2);
  const ids = [...p1.tickets, ...p2.tickets].map((t: any) => t.id);
  assert.equal(new Set(ids).size, 7, 'nenhum chamado repetido nem perdido entre as páginas');
  const beyond = await support.list(U.ino, { pageSize: '5', page: '99' });
  assert.equal(beyond.page, 2, 'página fora do limite volta para a última');
  assert.equal(beyond.tickets.length, 2);
  const oldest = await support.list(U.ino, { sort: 'oldest', pageSize: '5' });
  assert.equal(oldest.tickets[0].title, 'Chamado numero 1');
  const urgent = await support.list(U.ino, { sort: 'urgency', pageSize: '5' });
  assert.equal(urgent.tickets[0].title, 'Chamado numero 7', 'crítico primeiro');
  // valores inválidos viram o padrão (tela antiga em cache não quebra)
  const weird = await support.list(U.ino, { page: 'abc', pageSize: '-3', sort: 'x', situation: 'y' });
  assert.equal(weird.page, 1);
  assert.equal(weird.total, 7);
  assert.equal(weird.tickets.length, 5, 'tamanho de página inválido vira o mínimo (5)');
});

test('paginação: filtros no servidor (situação, busca por título e número, pessoa, departamento, robô, atribuídos a mim)', { skip }, async () => {
  const a = await open(U.ana, { title: 'Falha no Gestta' });
  const b = await open(U.bia, { title: 'Dúvida sobre relatório', type: 'question', subject: 'other', robotId: null });
  await support.update(b.id, U.ino, { status: 'resolved', assigneeId: 's-ino' });
  const titles = async (q: Record<string, unknown>, who = U.ino) => (await support.list(who, q)).tickets.map((t: any) => t.title).sort();
  assert.deepEqual(await titles({}), ['Falha no Gestta'], 'padrão: só em aberto');
  assert.deepEqual(await titles({ situation: 'closed' }), ['Dúvida sobre relatório']);
  assert.equal((await titles({ situation: 'all' })).length, 2);
  const counts = (await support.list(U.ino, { situation: 'closed' })).counts;
  assert.deepEqual(counts, { open: 1, closed: 1, all: 2 }, 'as contagens ignoram a situação escolhida');
  assert.deepEqual(await titles({ situation: 'all', q: 'gesTTa' }), ['Falha no Gestta'], 'busca sem diferenciar maiúsculas');
  assert.deepEqual(await titles({ situation: 'all', q: `#${b.number}` }), ['Dúvida sobre relatório'], 'busca pelo número');
  assert.deepEqual(await titles({ situation: 'all', person: 's-bia' }), ['Dúvida sobre relatório']);
  assert.deepEqual(await titles({ situation: 'all', department: 'fiscal' }).then((x) => x.length), 2);
  assert.deepEqual(await titles({ situation: 'all', department: 'rh' }), []);
  assert.deepEqual(await titles({ situation: 'all', robot: 's-robo' }), ['Falha no Gestta']);
  assert.deepEqual(await titles({ situation: 'all', type: 'question' }), ['Dúvida sobre relatório']);
  assert.deepEqual(await titles({ situation: 'all', tab: 'mine' }), ['Dúvida sobre relatório'], 'atribuídos a mim');
  // quem não é admin: os filtros de admin não abrem o chamado de outros
  assert.deepEqual(await titles({ situation: 'all', person: 's-bia' }, U.ana), ['Falha no Gestta'], 'pessoa comum só enxerga os próprios, mesmo pedindo outra pessoa');
  assert.deepEqual(await titles({ situation: 'all', q: 'relatório' }, U.ana), []);
  const r = await support.list(U.ana, { situation: 'all' });
  assert.equal(r.facets, undefined);
  assert.equal(r.kpis, undefined);
  assert.equal(r.suggestions, undefined);
  const facets = (await support.list(U.ino)).facets;
  assert.deepEqual(facets.people.map((p: any) => p.id).sort(), ['s-ana', 's-bia']);
  assert.deepEqual(facets.departments, ['fiscal']);
  assert.deepEqual(facets.robots.map((x: any) => x.id), ['s-robo']);
  void a;
});

test('detalhe do admin traz os chamados parecidos; o autor não', { skip }, async () => {
  const a = await open(U.ana);
  const b = await open(U.bia);
  const own = await support.get(a.id, U.ino);
  assert.deepEqual(own.similar.map((t: any) => t.id), [b.id]);
  assert.deepEqual((await support.get(a.id, U.ana)).similar, []);
  await support.merge(U.ino, { mainId: a.id, ticketIds: [b.id] });
  assert.deepEqual((await support.get(a.id, U.ino)).similar, [], 'depois de juntar, nada a sugerir');
  assert.deepEqual((await support.get(b.id, U.ino)).similar, [], 'ligado não recebe sugestão');
});

// O e-mail é disparado em segundo plano (sem await): dá um respiro para a fila de tarefas.
const tick = () => new Promise((resolve) => setTimeout(resolve, 60));

test('e-mail para a Inovação: chamado novo avisa; quem é da Inovação abrindo não avisa', { skip }, async () => {
  const { id, number } = await open(U.ana, { urgency: 'critical' });
  await tick();
  assert.equal(emails.length, 1);
  assert.equal(emails[0].kind, 'new');
  assert.equal(emails[0].ticketId, id);
  assert.equal(emails[0].number, number);
  assert.equal(emails[0].authorName, 'Ana');
  assert.equal(emails[0].authorDepartment, 'Fiscal');
  assert.equal(emails[0].critical, true);
  assert.equal(emails[0].subjectLabel, 'Robô: Robô Teste');
  assert.equal(emails[0].typeLabel, 'Algo não funciona');
  assert.equal(JSON.stringify(emails[0]).includes('Deu erro na linha 5'), false, 'o texto da mensagem nunca vai no e-mail');
  await open(U.ino);
  await tick();
  assert.equal(emails.length, 1, 'chamado aberto pela própria Inovação não gera e-mail');
});

test('e-mail para a Inovação: resposta de quem abriu avisa (uma vez por janela); resposta da Inovação não avisa', { skip }, async () => {
  const { id } = await open(U.ana);
  await tick();
  emails.length = 0;
  await support.addMessage(id, U.ino, { body: 'Olá, estamos vendo' });
  await tick();
  assert.equal(emails.length, 0, 'a Inovação respondendo não manda e-mail para a Inovação');
  await support.addMessage(id, U.ana, { body: 'Segue mais detalhe' });
  await tick();
  assert.deepEqual(emails.map((e) => e.kind), ['reply']);
  await support.addMessage(id, U.ana, { body: 'E mais um detalhe' });
  await support.addMessage(id, U.ana, { body: 'E outro' });
  await tick();
  assert.equal(emails.length, 1, 'respostas seguidas viram um e-mail só');
  await support.addMessage(id, U.ino, { body: 'nota', internal: 'true' });
  await tick();
  assert.equal(emails.length, 1, 'nota interna nunca manda e-mail');
});

test('e-mail para a Inovação: reabrir avisa sempre, inclusive dentro da janela de respostas', { skip }, async () => {
  const { id } = await open(U.ana);
  await support.addMessage(id, U.ana, { body: 'Mais um detalhe' });
  await support.update(id, U.ino, { status: 'resolved' });
  await tick();
  emails.length = 0;
  await support.reopen(id, U.ana);
  await tick();
  assert.deepEqual(emails.map((e) => e.kind), ['reopen']);
  await support.update(id, U.ino, { status: 'resolved' });
  await support.addMessage(id, U.ana, { body: 'Ainda dá erro, respondendo direto' }); // responder num encerrado também reabre
  await tick();
  assert.deepEqual(emails.map((e) => e.kind), ['reopen', 'reopen']);
});

test('e-mail para a Inovação: falha no envio não derruba a abertura do chamado', { skip }, async () => {
  const quebrado = new (support.constructor as any)(prisma, { sendSupportAlert: async () => { throw new Error('SMTP fora do ar'); } });
  const r = await quebrado.create(U.ana, { type: 'problem', subject: 'hub', title: 'Teste de falha', body: 'x' });
  await tick();
  assert.ok(r.id);
  assert.equal(await prisma.supportTicket.count(), 1);
});

test('e-mail para a Inovação: SUPPORT_ALERT_EMAILS=false desliga', { skip }, async () => {
  process.env.SUPPORT_ALERT_EMAILS = 'false';
  try {
    await open(U.ana);
    await tick();
    assert.equal(emails.length, 0);
  } finally {
    delete process.env.SUPPORT_ALERT_EMAILS;
  }
});

test('administrador reabre um chamado encerrado: pelo status e pelo Enviar com status (com mensagem)', { skip }, async () => {
  const { id } = await open(U.ana);
  await support.update(id, U.ino, { status: 'resolved' });
  assert.ok((await prisma.supportTicket.findUnique({ where: { id } })).closedAt);
  // 1) só o status (cartão Situação sem mensagem)
  await support.update(id, U.ino, { status: 'waiting' });
  let t = await prisma.supportTicket.findUnique({ where: { id } });
  assert.equal(t.status, 'waiting');
  assert.equal(t.closedAt, null, 'reabrir limpa a data de encerramento');
  // 2) status junto com a mensagem (cartão Situação com mensagem)
  await support.update(id, U.ino, { status: 'not_issue' });
  await support.addMessage(id, U.ino, { body: 'Reabri para ajustar um detalhe.', status: 'review' });
  t = await prisma.supportTicket.findUnique({ where: { id } });
  assert.equal(t.status, 'review');
  assert.equal(t.closedAt, null);
  const seenByAuthor = await support.get(id, U.ana);
  assert.ok(seenByAuthor.messages.some((m: any) => m.body === 'Reabri para ajustar um detalhe.'));
  // o histórico guarda quem encerrou e quem reabriu (linhas de status com o autor da mudança)
  const status = seenByAuthor.messages.filter((m: any) => m.kind === 'system' && /^Status alterado para: /.test(m.body));
  assert.deepEqual(status.map((m: any) => m.body), [
    'Status alterado para: Resolvido.',
    'Status alterado para: Aguardando resposta.',
    'Status alterado para: Não é problema.',
    'Status alterado para: Em análise.',
  ]);
  assert.ok(status.every((m: any) => m.author?.name === 'Davi'), 'cada linha traz quem mudou o status');
});

test('confirmar o encerramento registra "Sim, obrigado(a)." (resolvido) ou "Sim, concordo." (não é problema)', { skip }, async () => {
  const a = await open(U.ana);
  await support.update(a.id, U.ino, { status: 'resolved' });
  await support.confirm(a.id, U.ana);
  const b = await open(U.bia);
  await support.update(b.id, U.ino, { status: 'not_issue' });
  await support.confirm(b.id, U.bia);
  const last = async (id: string, who: any) => (await support.get(id, who)).messages.filter((m: any) => m.kind === 'message').at(-1).body;
  assert.equal(await last(a.id, U.ana), 'Sim, obrigado(a).');
  assert.equal(await last(b.id, U.bia), 'Sim, concordo.');
});


test('juntar: a notificação da resposta vai para o PRÓPRIO chamado de cada pessoa ligada', { skip }, async () => {
  const a = await open(U.ana, { title: 'Gestta A' });
  const b = await open(U.bia, { title: 'Gestta B' });
  const c = await open(U.caio, { title: 'Gestta C' });
  await support.merge(U.ino, { mainId: a.id, ticketIds: [b.id, c.id] });
  await prisma.notification.deleteMany({ where: { supportTicketId: { not: null } } });
  await support.addMessage(a.id, U.ino, { body: 'Corrigido', alsoLinked: 'true' });
  const bia = await prisma.notification.findMany({ where: { userId: 's-bia', type: 'support_reply' } });
  const caio = await prisma.notification.findMany({ where: { userId: 's-caio', type: 'support_reply' } });
  assert.equal(bia.length, 1);
  assert.equal(caio.length, 1);
  assert.equal(bia[0].supportTicketId, b.id, 'a Bia é levada ao chamado dela');
  assert.equal(caio[0].supportTicketId, c.id, 'o Caio é levado ao chamado dele (antes: o da Bia)');
  assert.match(bia[0].title, new RegExp(`#${b.number}`));
});

test('confirmação: resposta da Inovação num chamado já encerrado e confirmado não pede a confirmação de novo', { skip }, async () => {
  const { id } = await open(U.ana);
  await support.update(id, U.ino, { status: 'resolved' });
  await support.confirm(id, U.ana);
  await support.addMessage(id, U.ino, { body: 'Só registrando: o ajuste foi publicado' });
  const t = await prisma.supportTicket.findUnique({ where: { id } });
  assert.equal(t.status, 'resolved');
  assert.equal(t.authorConfirmed, true, 'a confirmação continua');
  await support.update(id, U.ino, { status: 'review' });
  assert.equal((await prisma.supportTicket.findUnique({ where: { id } })).authorConfirmed, false, 'mudar a situação de verdade zera a confirmação');
});

test('limpeza: chamado reaberto e encerrado de novo volta a ter os anexos novos limpos', { skip }, async () => {
  const { id } = await open(U.ana, {}, [upload('print.png')]);
  await support.update(id, U.ino, { status: 'resolved' });
  await prisma.supportTicket.update({ where: { id }, data: { closedAt: new Date(Date.now() - 91 * 86400_000) } });
  assert.equal(await support.cleanOldAttachments(90), 1);
  await support.reopen(id, U.ana);
  assert.equal((await prisma.supportTicket.findUnique({ where: { id } })).attachmentsCleanedAt, null, 'reaberto: a limpeza recomeça');
  await support.addMessage(id, U.ana, { body: 'Agora com outro print' }, [upload('novo.png')]);
  await support.update(id, U.ino, { status: 'resolved' });
  await prisma.supportTicket.update({ where: { id }, data: { closedAt: new Date(Date.now() - 91 * 86400_000) } });
  assert.equal(await support.cleanOldAttachments(90), 1, 'o anexo novo também é apagado depois do prazo');
  const t = await support.get(id, U.ana);
  const all = t.messages.flatMap((m: any) => m.attachments);
  assert.equal(all.length, 2);
  assert.ok(all.every((x: any) => x.removed));
});

test('e-mail para a Inovação: departamento com o nome certo (acento), não o código', { skip }, async () => {
  const leg = await prisma.user.upsert({
    where: { id: 's-leg' },
    update: { departments: ['legalizacao'], isActive: true },
    create: { id: 's-leg', name: 'Lia', email: 's-leg@example.invalid', passwordHash: 'x', role: 'employee', departments: ['legalizacao'] },
  });
  await open(leg);
  assert.equal(emails[0].authorDepartment, 'Legalização');
  emails.length = 0;
  await prisma.departmentConfig.upsert({ where: { slug: 'legalizacao' }, update: { name: 'Legalização e Registro' }, create: { slug: 'legalizacao', name: 'Legalização e Registro' } });
  try {
    await open(leg);
    assert.equal(emails[0].authorDepartment, 'Legalização e Registro', 'o nome cadastrado do departamento vale mais que o padrão');
  } finally {
    await prisma.departmentConfig.deleteMany({ where: { slug: 'legalizacao' } });
  }
});
