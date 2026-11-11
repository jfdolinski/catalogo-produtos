// Cópia consistente dos dados (banco + imagens + config), mesmo com o servidor rodando.
// Uso: node deploy/exportar-dados.mjs <pasta-de-dados-origem> <pasta-destino>
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const [, , from = 'data', to = 'dist/data'] = process.argv;
fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });

const db = new DatabaseSync(path.join(from, 'catalogo.db'));
db.exec(`VACUUM INTO '${path.resolve(to, 'catalogo.db').replace(/'/g, "''")}'`);
db.close();

fs.cpSync(path.join(from, 'images'), path.join(to, 'images'), { recursive: true });
fs.copyFileSync(path.join(from, 'config.json'), path.join(to, 'config.json'));

const imgs = fs.readdirSync(path.join(to, 'images')).length;
const size = fs.statSync(path.join(to, 'catalogo.db')).size;
console.log(`Dados exportados para ${to}: banco ${(size / 1024).toFixed(0)} KB, ${imgs} imagem(ns)`);
