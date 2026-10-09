import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeScreenContext } from '../src/site-chat/screen-context';

test('aceita o formato que o painel manda hoje', () => {
  const result = sanitizeScreenContext({ pagina: 'Colaborador - BI DEPES', filtros: { Ano: '2026', 'Mês': 'Setembro', Colaborador: 'ANA, BIA' } });
  assert.deepEqual(result, { pagina: 'Colaborador - BI DEPES', filtros: { Ano: '2026', 'Mês': 'Setembro', Colaborador: 'ANA, BIA' } });
});

test('rejeita o que não é objeto', () => {
  for (const bad of [null, undefined, 'texto', 42, ['a'], true]) assert.equal(sanitizeScreenContext(bad), null);
});

test('página ausente vira "(desconhecida)" e filtros ausentes viram vazio', () => {
  assert.deepEqual(sanitizeScreenContext({}), { pagina: '(desconhecida)', filtros: {} });
  assert.deepEqual(sanitizeScreenContext({ pagina: '   ', filtros: 'x' }), { pagina: '(desconhecida)', filtros: {} });
});

test('descarta filtros com chave ou valor que não são texto e vazios', () => {
  const result = sanitizeScreenContext({ pagina: 'P', filtros: { Ano: 2026, Mes: '', Ok: 'sim', Lista: ['a'], Nulo: null } });
  assert.deepEqual(result?.filtros, { Ok: 'sim' });
});

test('remove quebras de linha e caracteres de controle (evita injetar instruções em várias linhas)', () => {
  const result = sanitizeScreenContext({ pagina: 'Linha1\nLinha2\u0000', filtros: { 'A\nB': 'x\r\ny' } });
  assert.equal(result?.pagina, 'Linha1 Linha2');
  assert.deepEqual(result?.filtros, { 'A B': 'x y' });
});

test('aplica limites de tamanho e de quantidade de filtros', () => {
  const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`F${i}`, 'v']));
  const result = sanitizeScreenContext({ pagina: 'p'.repeat(500), filtros: { ...many, Longo: 'z'.repeat(5000) } });
  assert.equal(result?.pagina.length, 200);
  assert.ok(Object.keys(result!.filtros).length <= 30);
  for (const value of Object.values(result!.filtros)) assert.ok(value.length <= 600);
});

test('se o conjunto continuar grande demais, mantém só a página', () => {
  const heavy = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`Filtro${i}`, 'x'.repeat(600)]));
  const result = sanitizeScreenContext({ pagina: 'P', filtros: heavy });
  assert.deepEqual(result, { pagina: 'P', filtros: {} });
});
