import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codigoDeBarras, codigoValido, comoPrincipal, gtinValido, lerQrDeVinculo, servidorValido, sugestoesUteis, versaoMaisNova, linkMenorPreco } from './regras.ts';

test('QR de vínculo do catálogo', () => {
  assert.deepEqual(lerQrDeVinculo('catalogo://vincular?servidor=https%3A%2F%2Fcatalogo.exemplo.com&codigo=ABCDE23456'), { servidor: 'https://catalogo.exemplo.com', codigo: 'ABCDE23456' });
  assert.equal(lerQrDeVinculo('etiquetas://vincular?servidor=https%3A%2F%2Fx.com&codigo=ABCDE23456'), null, 'QR do Flow não serve');
  assert.equal(lerQrDeVinculo('catalogo://vincular?servidor=http%3A%2F%2Fx.com&codigo=ABCDE23456'), null, 'http só em teste');
  assert.ok(lerQrDeVinculo('catalogo://vincular?servidor=http%3A%2F%2Fx.com&codigo=ABCDE23456', true));
  assert.equal(lerQrDeVinculo('7891000315507'), null);
});

test('endereço e código digitados', () => {
  assert.equal(servidorValido(' https://catalogo.exemplo.com/admin/ '), 'https://catalogo.exemplo.com');
  assert.equal(servidorValido('https://user:senha@x.com'), null);
  assert.equal(servidorValido('catalogo.exemplo.com'), null);
  assert.equal(codigoValido('abcde 23456'), 'ABCDE23456');
  assert.equal(codigoValido('ABCDE-23456'), 'ABCDE23456');
  assert.equal(codigoValido('ABC'), null);
});

test('código de barras', () => {
  assert.deepEqual(codigoDeBarras(' 789 1000-315507 '), { codigo: '7891000315507' });
  assert.ok('erro' in codigoDeBarras(''));
  assert.ok('erro' in codigoDeBarras('https://site.com'));
  assert.ok('erro' in codigoDeBarras('1234567'));
  assert.ok('erro' in codigoDeBarras('123456789012345'));
  assert.equal(gtinValido('7891000315507'), true);
  assert.equal(gtinValido('7891000315508'), false);
  assert.equal(gtinValido('036000291452'), true, 'UPC-A');
  assert.equal(gtinValido('96385074'), true, 'EAN-8');
  assert.equal(gtinValido('123456789'), false, 'tamanho sem dígito GTIN');
});

test('sugestões das bases', () => {
  const r = sugestoesUteis([
    { source: 'a', source_name: 'A', name: 'Café 500g', brand: 'Bom' },
    { source: 'b', source_name: 'B', name: 'café  500g', brand: 'bom' },
    { source: 'c', source_name: 'C', skipped: true },
    { source: 'd', source_name: 'D', name: 'Outro' },
  ]);
  assert.deepEqual(r.map((x) => x.source), ['a', 'd']);
});

test('foto principal e versões', () => {
  assert.deepEqual(comoPrincipal([1, 2, 3], 3), [3, 1, 2]);
  assert.deepEqual(comoPrincipal([1, 2, 3], 9), [1, 2, 3]);
  assert.equal(versaoMaisNova('1.0.10', '1.0.9'), true);
  assert.equal(versaoMaisNova('1.0.0', '1.0.0'), false);
  assert.equal(versaoMaisNova('x', '1.0.0'), false);
});

test('versão publicada com número da compilação', () => {
  // atualizacao.ts compara "1.0.1-5" como "1.0.1.5"
  const comp = (a: string, b: string) => versaoMaisNova(a.replace('-', '.'), b.replace('-', '.'));
  assert.equal(comp('1.0.1-6', '1.0.1-5'), true, 'mesma versão, compilação nova');
  assert.equal(comp('1.0.2-1', '1.0.1-9'), true);
  assert.equal(comp('1.0.1-5', '1.0.1-5'), false);
  assert.equal(comp('1.0.0-2', '1.0.1-3'), false);
});

test('ajustes da câmera', async () => {
  const { normalizarAjustes, AJUSTES_PADRAO, planoDaFoto } = await import('./regras.ts');
  assert.deepEqual(normalizarAjustes(null), AJUSTES_PADRAO);
  assert.deepEqual(normalizarAjustes({ zoom: 0.3, flash: 'auto', lanterna: true, formato: '1:1', som: true }), { ...AJUSTES_PADRAO, zoom: 0.3, flash: 'auto', lanterna: true, formato: '1:1', som: true });
  const ruim = normalizarAjustes({ zoom: 7, flash: 'laser', qualidade: '0.9', ladoMaximo: 999, maxFotos: -1, lanterna: 'sim' });
  assert.deepEqual(ruim, AJUSTES_PADRAO, 'valores fora das opções voltam ao padrão');
  assert.deepEqual(planoDaFoto(4000, 3000, { formato: '4:3', ladoMaximo: 1600 }), { recorte: null, novo: { width: 1600 } });
  assert.deepEqual(planoDaFoto(3000, 4000, { formato: '4:3', ladoMaximo: 1600 }), { recorte: null, novo: { height: 1600 } });
  assert.deepEqual(planoDaFoto(4000, 3000, { formato: '1:1', ladoMaximo: 1600 }), { recorte: { originX: 500, originY: 0, width: 3000, height: 3000 }, novo: { width: 1600 } });
  assert.deepEqual(planoDaFoto(1200, 900, { formato: '4:3', ladoMaximo: 1600 }), { recorte: null, novo: null }, 'foto menor não aumenta');
  assert.deepEqual(planoDaFoto(4000, 3000, { formato: '4:3', ladoMaximo: 0 }), { recorte: null, novo: null }, 'original');
});

test('link do Menor Preço', () => {
  assert.equal(linkMenorPreco(' 7898079002963 '), 'https://menorpreco.notaparana.pr.gov.br/app?termo=7898079002963&local=6gkzqf9vb');
});
