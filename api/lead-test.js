import {
  randomUUID
} from 'node:crypto';


/*
 * ═══════════════════════════════════════════════════════════════════
 *  ISOLATION GUARD — READ BEFORE EDITING
 * ═══════════════════════════════════════════════════════════════════
 *
 *  This function is the ONLY submission endpoint for the address
 *  A/B test page (/paineis-solares-lp-address-test).
 *
 *  It MUST:
 *    • Only accept lead_source === 'address_test'
 *    • Only read ADDRESS_TEST_WEBHOOK_URL
 *    • Never read or call GHL_WEBHOOK_URL_HP or GHL_WEBHOOK_URL_LP
 *    • Never call the Meta Conversions API
 *    • Always return event_id: null (prevents sucesso.html from
 *      firing fbq('track', 'Lead') on the production Meta pixel)
 *
 *  Any change that routes leads to production GHL webhooks or the
 *  Meta CAPI from this file breaks the isolation contract.
 * ═══════════════════════════════════════════════════════════════════
 */

const ALLOWED_LEAD_SOURCE = 'address_test';

const GASTO_OPTIONS = {
  lt80:               { label: 'Menos de 80€/mês',       quality: 'unqualified' },
  'Menos de 80€/mês': { label: 'Menos de 80€/mês',       quality: 'unqualified' },
  '80_120':           { label: 'Entre 80 e 120€/mês',    quality: 'qualified' },
  'Entre 80 e 120€/mês': { label: 'Entre 80 e 120€/mês', quality: 'qualified' },
  '120_170':          { label: 'Entre 120 e 170€/mês',   quality: 'qualified' },
  'Entre 120 e 170€/mês': { label: 'Entre 120 e 170€/mês', quality: 'qualified' },
  '170_220':          { label: 'Entre 170 e 220€/mês',   quality: 'qualified' },
  'Entre 170 e 220€/mês': { label: 'Entre 170 e 220€/mês', quality: 'qualified' },
  gt220:              { label: 'Mais de 220€/mês',       quality: 'qualified' },
  'Mais de 220€/mês': { label: 'Mais de 220€/mês',       quality: 'qualified' },
};

const PRAZO_OPTIONS = {
  urgente:                 'O mais breve possível',
  'O mais breve possível': 'O mais breve possível',
  '1_mes':                 'Dentro de 1 mês',
  'Dentro de 1 mês':       'Dentro de 1 mês',
  '1_2_meses':             '1 a 2 meses',
  '1 a 2 meses':           '1 a 2 meses',
  '2_3_meses':             '2 a 3 meses',
  '2 a 3 meses':           '2 a 3 meses',
  considerar:                      'Ainda estou a considerar',
  'Ainda estou a considerar':      'Ainda estou a considerar',
};


function json(data, status = 200, additionalHeaders = {}) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', ...additionalHeaders },
  });
}

function clean(value, maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeEmail(email) {
  return clean(email, 254).toLowerCase();
}

function normalizePortugalMobile(phone) {
  var digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('00351'))      digits = digits.slice(5);
  else if (digits.startsWith('351'))   digits = digits.slice(3);
  else                                 digits = digits.replace(/^0+/, '');
  return /^9\d{8}$/.test(digits) ? '+351' + digits : '';
}

function getClientIp(request) {
  var forwardedFor =
    request.headers.get('x-vercel-forwarded-for') ||
    request.headers.get('x-forwarded-for') ||
    request.headers.get('x-real-ip') || '';
  return forwardedFor.split(',')[0].trim();
}

function getEventId(value) {
  var supplied = clean(value, 100);
  return /^[A-Za-z0-9._:-]{1,100}$/.test(supplied) ? supplied : randomUUID();
}

async function fetchWithTimeout(url, options, timeoutMs = 10000) {
  var controller = new AbortController();
  var timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}


/* ── Rate limiter ──────────────────────────────────────────────── */
const rateLimitStore = new Map();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

function checkRateLimit(ip) {
  if (!ip) return { allowed: true };
  var now = Date.now();
  var entry = rateLimitStore.get(ip);
  if (!entry || now >= entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { allowed: true };
}


/* ── Deduplication ─────────────────────────────────────────────── */
const processedLeads = new Map();
const DEDUP_TTL_MS = 5 * 60 * 1000;

function checkDuplicate(eventId) {
  var now = Date.now();
  var found = processedLeads.get(eventId);
  return (found && now - found.ts < DEDUP_TTL_MS) ? found.response : null;
}

function markProcessed(eventId, response) {
  var now = Date.now();
  for (var [id, entry] of processedLeads) {
    if (now - entry.ts > DEDUP_TTL_MS) processedLeads.delete(id);
  }
  processedLeads.set(eventId, { ts: now, response });
}


/* ── Turnstile ─────────────────────────────────────────────────── */
async function verifyTurnstile(token, ip) {
  var secret = clean(process.env.TURNSTILE_SECRET_KEY, 1000);
  if (!secret) throw new Error('TURNSTILE_SECRET_KEY não está configurado.');
  var payload = { secret, response: token };
  if (ip) payload.remoteip = ip;
  var resp = await fetchWithTimeout(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    5000
  );
  var data = await resp.json();
  return data.success === true;
}


export default {
  async fetch(request) {

    /* ── Method ── */
    if (request.method !== 'POST') {
      return json({ ok: false, error: 'Método não permitido.' }, 405, { Allow: 'POST' });
    }

    /* ── Content-Type ── */
    var contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return json({ ok: false, error: 'Content-Type inválido.' }, 415);
    }

    /* ── Rate limit ── */
    var clientIp = getClientIp(request);
    var rateResult = checkRateLimit(clientIp);
    if (!rateResult.allowed) {
      return json(
        { ok: false, error: 'Demasiados pedidos. Tenta novamente mais tarde.' },
        429,
        { 'Retry-After': String(rateResult.retryAfter) }
      );
    }

    /* ── Payload size ── */
    var contentLengthHint = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLengthHint > 51200) {
      return json({ ok: false, error: 'Pedido demasiado grande.' }, 413);
    }

    /* ── CORS origin ── */
    var requestOrigin = new URL(request.url).origin;
    var origin = request.headers.get('origin') || '';
    if (origin && origin !== requestOrigin) {
      return json({ ok: false, error: 'Origem não autorizada.' }, 403);
    }

    /* ── Parse body ── */
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'JSON inválido.' }, 400);
    }

    /* ══ ISOLATION GUARD ═══════════════════════════════════════════
     * This check must come BEFORE any webhook or integration call.
     * If lead_source is anything other than 'address_test' this
     * request is rejected immediately — it can never fall through
     * to production GHL webhooks.
     * ═══════════════════════════════════════════════════════════════ */
    var leadSource = clean(body.lead_source, 50);
    if (leadSource !== ALLOWED_LEAD_SOURCE) {
      console.error('[lead-test] Rejected: unexpected lead_source =', leadSource);
      return json({ ok: false, error: 'Rota de teste: origem inválida.' }, 403);
    }

    /* ── Read test webhook URL ── */
    var webhookUrl = clean(process.env.ADDRESS_TEST_WEBHOOK_URL, 2048);
    if (!webhookUrl) {
      console.error('[lead-test] ADDRESS_TEST_WEBHOOK_URL not configured.');
      return json({ ok: false, error: 'Webhook de teste não configurado.' }, 500);
    }

    /* ── Extract fields ── */
    var nome   = clean(body.nome,   150);
    var tel    = clean(body.tel,    30);
    var email  = normalizeEmail(body.email);
    var gasto  = clean(body.gasto,  100);
    var prazo  = clean(body.prazo,  100);
    var morada = clean(body.morada, 300);
    var website = clean(body.website, 200);

    /* Address autocomplete breakdown (Places API New) */
    var addrInput     = clean(body.address_input,        300);
    var addrFormatted = clean(body.address_formatted,    300);
    var addrStreet    = clean(body.address_street,       200);
    var addrNumber    = clean(body.address_number,        50);
    var addrPostal    = clean(body.address_postal_code,   20);
    var addrLocality  = clean(body.address_locality,     200);
    var addrMunic     = clean(body.address_municipality, 200);
    var addrDistrict  = clean(body.address_district,     200);
    var addrCountry   = clean(body.address_country,      100);
    var addrLat       = (body.address_lat != null && isFinite(body.address_lat))
                          ? Number(body.address_lat) : null;
    var addrLng       = (body.address_lng != null && isFinite(body.address_lng))
                          ? Number(body.address_lng) : null;
    var googlePlaceId = clean(body.google_place_id,      500);
    var addrSource    = clean(body.address_source,        30);
    if (addrSource !== 'google_autocomplete') addrSource = 'manual';

    var eventId = getEventId(body.event_id);

    /* UTM / attribution (read-only, no production side effects) */
    var utmSource   = clean(body.utm_source,   300);
    var utmMedium   = clean(body.utm_medium,   300);
    var utmCampaign = clean(body.utm_campaign, 300);
    var utmContent  = clean(body.utm_content,  300);
    var utmTerm     = clean(body.utm_term,     300);
    var fbclid      = clean(body.fbclid,       500);
    var gclid       = clean(body.gclid,        500);
    var pagePath    = clean(body.page_path,    300);
    var referrer    = clean(body.referrer,     2048);
    var rgpdConsent = clean(body.rgpd_consent, 10) === 'sim' ? 'sim' : 'nao';

    /* ── Honeypot ── */
    if (website) {
      return json({ ok: true, lead_quality: 'unqualified', redirect_url: '/sucesso-2', event_id: null });
    }

    /* ── Turnstile ── */
    var cfToken = clean(body['cf-turnstile-response'], 4096);
    if (!cfToken) {
      return json({ ok: false, error: 'Verificação de segurança em falta.' }, 400);
    }
    try {
      var turnstileOk = await verifyTurnstile(cfToken, clientIp);
      if (!turnstileOk) {
        return json({ ok: false, error: 'Verificação de segurança falhou. Tenta novamente.' }, 403);
      }
    } catch (turnstileError) {
      console.error('[lead-test] Turnstile error:', turnstileError);
      return json({ ok: false, error: 'Erro ao verificar segurança. Tenta novamente.' }, 503);
    }

    /* ── Required fields ── */
    if (!nome || !tel || !email || !gasto || !prazo || !morada) {
      return json({ ok: false, error: 'Preenche todos os campos obrigatórios.' }, 422);
    }

    /* ── Email format ── */
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ ok: false, error: 'E-mail inválido.' }, 422);
    }

    /* ── Phone ── */
    var phone = normalizePortugalMobile(tel);
    if (!phone) {
      return json({ ok: false, error: 'Telemóvel inválido. Introduz um número português com 9 dígitos.' }, 422);
    }

    /* ── Gasto ── */
    var gastoOption = GASTO_OPTIONS[gasto];
    if (!gastoOption) {
      return json({ ok: false, error: 'Opção de gasto mensal inválida.' }, 422);
    }

    /* ── Prazo ── */
    var prazoLabel = PRAZO_OPTIONS[prazo];
    if (!prazoLabel) {
      return json({ ok: false, error: 'Opção de prazo inválida.' }, 422);
    }

    var leadQuality = gastoOption.quality;

    /* ── Deduplication ── */
    var dupCached = checkDuplicate(eventId);
    if (dupCached) {
      console.log('[lead-test] Duplicate suppressed, event_id:', eventId);
      return json(dupCached);
    }

    /* ── Webhook payload ── */
    var testPayload = {
      full_name:        nome,
      phone:            phone,
      email:            email,
      address:              morada,
      address_input:        addrInput,
      address_formatted:    addrFormatted,
      address_street:       addrStreet,
      address_number:       addrNumber,
      address_postal_code:  addrPostal,
      address_locality:     addrLocality,
      address_municipality: addrMunic,
      address_district:     addrDistrict,
      address_country:      addrCountry,
      address_lat:          addrLat,
      address_lng:          addrLng,
      google_place_id:      googlePlaceId,
      address_source:       addrSource,
      gasto_mensal:     gastoOption.label,
      prazo_instalacao: prazoLabel,
      lead_quality:     leadQuality,
      source:           'Landing Page Sun to Sun — Address Test',
      event_id:         eventId,
      referrer:         referrer,
      utm_source:       utmSource,
      utm_medium:       utmMedium,
      utm_campaign:     utmCampaign,
      utm_content:      utmContent,
      utm_term:         utmTerm,
      fbclid:           fbclid,
      gclid:            gclid,
      lead_source:      leadSource,
      page_path:        pagePath,
      rgpd_consent:     rgpdConsent,
      _test:            true,
    };

    /* ── Send to test webhook only ── */
    let webhookResponse;
    try {
      webhookResponse = await fetchWithTimeout(
        webhookUrl,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(testPayload) },
        10000
      );
    } catch (error) {
      console.error('[lead-test] Webhook connection error:', error);
      return json({ ok: false, error: 'Erro ao contactar o servidor. Tenta novamente.' }, 502);
    }

    if (!webhookResponse.ok) {
      var errText = '';
      try { errText = await webhookResponse.text(); } catch { errText = ''; }
      console.error('[lead-test] Webhook error:', webhookResponse.status, errText);
      return json({ ok: false, error: 'Erro ao registar o pedido. Tenta novamente.' }, 502);
    }

    var redirectUrl = leadQuality === 'qualified' ? '/sucesso' : '/sucesso-2';

    var finalResponse = {
      ok:               true,
      lead_quality:     leadQuality,
      redirect_url:     redirectUrl,
      /*
       * Always null — prevents sucesso.html from reading
       * meta_lead_event_id out of sessionStorage and firing
       * fbq('track', 'Lead') on the production Meta pixel.
       */
      event_id:         null,
      meta_server_sent: false,
    };

    markProcessed(eventId, finalResponse);
    return json(finalResponse);
  },
};
