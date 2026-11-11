// Desenha os ícones do aplicativo em código: a marca 03 "Lente" (canvas Marca do Catálogo).
//   node scripts/gerar-icones.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const NADA = [0, 0, 0, 0];

function crc32(b) {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function bloco(tipo, dados) {
  const t = Buffer.concat([Buffer.from(tipo), dados]);
  const tam = Buffer.alloc(4);
  tam.writeUInt32BE(dados.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(t));
  return Buffer.concat([tam, t, crc]);
}

function png(lado, cor) {
  const linhas = Buffer.alloc((lado * 4 + 1) * lado);
  for (let y = 0; y < lado; y++) {
    const inicio = y * (lado * 4 + 1);
    for (let x = 0; x < lado; x++) Buffer.from(cor(x / lado, y / lado)).copy(linhas, inicio + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(lado, 0);
  ihdr.writeUInt32BE(lado, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), bloco('IHDR', ihdr), bloco('IDAT', deflateSync(linhas)), bloco('IEND', Buffer.alloc(0))]);
}

// Marca 03 "Lente": anel verde, miolo verde com código de barras e o ponto do flash, sobre azul-noite.
// Coordenadas no desenho de 120 x 120 da marca (como no SVG), escaladas para o ícone.
const BARRAS = [[40, 4], [48, 8], [60, 4], [68, 6], [77, 3]];
const VERDE = [0x22, 0xc5, 0x5e, 255];
const CLARO = [0xf8, 0xfa, 0xfc, 255];

// escala: o símbolo ocupa `tamanho` (fração do ícone) centrado
function lente(tamanho, fundo) {
  return (x, y) => {
    const u = ((x - 0.5) / tamanho) * 120 + 60;
    const v = ((y - 0.5) / tamanho) * 120 + 60;
    const d = Math.hypot(u - 60, v - 60);
    if (Math.hypot(u - 92, v - 26) <= 6) return CLARO;
    if (d >= 52 && d <= 60) return VERDE;
    if (d <= 38) {
      const barra = v >= 44 && v <= 76 && BARRAS.some(([i, l]) => u >= i && u < i + l);
      return barra ? FUNDO : VERDE;
    }
    return fundo;
  };
}

const FUNDO = [0x0f, 0x17, 0x2a, 255];
mkdirSync('assets', { recursive: true });
// Ícone comum: o símbolo inteiro sobre o fundo azul-noite
writeFileSync('assets/icone.png', png(1024, lente(0.78, FUNDO)));
// Ícone adaptável (Android): só o símbolo, dentro da área segura (o sistema recorta em círculo ou gota)
writeFileSync('assets/icone-frente.png', png(1024, lente(0.56, NADA)));
