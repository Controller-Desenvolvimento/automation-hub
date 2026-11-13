import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { createProxyMiddleware } from 'http-proxy-middleware';
import express from 'express';
import {
  ATHENAS_NAME_SELECT,
  chooseSyncedName,
  decodeAthenasBuffer,
  describeRawName,
  hasBrokenNameChars,
  readAthenasName,
} from '../src/shared/athenas-identity';
import { headerSafe } from '../src/shared/header-value';

const COM_ACENTO = 'Maria Silva Araújo';
const QUEBRADO = 'Maria Silva Ara�jo';

test('headerSafe: acentos do português passam intactos; "�", quebra de linha e outros viram "?"', () => {
  assert.equal(headerSafe(COM_ACENTO), COM_ACENTO);
  assert.equal(headerSafe('José Carlos Conceição'), 'José Carlos Conceição');
  assert.equal(headerSafe(QUEBRADO), 'Maria Silva Ara?jo');
  assert.equal(headerSafe('Ana\r\nX-Injetado: 1'), 'Ana??X-Injetado: 1');
  assert.equal(headerSafe('Łukasz'), '?ukasz');
  assert.equal(headerSafe('maria.silva@athenas.local'), 'maria.silva@athenas.local');
});

test('o valor devolvido por headerSafe é sempre aceito pelo Node em setHeader', () => {
  const req = http.request({ host: 'localhost', port: 1 }, () => undefined);
  req.on('error', () => undefined);
  for (const nome of [COM_ACENTO, QUEBRADO, 'a\u0000b', 'x\u007fy', '日本語', '�']) {
    assert.doesNotThrow(() => req.setHeader('X-Hub-User-Name', headerSafe(nome)), JSON.stringify(nome));
  }
  // e o problema que motivou a correção: sem o filtro o Node recusa o "�"
  assert.throws(() => req.setHeader('X-Hub-User-Name', QUEBRADO), { code: 'ERR_INVALID_CHAR' });
  req.destroy();
});

test('proxy no mesmo formato do hub: nome com "�" chega ao painel (antes: 504 / ERR_INVALID_CHAR)', async () => {
  let recebido: string | undefined;
  const painel = http.createServer((req, res) => {
    recebido = Buffer.from(String(req.headers['x-hub-user-name']), 'latin1').toString('latin1');
    res.end('ok');
  });
  await new Promise<void>((r) => painel.listen(0, '127.0.0.1', r));
  const portaPainel = (painel.address() as { port: number }).port;

  let nomeAtual = COM_ACENTO;
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).hubUser = { name: nomeAtual, email: 'x@athenas.local' };
    next();
  });
  app.use(
    createProxyMiddleware({
      target: `http://127.0.0.1:${portaPainel}`,
      changeOrigin: true,
      on: {
        proxyReq: (proxyReq, req) => {
          const user = (req as unknown as Record<string, unknown>).hubUser as { name?: string; email?: string };
          if (user?.name) proxyReq.setHeader('X-Hub-User-Name', headerSafe(user.name));
          if (user?.email) proxyReq.setHeader('X-Hub-User-Email', headerSafe(user.email));
        },
      },
    }),
  );
  const hub = http.createServer(app);
  await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r));
  const porta = (hub.address() as { port: number }).port;

  try {
    for (const [nome, esperado] of [
      [COM_ACENTO, COM_ACENTO],
      [QUEBRADO, 'Maria Silva Ara?jo'],
    ]) {
      nomeAtual = nome;
      const resposta = await fetch(`http://127.0.0.1:${porta}/x`);
      assert.equal(resposta.status, 200, JSON.stringify(nome));
      assert.equal(recebido, esperado);
    }
  } finally {
    hub.close();
    painel.close();
    hub.closeAllConnections();
    painel.closeAllConnections();
  }
});

test('trava: o proxy dos painéis nunca coloca nome/e-mail no cabeçalho sem headerSafe', () => {
  const fonte = readFileSync(join(__dirname, '..', 'src', 'dashboard', 'dashboard.service.ts'), 'utf8');
  const chamadas = fonte.match(/setHeader\(\s*'X-Hub-User-[^']+'[^)]*\)+/g) ?? [];
  assert.ok(chamadas.length >= 2, 'esperava encontrar as chamadas de setHeader do usuário');
  for (const c of chamadas) assert.match(c, /headerSafe\(/, c);
});

test('chooseSyncedName: nome corrompido não sobrescreve um nome bom; o resto segue o Athenas', () => {
  assert.ok(hasBrokenNameChars(QUEBRADO));
  assert.ok(!hasBrokenNameChars(COM_ACENTO));
  assert.ok(!hasBrokenNameChars(undefined));
  // o Athenas manda corrompido e o Hub já tem o certo → mantém o certo
  assert.equal(chooseSyncedName(COM_ACENTO, QUEBRADO), COM_ACENTO);
  // o Athenas manda certo e o Hub tinha corrompido → corrige (auto-reparo no próximo login)
  assert.equal(chooseSyncedName(QUEBRADO, COM_ACENTO), COM_ACENTO);
  // os dois corrompidos, ou usuário novo: não há melhor opção
  assert.equal(chooseSyncedName(QUEBRADO, QUEBRADO), QUEBRADO);
  assert.equal(chooseSyncedName(undefined, QUEBRADO), QUEBRADO);
  // troca legítima de nome continua valendo
  assert.equal(chooseSyncedName('Maria Souza', 'Maria Souza Lima'), 'Maria Souza Lima');
  assert.equal(chooseSyncedName('Maria', 'Maria'), 'Maria');
});

test('describeRawName: mostra só o que está fora do ASCII, nunca o nome inteiro', () => {
  const buf = Buffer.from([0x41, 0x72, 0x61, 0xef, 0xbf, 0xbd, 0x6a, 0x6f]);
  const d1 = describeRawName(buf);
  assert.match(d1, /Buffer de 8 bytes/);
  assert.match(d1, /\[ef bf bd\]/);
  assert.ok(!d1.includes('Ara'));
  const d2 = describeRawName(QUEBRADO);
  assert.match(d2, /string/);
  assert.match(d2, /\[U\+FFFD\]/);
  assert.ok(!d2.includes('Maria'));
  assert.match(describeRawName(null), /\[\]/);
});

// Bytes reais lidos do Athenas (coluna NOME, charset NONE): Windows-1252 de 1 byte, Ú = 0xDA, É = 0xC9.
const BYTES_ARAUJO = Buffer.from('4d 41 52 49 41 20 53 49 4c 56 41 20 41 52 41 da 4a 4f'.replace(/ /g, ''), 'hex');
const BYTES_JOSE = Buffer.from('4a 4f 53 c9 20 43 41 52 4c 4f 53'.replace(/ /g, ''), 'hex');

test('decodeAthenasBuffer: bytes reais do Athenas (Windows-1252) saem com o acento, sem "�"', () => {
  assert.equal(decodeAthenasBuffer(BYTES_ARAUJO), 'MARIA SILVA ARAÚJO');
  assert.equal(decodeAthenasBuffer(BYTES_JOSE), 'JOSÉ CARLOS');
  assert.equal(decodeAthenasBuffer(Buffer.from('c7c3', 'hex')), 'ÇÃ'); // sequência que NÃO é UTF-8 válido
  assert.equal(decodeAthenasBuffer(Buffer.from([0x80])), '€'); // faixa 0x80–0x9f é do Windows-1252, não do latin1
  // o que o driver fazia antes: ler como UTF-8 e perder a letra
  assert.ok(BYTES_ARAUJO.toString('utf8').includes('�'));
  for (const b of [BYTES_ARAUJO, BYTES_JOSE]) assert.ok(!decodeAthenasBuffer(b).includes('�'));
});

test('decodeAthenasBuffer: cadastros gravados em UTF-8 (há alguns) continuam certos', () => {
  assert.equal(decodeAthenasBuffer(Buffer.from('JOSÉ ARAÚJO', 'utf8')), 'JOSÉ ARAÚJO');
  assert.equal(decodeAthenasBuffer(Buffer.from('ÁGATHA', 'utf8')), 'ÁGATHA'); // c3 81 ...
  assert.equal(decodeAthenasBuffer(Buffer.from('ANA PAULA', 'utf8')), 'ANA PAULA');
});

test('readAthenasName: Buffer cru, texto com mojibake, texto simples e vazio', () => {
  assert.equal(readAthenasName(BYTES_ARAUJO), 'MARIA SILVA ARAÚJO');
  assert.equal(readAthenasName(Buffer.from('  ANA  ')), 'ANA');
  assert.equal(readAthenasName('ARA\u00c3\u009aJO'), 'ARAÚJO'); // UTF-8 lido como latin1 (caminho antigo, mantido)
  assert.equal(readAthenasName('ANA'), 'ANA');
  assert.equal(readAthenasName(''), undefined);
  assert.equal(readAthenasName(null), undefined);
  assert.equal(readAthenasName(Buffer.alloc(0)), undefined);
});

test('o SELECT do nome pede bytes crus (OCTETS), com alias NOME, nas duas consultas do serviço', () => {
  assert.match(ATHENAS_NAME_SELECT, /^CAST\(NOME AS VARCHAR\(\d+\) CHARACTER SET OCTETS\) AS NOME$/);
  const fonte = readFileSync(join(__dirname, '..', 'src', 'auth', 'athenas.service.ts'), 'utf8');
  assert.equal(fonte.split('ATHENAS_NAME_SELECT').length - 1, 3, 'import + authenticate + findActiveUserName');
  assert.ok(!/\[\s*nomeCol\s*,/.test(fonte) && !/,\s*nomeCol\s*,/.test(fonte), 'nenhuma consulta pode pedir NOME "puro" de novo');
});
