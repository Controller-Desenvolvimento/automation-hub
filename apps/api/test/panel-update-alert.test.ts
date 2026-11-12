import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPanelUpdateAlert, panelLink } from '../src/mail/panel-update-alert';

const base = {
  panelName: 'BI Indicadores Fiscal',
  slug: 'bi-indicadores-fiscal',
  attempts: [
    { at: new Date('2026-11-12T09:00:30Z'), error: 'Update endpoint responded with status 500 — banco fora' },
    { at: new Date('2026-11-12T09:05:40Z'), error: 'A atualização passou do tempo limite e foi interrompida.' },
  ],
  baseUrl: 'https://hubcontroller.com.br',
};

test('panelLink abre a tela de painéis já no painel, e nunca com endereço local', () => {
  assert.equal(panelLink('https://h.com', 'meu-painel'), 'https://h.com/sites?tab=paineis&painel=meu-painel');
  assert.equal(panelLink(null, 'x'), null);
  assert.equal(panelLink('http://localhost:3000', 'x'), null);
  assert.equal(panelLink('http://127.0.0.1:3000', 'x'), null);
});

test('e-mail final: assunto, as duas tentativas com motivo e o link', () => {
  const mail = buildPanelUpdateAlert(base);
  assert.equal(mail.subject, '⚠️ Painel não atualizou: BI Indicadores Fiscal');
  assert.match(mail.text, /falhou em 2 tentativas/);
  assert.match(mail.text, /1ª tentativa: .* — Update endpoint responded with status 500 — banco fora/);
  assert.match(mail.text, /2ª tentativa: .* — A atualização passou do tempo limite/);
  assert.match(mail.text, /dados da última atualização bem-sucedida/);
  assert.match(mail.text, /Abrir os painéis: https:\/\/hubcontroller\.com\.br\/sites\?tab=paineis&painel=bi-indicadores-fiscal/);
  assert.match(mail.html, /falhou nas 2 tentativas/);
  assert.match(mail.html, /href="https:\/\/hubcontroller\.com\.br\/sites\?tab=paineis&amp;painel=bi-indicadores-fiscal"/);
});

test('sem endereço válido sai sem link; erro vazio avisa; HTML escapa', () => {
  const mail = buildPanelUpdateAlert({
    ...base,
    baseUrl: 'http://localhost:3000',
    panelName: '<b>X</b>',
    attempts: [{ at: null, error: null }, { at: new Date(), error: '<script>1</script>' }],
  });
  assert.doesNotMatch(mail.text, /Abrir os painéis|localhost/);
  assert.doesNotMatch(mail.html, /<a href|localhost/);
  assert.match(mail.text, /sem detalhes registrados/);
  assert.doesNotMatch(mail.html, /<script>1|<b>X<\/b>/);
});

test('motivo longo é encurtado', () => {
  const mail = buildPanelUpdateAlert({ ...base, attempts: [{ at: new Date(), error: 'z'.repeat(3000) }] });
  const linha = mail.text.split('\n').find((l) => l.startsWith('1ª tentativa'))!;
  assert.ok(linha.length < 600, String(linha.length));
  assert.match(mail.text, /falhou na tentativa e precisa/);
});
