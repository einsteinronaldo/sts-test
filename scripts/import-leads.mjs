/**
 * import-leads.mjs — Script ONE-OFF de importação de histórico de leads para Redis
 *
 * USO:
 *   Dry-run (sem escrever no Redis):
 *     node scripts/import-leads.mjs leads.csv --dry-run
 *
 *   Importação real:
 *     UPSTASH_REDIS_REST_URL=https://... UPSTASH_REDIS_REST_TOKEN=xxx \
 *       node scripts/import-leads.mjs leads.csv
 *
 * FORMATO CSV ACEITE:
 *   - Primeira linha: cabeçalhos (qualquer ordem, acentos e maiúsculas ignorados)
 *   - Colunas obrigatórias: data, telemóvel/telefone/tel, e-mail/email
 *   - Coluna nome é ignorada
 *   - Separador: vírgula ou ponto-e-vírgula (detectado automaticamente)
 *   - Encoding: UTF-8 (ou Latin-1 com nomes de coluna garbled — ambos suportados)
 *
 *   Formatos de data aceites:
 *     YYYY/MM/DD HH:mm:ss  →  2026/08/10 12:52:00
 *     YYYY-MM-DD HH:mm:ss  →  2026-08-10 14:32:00
 *     DD/MM/YYYY HH:mm:ss  →  10/08/2026 14:32:00
 *     ISO 8601             →  2026-08-10T14:32:00Z
 *
 * COMPORTAMENTO:
 *   - Consolida duplicados: usa a data MAIS RECENTE por chave (tel e email independentes)
 *   - TTL = 30 dias - idade da ocorrência mais recente dessa chave
 *   - Nunca reduz TTL já existente no Redis (aplica max)
 *   - Dry-run não toca no Redis
 */

import { readFileSync } from 'node:fs';

const DEDUP_WINDOW_S = 2592000; // 30 dias em segundos
const BATCH_SIZE = 100;
const IS_DRY_RUN = process.argv.includes('--dry-run');

// ─── Normalização ──────────────────────────────────────────────────────────────

function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('00351')) digits = digits.slice(5);
  else if (digits.startsWith('351') && digits.length === 12) digits = digits.slice(3);
  else digits = digits.replace(/^0+/, '');
  if (!/^9\d{8}$/.test(digits)) return null;
  return digits; // 9 dígitos, sem prefixo
}

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// ─── Parsing de data ────────────────────────────────────────────────────────────

function parseDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  // YYYY/MM/DD ou YYYY-MM-DD (com ou sem hora)
  let m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[\sT](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const d = new Date(
      parseInt(m[1], 10),
      parseInt(m[2], 10) - 1,
      parseInt(m[3], 10),
      m[4] ? parseInt(m[4], 10) : 0,
      m[5] ? parseInt(m[5], 10) : 0,
      m[6] ? parseInt(m[6], 10) : 0
    );
    return isNaN(d.getTime()) ? null : d;
  }

  // DD/MM/YYYY (com ou sem hora)
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const d = new Date(
      parseInt(m[3], 10),
      parseInt(m[2], 10) - 1,
      parseInt(m[1], 10),
      m[4] ? parseInt(m[4], 10) : 0,
      m[5] ? parseInt(m[5], 10) : 0,
      m[6] ? parseInt(m[6], 10) : 0
    );
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

// ─── CSV ────────────────────────────────────────────────────────────────────────

function detectSeparator(line) {
  const commas = (line.match(/,/g) || []).length;
  const semis  = (line.match(/;/g)  || []).length;
  return semis > commas ? ';' : ',';
}

function parseCsvLine(line, sep) {
  const fields = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === sep && !inQ) {
      fields.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur.trim());
  return fields;
}

// Normaliza nome de coluna: lowercase, só letras a-z
// Funciona tanto com UTF-8 correcto como com Latin-1 garbled (ex: "TelemÃ³vel")
function colKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
}

function findCol(headers, patterns) {
  for (let i = 0; i < headers.length; i++) {
    const k = colKey(headers[i]);
    for (const p of patterns) {
      if (typeof p === 'string' ? (k === p || k.includes(p)) : p.test(k)) return i;
    }
  }
  return -1;
}

// ─── Upstash REST ────────────────────────────────────────────────────────────────

async function upstashPipeline(commands) {
  const base  = (process.env.UPSTASH_REDIS_REST_URL  || '').replace(/\/$/, '');
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!base || !token) throw new Error('UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN são obrigatórios.');

  const resp = await fetch(base + '/pipeline', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('Upstash HTTP ' + resp.status + ': ' + text);
  }
  return await resp.json();
}

// ─── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  const filePath = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!filePath) {
    console.error('Uso: node scripts/import-leads.mjs <ficheiro.csv> [--dry-run]');
    process.exit(1);
  }

  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error('Erro ao ler ficheiro:', err.message);
    process.exit(1);
  }

  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    console.error('Ficheiro vazio ou só com cabeçalhos.');
    process.exit(1);
  }

  const sep     = detectSeparator(lines[0]);
  const headers = parseCsvLine(lines[0], sep);

  // Detecção de colunas: insensível a maiúsculas, acentos e codificação garbled
  const iDate  = findCol(headers, ['dat', 'date', 'timestamp']);
  const iPhone = findCol(headers, ['tel', 'phone', 'mobile', 'tele']);
  const iEmail = findCol(headers, ['mail']);

  if (iDate === -1 || iPhone === -1 || iEmail === -1) {
    console.error('\nERRO: Não foi possível detectar todas as colunas necessárias.');
    console.error('Colunas encontradas:', headers.map((h, i) => `[${i}]="${h}"`).join(' | '));
    console.error('Colunas em falta:', [
      iDate  === -1 ? 'data'     : null,
      iPhone === -1 ? 'telefone' : null,
      iEmail === -1 ? 'email'    : null,
    ].filter(Boolean).join(', '));
    process.exit(1);
  }

  console.log('═══ CONFIGURAÇÃO ════════════════════════════════════');
  console.log(`Separador : ${sep === ',' ? 'vírgula (,)' : 'ponto-e-vírgula (;)'}`);
  console.log(`Data      : coluna "${headers[iDate]}"`);
  console.log(`Telefone  : coluna "${headers[iPhone]}"`);
  console.log(`E-mail    : coluna "${headers[iEmail]}"`);
  console.log(`Total de linhas de dados: ${lines.length - 1}`);
  console.log('═════════════════════════════════════════════════════\n');

  const now      = Date.now();
  const windowMs = DEDUP_WINDOW_S * 1000;
  const cutoff   = new Date(now - windowMs);

  // Mapas de consolidação: chave normalizada → data mais recente
  // Telefone e email são tratados como chaves INDEPENDENTES
  const phoneMap = new Map(); // '919559561' → Date (mais recente)
  const emailMap = new Map(); // 'test@email.com' → Date (mais recente)

  let totalLines      = lines.length - 1;
  let skippedOld      = 0;
  let skippedBadDate  = 0;
  let skippedBadPhone = 0;
  let skippedBadEmail = 0;
  let totalValid      = 0;
  let phonesFound     = 0; // ocorrências brutas de telefone válido
  let emailsFound     = 0; // ocorrências brutas de email válido
  let oldestDate      = null;
  let newestDate      = null;

  for (let i = 1; i < lines.length; i++) {
    const cols     = parseCsvLine(lines[i], sep);
    const rawDate  = cols[iDate]  || '';
    const rawPhone = cols[iPhone] || '';
    const rawEmail = cols[iEmail] || '';

    // Validar data
    const leadDate = parseDate(rawDate);
    if (!leadDate) {
      skippedBadDate++;
      continue;
    }
    if (leadDate < cutoff) {
      skippedOld++;
      continue;
    }

    // Normalizar telefone e email (independentemente)
    const phone  = normalizePhone(rawPhone);
    const email  = normalizeEmail(rawEmail);
    const emailOk = isValidEmail(email);

    if (!phone) skippedBadPhone++;
    if (!emailOk) skippedBadEmail++;

    if (!phone && !emailOk) continue; // nada válido nesta linha

    totalValid++;

    if (!oldestDate || leadDate < oldestDate) oldestDate = leadDate;
    if (!newestDate || leadDate > newestDate) newestDate = leadDate;

    // Actualizar phoneMap com a data mais recente para este telefone
    if (phone) {
      phonesFound++;
      const prev = phoneMap.get(phone);
      if (!prev || leadDate > prev) phoneMap.set(phone, leadDate);
    }

    // Actualizar emailMap com a data mais recente para este email
    if (emailOk) {
      emailsFound++;
      const prev = emailMap.get(email);
      if (!prev || leadDate > prev) emailMap.set(email, leadDate);
    }
  }

  // Calcular TTLs por chave (baseado na ocorrência mais recente de cada chave)
  const phoneEntries = [];
  for (const [phone, date] of phoneMap) {
    const ttl = Math.floor((date.getTime() + windowMs - now) / 1000);
    if (ttl > 0) phoneEntries.push({ key: 'lead:tel:' + phone, ttl, date });
  }

  const emailEntries = [];
  for (const [email, date] of emailMap) {
    const ttl = Math.floor((date.getTime() + windowMs - now) / 1000);
    if (ttl > 0) emailEntries.push({ key: 'lead:email:' + email, ttl, date });
  }

  const consolidatedPhones = phonesFound  - phoneEntries.length;
  const consolidatedEmails = emailsFound  - emailEntries.length;

  // ─── DRY-RUN REPORT ──────────────────────────────────────────────────────────
  console.log('═══ RELATÓRIO DRY-RUN ═══════════════════════════════');
  console.log(`Total de linhas lidas             : ${totalLines}`);
  console.log(`Linhas válidas processadas         : ${totalValid}`);
  console.log(`Ignoradas (mais de 30 dias)        : ${skippedOld}`);
  console.log(`Ignoradas (data inválida)          : ${skippedBadDate}`);
  console.log(`Com telefone inválido              : ${skippedBadPhone}`);
  console.log(`Com email inválido                 : ${skippedBadEmail}`);
  console.log('─────────────────────────────────────────────────────');
  console.log(`Ocorrências brutas de telefone     : ${phonesFound}`);
  console.log(`Telefones únicos a importar        : ${phoneEntries.length}`);
  console.log(`Telefones consolidados (dedup int.): ${consolidatedPhones}`);
  console.log('─────────────────────────────────────────────────────');
  console.log(`Ocorrências brutas de email        : ${emailsFound}`);
  console.log(`Emails únicos a importar           : ${emailEntries.length}`);
  console.log(`Emails consolidados (dedup int.)   : ${consolidatedEmails}`);
  console.log('─────────────────────────────────────────────────────');
  console.log(`Data mais antiga considerada       : ${oldestDate ? oldestDate.toISOString().slice(0,19).replace('T',' ') : 'N/A'}`);
  console.log(`Data mais recente considerada      : ${newestDate ? newestDate.toISOString().slice(0,19).replace('T',' ') : 'N/A'}`);
  console.log(`Total de chaves Redis a criar/upd. : ${phoneEntries.length + emailEntries.length}`);
  console.log('═════════════════════════════════════════════════════');

  if (IS_DRY_RUN) {
    console.log('\nModo --dry-run: nenhuma escrita no Redis. Terminou.');
    return;
  }

  // ─── IMPORTAÇÃO REAL ─────────────────────────────────────────────────────────

  const allEntries = [...phoneEntries, ...emailEntries];
  if (allEntries.length === 0) {
    console.log('\nNada a importar — todas as chaves têm TTL <= 0.');
    return;
  }

  console.log(`\nIniciando importação de ${allEntries.length} chaves...`);
  console.log('Passo 1/3: consultar TTLs actuais no Redis...');

  // Passo 1: obter TTLs actuais em pipeline
  const ttlCommands = allEntries.map(e => ['TTL', e.key]);
  let currentTtls;
  try {
    const results = await upstashPipeline(ttlCommands);
    currentTtls = results.map(r => (r && typeof r.result === 'number') ? r.result : -2);
  } catch (err) {
    console.error('Erro ao consultar TTLs:', err.message);
    process.exit(1);
  }

  // Passo 2: decidir o que escrever (max TTL)
  const toSet    = []; // chaves que não existem → SET NX EX
  const toExpire = []; // chaves com TTL menor → EXPIRE (estender)
  let   skippedLonger = 0;

  for (let i = 0; i < allEntries.length; i++) {
    const { key, ttl } = allEntries[i];
    const cur = currentTtls[i];

    if (cur === -2) {
      toSet.push({ key, ttl });
    } else if (cur >= 0 && cur < ttl) {
      toExpire.push({ key, ttl });
    } else {
      // cur >= ttl: chave já tem TTL maior — não reduzir
      skippedLonger++;
    }
  }

  console.log(`Passo 2/3: decisão por chave:`);
  console.log(`  Novas chaves (não existem)      : ${toSet.length}`);
  console.log(`  Actualizar TTL (histórico maior): ${toExpire.length}`);
  console.log(`  Manter TTL (já maior no Redis)  : ${skippedLonger}`);

  // Passo 3: escrever em batches
  console.log('Passo 3/3: a escrever no Redis...');

  const writeCommands = [
    ...toSet.map(e    => ['SET', e.key, '1', 'EX', e.ttl, 'NX']),
    ...toExpire.map(e => ['EXPIRE', e.key, e.ttl])
  ];

  let written = 0, errors = 0;

  for (let offset = 0; offset < writeCommands.length; offset += BATCH_SIZE) {
    const batch = writeCommands.slice(offset, offset + BATCH_SIZE);
    try {
      await upstashPipeline(batch);
      written += batch.length;
      process.stdout.write(`\r  Escritas: ${Math.min(offset + BATCH_SIZE, writeCommands.length)}/${writeCommands.length}  `);
    } catch (err) {
      errors += batch.length;
      console.error('\nErro no batch ' + Math.ceil((offset + 1) / BATCH_SIZE) + ':', err.message);
    }
  }

  console.log('\n');
  console.log('═══ IMPORTAÇÃO CONCLUÍDA ════════════════════════════');
  console.log(`Chaves criadas                   : ${toSet.length}`);
  console.log(`Chaves actualizadas (TTL maior)  : ${toExpire.length}`);
  console.log(`Chaves mantidas (TTL já maior)   : ${skippedLonger}`);
  console.log(`Erros                            : ${errors}`);
  console.log('═════════════════════════════════════════════════════');

  if (errors > 0) {
    console.error('\nATENÇÃO: houve erros. Corre novamente para tentar as chaves em falta.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Erro fatal:', err.message || String(err));
  process.exit(1);
});
