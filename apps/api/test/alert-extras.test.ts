import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExtras,
  cleanWarnings,
  MAX_ALERT_WARNINGS,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOTS,
  MAX_WARNING_CHARS,
  SCREENSHOT_NAME_PATTERN,
  screenshotAttachments,
} from '../src/mail/alert-extras';
import { buildScheduledExecutionAlert, buildScheduledWarningAlert, type ScheduledExecutionAlertInput } from '../src/mail/scheduled-execution-alert';
import { buildRestartFailedAlert, restartFailedInputFrom } from '../src/mail/schedule-check-alert';

const png = (n = 100) => Buffer.alloc(n, 1);

test('cleanWarnings: tira vazios e repetidos, junta espaços, corta cada aviso e limita a quantidade', () => {
  assert.deepEqual(cleanWarnings(undefined), []);
  assert.deepEqual(cleanWarnings(['', '   ', null, undefined]), []);
  assert.deepEqual(cleanWarnings(['  coluna   não achada  ', 'coluna não achada', 'outro']), ['coluna não achada', 'outro']);
  const longo = cleanWarnings(['x'.repeat(1000)])[0];
  assert.equal(longo.length, MAX_WARNING_CHARS);
  assert.ok(longo.endsWith('…'));
  const muitos = cleanWarnings(Array.from({ length: 40 }, (_, i) => `aviso ${i}`));
  assert.equal(muitos.length, MAX_ALERT_WARNINGS);
  assert.equal(muitos[0], 'aviso 0');
});

test('screenshotAttachments: só imagens dentro do limite de tamanho, no máximo 2, com cid e tipo certos', () => {
  const anexos = screenshotAttachments([
    { filename: 'erro_1.png', content: png() },
    { filename: 'erro_2.jpg', content: png() },
    { filename: 'erro_3.png', content: png() },                                    // passou de 2
  ]);
  assert.equal(anexos.length, MAX_SCREENSHOTS);
  assert.equal(anexos[0].contentType, 'image/png');
  assert.equal(anexos[1].contentType, 'image/jpeg');
  assert.match(anexos[0].cid, /^print-1@/);
  assert.notEqual(anexos[0].cid, anexos[1].cid);

  assert.equal(screenshotAttachments([{ filename: 'erro.png', content: Buffer.alloc(0) }]).length, 0, 'vazia não vai');
  assert.equal(screenshotAttachments([{ filename: 'erro.png', content: png(MAX_SCREENSHOT_BYTES + 1) }]).length, 0, 'grande demais não vai');
  assert.equal(screenshotAttachments([{ filename: 'erro <x>.png', content: png() }])[0].filename, 'erro _x_.png');
  assert.deepEqual(screenshotAttachments(undefined), []);
});

test('SCREENSHOT_NAME_PATTERN: só erro_*.png/.jpg/.jpeg na pasta de saída', () => {
  for (const ok of ['erro_2026-11-16_11-20.png', 'erro.png', 'ERRO_x.JPG', 'erro_a.jpeg']) assert.ok(SCREENSHOT_NAME_PATTERN.test(ok), ok);
  for (const ruim of ['relatorio.png', 'erro.xlsx', 'meu_erro.png', 'erro/../x.png', 'erro_a.png.exe']) assert.equal(SCREENSHOT_NAME_PATTERN.test(ruim), false, ruim);
});

test('buildExtras: sem avisos nem print não acrescenta nada', () => {
  const e = buildExtras({});
  assert.deepEqual(e.text, []);
  assert.equal(e.html, '');
  assert.deepEqual(e.attachments, []);
});

test('buildExtras: avisos viram lista e o print vira imagem do e-mail (cid) com a nota de privacidade', () => {
  const e = buildExtras({ warnings: ['Coluna "Apontamento - Tempo" não encontrada'], screenshots: [{ filename: 'erro_1.png', content: png() }] });
  assert.ok(e.text.some((l) => l.includes('- Coluna "Apontamento - Tempo" não encontrada')));
  assert.ok(e.text.some((l) => /anexado/.test(l) && /borrados/.test(l)));
  assert.match(e.html, /<li>Coluna &quot;Apontamento - Tempo&quot; não encontrada<\/li>/);
  assert.match(e.html, /src="cid:print-1@automation-hub"/);
  assert.equal(e.attachments.length, 1);
});

const base: ScheduledExecutionAlertInput = {
  kind: 'error', robotName: 'Gestta', scheduleName: 'Gestta 06:30', executionId: 'cm1',
  startedAt: new Date('2026-11-16T09:30:00Z'), finishedAt: new Date('2026-11-16T09:40:00Z'),
  errorMessage: 'Falha ao baixar', baseUrl: 'https://hub.exemplo.com',
};

test('e-mail de erro: leva os avisos e o print anexado (e continua igual sem eles)', () => {
  const simples = buildScheduledExecutionAlert(base);
  assert.equal(simples.attachments, undefined);
  assert.ok(!simples.text.includes('Avisos durante'));

  const completo = buildScheduledExecutionAlert({ ...base, warnings: ['aviso A'], screenshots: [{ filename: 'erro_1.png', content: png() }] });
  assert.equal(completo.attachments?.length, 1);
  assert.match(completo.text, /Avisos durante a execução:\n- aviso A/);
  assert.match(completo.html, /cid:print-1@automation-hub/);
  assert.match(completo.html, /aviso A/);
  assert.ok(completo.text.indexOf('Avisos durante') < completo.text.indexOf('Abrir a execução'), 'extras antes do link');
});

test('e-mail de AVISO (sucesso com avisos): assunto "Atenção", lista os avisos, link e sem anexo', () => {
  const m = buildScheduledWarningAlert({
    robotName: 'Gestta', scheduleName: 'Gestta 06:30', executionId: 'cm1',
    startedAt: base.startedAt, finishedAt: base.finishedAt, warnings: ['a', 'b'], baseUrl: 'https://hub.exemplo.com',
  });
  assert.equal(m.subject, '⚠️ Atenção: Gestta — Gestta 06:30');
  assert.match(m.text, /terminou com sucesso, mas registrou 2 avisos/);
  assert.match(m.text, /- a\n- b/);
  assert.match(m.text, /https:\/\/hub\.exemplo\.com\/executions\/cm1/);
  assert.match(m.html, /<li>a<\/li><li>b<\/li>/);
  assert.equal(m.attachments, undefined);
  const um = buildScheduledWarningAlert({ robotName: 'X', scheduleName: 'Y', executionId: 'e', startedAt: null, finishedAt: null, warnings: ['só um'], baseUrl: null });
  assert.match(um.text, /registrou um aviso/);
  assert.ok(!um.text.includes('Abrir a execução'), 'sem endereço público não vai link');
});

test('e-mail final do reinício: leva os avisos e o print da 2ª tentativa', () => {
  const data = { robotName: 'Gestta', scheduleName: 'Gestta 06:30', startedAt: base.startedAt, finishedAt: base.finishedAt, errorMessage: 'falhou de novo',
    first: { executionId: 'e0', startedAt: base.startedAt, finishedAt: base.finishedAt, outcome: 'travou' } };
  const input = restartFailedInputFrom(data, 'e1', 'https://hub.exemplo.com', [], { warnings: ['w1'], screenshots: [{ filename: 'erro_2.png', content: png() }] })!;
  const m = buildRestartFailedAlert(input);
  assert.equal(m.attachments?.length, 1);
  assert.match(m.text, /- w1/);
  assert.match(m.html, /cid:print-1@automation-hub/);
  const sem = buildRestartFailedAlert(restartFailedInputFrom(data, 'e1', null)!);
  assert.equal(sem.attachments, undefined);
});
