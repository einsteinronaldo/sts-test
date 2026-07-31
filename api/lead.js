import {
  createHash,
  randomUUID
} from 'node:crypto';


/*
 * Aceita tanto os valores atuais do teu index.html
 * como os códigos internos que poderás usar no futuro.
 */
const GASTO_OPTIONS = {
  lt80: {
    label: 'Menos de 80€/mês',
    quality: 'unqualified'
  },

  'Menos de 80€/mês': {
    label: 'Menos de 80€/mês',
    quality: 'unqualified'
  },

  '80_120': {
    label: 'Entre 80 e 120€/mês',
    quality: 'qualified'
  },

  'Entre 80 e 120€/mês': {
    label: 'Entre 80 e 120€/mês',
    quality: 'qualified'
  },

  '120_170': {
    label: 'Entre 120 e 170€/mês',
    quality: 'qualified'
  },

  'Entre 120 e 170€/mês': {
    label: 'Entre 120 e 170€/mês',
    quality: 'qualified'
  },

  '170_220': {
    label: 'Entre 170 e 220€/mês',
    quality: 'qualified'
  },

  'Entre 170 e 220€/mês': {
    label: 'Entre 170 e 220€/mês',
    quality: 'qualified'
  },

  gt220: {
    label: 'Mais de 220€/mês',
    quality: 'qualified'
  },

  'Mais de 220€/mês': {
    label: 'Mais de 220€/mês',
    quality: 'qualified'
  }
};


const PRAZO_OPTIONS = {
  urgente: 'O mais breve possível',
  'O mais breve possível': 'O mais breve possível',

  '1_mes': 'Dentro de 1 mês',
  'Dentro de 1 mês': 'Dentro de 1 mês',

  '1_2_meses': '1 a 2 meses',
  '1 a 2 meses': '1 a 2 meses',

  '2_3_meses': '2 a 3 meses',
  '2 a 3 meses': '2 a 3 meses',

  considerar: 'Ainda estou a considerar',
  'Ainda estou a considerar': 'Ainda estou a considerar'
};


/**
 * Cria uma resposta JSON sem cache.
 */
function json(
  data,
  status = 200,
  additionalHeaders = {}
) {
  return Response.json(data, {
    status,

    headers: {
      'Cache-Control': 'no-store',
      ...additionalHeaders
    }
  });
}


/**
 * Limpa e limita texto recebido.
 */
function clean(value, maxLength = 1000) {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}


/**
 * Cria um hash SHA-256.
 */
function sha256(value) {
  return createHash('sha256')
    .update(value)
    .digest('hex');
}


/**
 * Normaliza o e-mail antes do hash.
 */
function normalizeEmail(email) {
  return clean(email, 254).toLowerCase();
}


/**
 * Normaliza um telemóvel português.
 *
 * Exemplos aceites:
 * 912345678
 * 351912345678
 * +351912345678
 * 00351912345678
 */
function normalizePortugalMobile(phone) {
  var digits = String(phone || '')
    .replace(/\D/g, '');

  if (digits.startsWith('00351')) {
    digits = digits.slice(5);
  } else if (digits.startsWith('351')) {
    digits = digits.slice(3);
  } else {
    digits = digits.replace(/^0+/, '');
  }

  /*
   * Telemóvel português:
   * começa por 9 e tem 9 dígitos.
   */
  if (!/^9\d{8}$/.test(digits)) {
    return '';
  }

  return '+351' + digits;
}


/**
 * Obtém o IP original do visitante.
 */
function getClientIp(request) {
  var forwardedFor =
    request.headers.get('x-vercel-forwarded-for') ||
    request.headers.get('x-forwarded-for') ||
    request.headers.get('x-real-ip') ||
    '';

  if (!forwardedFor) {
    return '';
  }

  return forwardedFor
    .split(',')[0]
    .trim();
}


/**
 * Obtém um cookie pelo nome.
 */
function getCookie(request, name) {
  var cookieHeader =
    request.headers.get('cookie') || '';

  var prefix = name + '=';
  var cookies = cookieHeader.split(';');

  for (
    var index = 0;
    index < cookies.length;
    index++
  ) {
    var cookie = cookies[index].trim();

    if (!cookie.startsWith(prefix)) {
      continue;
    }

    var value = cookie.slice(prefix.length);

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return '';
}


/**
 * Impede que seja enviada para a Meta uma URL externa
 * introduzida manualmente no pedido.
 */
function getSafePageUrl(
  request,
  suppliedPageUrl
) {
  var requestOrigin =
    new URL(request.url).origin;

  var candidates = [
    suppliedPageUrl,
    request.headers.get('referer') || ''
  ];

  for (
    var index = 0;
    index < candidates.length;
    index++
  ) {
    var candidate =
      clean(candidates[index], 2048);

    if (!candidate) {
      continue;
    }

    try {
      var parsed = new URL(candidate);

      if (parsed.origin === requestOrigin) {
        return parsed.href;
      }
    } catch {
      // Experimenta a opção seguinte.
    }
  }

  return requestOrigin + '/';
}


/**
 * Normaliza a versão da Meta Graph API.
 */
function normalizeApiVersion(value) {
  var version =
    clean(value, 20) || 'v26.0';

  if (!version.startsWith('v')) {
    version = 'v' + version;
  }

  if (!/^v\d+\.\d+$/.test(version)) {
    return 'v26.0';
  }

  return version;
}


/**
 * Valida o ID de evento recebido do browser.
 * Cria um UUID quando não é enviado um ID válido.
 */
function getEventId(value) {
  var supplied = clean(value, 100);

  if (
    /^[A-Za-z0-9._:-]{1,100}$/.test(supplied)
  ) {
    return supplied;
  }

  return randomUUID();
}


/**
 * Faz um fetch com tempo limite.
 */
async function fetchWithTimeout(
  url,
  options,
  timeoutMilliseconds = 10000
) {
  var controller = new AbortController();

  var timeout = setTimeout(
    function () {
      controller.abort();
    },
    timeoutMilliseconds
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}


/*
 * ─── RATE LIMITER IN-MEMORY ────────────────────────────────────────────────
 * Funciona por instância serverless.
 * Para produção distribuída, usar Vercel KV.
 */
const rateLimitStore = new Map();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

function checkRateLimit(ip) {
  if (!ip) return { allowed: true };

  var now = Date.now();
  var entry = rateLimitStore.get(ip);

  if (!entry || now >= entry.resetAt) {
    rateLimitStore.set(ip, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS
    });
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return {
      allowed: false,
      retryAfter: Math.ceil(
        (entry.resetAt - now) / 1000
      )
    };
  }

  entry.count += 1;
  return { allowed: true };
}


/*
 * ─── DEDUPLICAÇÃO DE EVENT_ID ──────────────────────────────────────────────
 * Guarda respostas bem-sucedidas em cache por 5 minutos.
 * Pedidos repetidos com o mesmo event_id recebem
 * a resposta em cache sem reenviar ao GHL ou Meta.
 */
const processedLeads = new Map();
const DEDUP_TTL_MS = 5 * 60 * 1000;

function checkDuplicate(eventId) {
  var now = Date.now();
  var found = processedLeads.get(eventId);
  if (found && now - found.ts < DEDUP_TTL_MS) {
    return found.response;
  }
  return null;
}

function markProcessed(eventId, response) {
  var now = Date.now();
  // Limpar entradas expiradas
  for (var [id, entry] of processedLeads) {
    if (now - entry.ts > DEDUP_TTL_MS) {
      processedLeads.delete(id);
    }
  }
  processedLeads.set(eventId, {
    ts: now,
    response: response
  });
}


/*
 * ─── CLOUDFLARE TURNSTILE ──────────────────────────────────────────────────
 * Valida o token gerado pelo widget no browser.
 */
async function verifyTurnstile(token, ip) {
  var secret = clean(
    process.env.TURNSTILE_SECRET_KEY,
    1000
  );

  if (!secret) {
    throw new Error(
      'TURNSTILE_SECRET_KEY não está configurado.'
    );
  }

  var payload = {
    secret: secret,
    response: token
  };
  if (ip) payload.remoteip = ip;

  console.log('TURNSTILE REQUEST', {
    hasSecret: Boolean(secret),
    secretLength: secret ? secret.trim().length : 0,
    hasToken: Boolean(token),
    tokenLength: token ? token.length : 0,
    remoteIpPresent: Boolean(ip)
  });

  var resp = await fetchWithTimeout(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    },
    5000
  );

  var data = await resp.json();

  console.log('TURNSTILE RESPONSE', {
    success: data.success,
    errorCodes: data['error-codes'] || [],
    hostname: data.hostname || null,
    action: data.action || null,
    cdata: data.cdata || null
  });

  return data.success === true;
}


/**
 * Envia um evento Lead para a Meta
 * através da Conversions API.
 */
async function sendMetaLead({
  request,
  eventId,
  email,
  phone,
  pageUrl,
  fbp,
  fbc,
  metaApiVersion
}) {
  var pixelId = clean(
    process.env.META_PIXEL_ID,
    30
  );

  var accessToken = clean(
    process.env.META_CAPI_ACCESS_TOKEN,
    1000
  );

  var testEventCode = clean(
    process.env.META_TEST_EVENT_CODE,
    100
  );

  if (!pixelId || !accessToken) {
    throw new Error(
      'META_PIXEL_ID ou META_CAPI_ACCESS_TOKEN em falta.'
    );
  }

  if (!/^\d+$/.test(pixelId)) {
    throw new Error(
      'META_PIXEL_ID inválido.'
    );
  }

  var normalizedEmail =
    normalizeEmail(email);

  var normalizedPhone =
    String(phone || '')
      .replace(/\D/g, '');

  var clientIp =
    getClientIp(request);

  var userAgent =
    request.headers.get('user-agent') || '';

  if (
    !normalizedEmail ||
    !normalizedPhone
  ) {
    throw new Error(
      'E-mail ou telefone inválido para a Meta.'
    );
  }

  if (!userAgent) {
    throw new Error(
      'Client User Agent em falta.'
    );
  }

  /*
   * O e-mail e o telefone levam hash.
   * IP, user agent, fbp e fbc não levam hash.
   */
  var userData = {
    em: [
      sha256(normalizedEmail)
    ],

    ph: [
      sha256(normalizedPhone)
    ],

    client_user_agent: userAgent
  };

  if (clientIp) {
    userData.client_ip_address =
      clientIp;
  }

  if (fbp) {
    userData.fbp = fbp;
  }

  if (fbc) {
    userData.fbc = fbc;
  }

  var metaEvent = {
    event_name: 'Lead',

    event_time:
      Math.floor(Date.now() / 1000),

    /*
     * Deve coincidir com o eventID
     * usado pelo Meta Pixel no browser.
     */
    event_id: eventId,

    action_source: 'website',

    event_source_url: pageUrl,

    user_data: userData,

    custom_data: {
      content_name:
        'Lead Qualificada Solar',

      lead_type:
        'solar_residencial',

      lead_quality:
        'qualified'
    }
  };

  var metaPayload = {
    data: [
      metaEvent
    ]
  };

  /*
   * Só será incluído se a variável existir.
   * Deve ser removido após os testes.
   */
  if (testEventCode) {
    metaPayload.test_event_code =
      testEventCode;
  }

  var metaUrl =
    'https://graph.facebook.com/' +
    metaApiVersion +
    '/' +
    encodeURIComponent(pixelId) +
    '/events?access_token=' +
    encodeURIComponent(accessToken);

  var metaResponse =
    await fetchWithTimeout(
      metaUrl,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify(metaPayload)
      },
      10000
    );

  var metaResponseText =
    await metaResponse.text();

  var metaResponseData;

  try {
    metaResponseData =
      JSON.parse(metaResponseText);
  } catch {
    metaResponseData = {
      raw_response:
        metaResponseText
    };
  }

  if (!metaResponse.ok) {
    throw new Error(
      'Erro da Meta: ' +
      JSON.stringify(metaResponseData)
    );
  }

  return metaResponseData;
}


export default {
  async fetch(request) {
    /*
     * Só aceita pedidos POST.
     */
    if (request.method !== 'POST') {
      return json(
        {
          ok: false,
          error:
            'Método não permitido.'
        },
        405,
        {
          Allow: 'POST'
        }
      );
    }

    /*
     * Verificar Content-Type.
     */
    var contentType =
      request.headers.get('content-type') || '';

    if (!contentType.includes('application/json')) {
      return json(
        {
          ok: false,
          error:
            'Content-Type inválido.'
        },
        415
      );
    }

    /*
     * Rate limiting: máximo 5 pedidos
     * por IP em 10 minutos.
     */
    var clientIp = getClientIp(request);
    var rateResult = checkRateLimit(clientIp);

    if (!rateResult.allowed) {
      return json(
        {
          ok: false,
          error:
            'Demasiados pedidos. Tenta novamente mais tarde.'
        },
        429,
        {
          'Retry-After': String(
            rateResult.retryAfter
          )
        }
      );
    }

    /*
     * Limite de tamanho do payload: 50 KB.
     */
    var contentLengthHint = parseInt(
      request.headers.get('content-length') || '0',
      10
    );

    if (contentLengthHint > 51200) {
      return json(
        {
          ok: false,
          error:
            'Pedido demasiado grande.'
        },
        413
      );
    }

    /*
     * Proteção básica contra pedidos
     * originados noutro website.
     */
    var requestOrigin =
      new URL(request.url).origin;

    var origin =
      request.headers.get('origin') || '';

    if (
      origin &&
      origin !== requestOrigin
    ) {
      return json(
        {
          ok: false,
          error:
            'Origem não autorizada.'
        },
        403
      );
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json(
        {
          ok: false,
          error:
            'JSON inválido.'
        },
        400
      );
    }

    /*
     * Campos principais.
     */
    var nome =
      clean(body.nome, 150);

    var tel =
      clean(body.tel, 30);

    var email =
      normalizeEmail(body.email);

    var gasto =
      clean(body.gasto, 100);

    var prazo =
      clean(body.prazo, 100);

    var morada =
      clean(body.morada, 300);

    var website =
      clean(body.website, 200);

    /*
     * Informações Meta e atribuição.
     */
    var eventId =
      getEventId(body.event_id);

    var pageUrl =
      getSafePageUrl(
        request,
        body.page_url
      );

    var referrer =
      clean(body.referrer, 2048);

    var utmSource =
      clean(body.utm_source, 300);

    var utmMedium =
      clean(body.utm_medium, 300);

    var utmCampaign =
      clean(body.utm_campaign, 300);

    var utmContent =
      clean(body.utm_content, 300);

    var utmTerm =
      clean(body.utm_term, 300);

    var fbclid =
      clean(body.fbclid, 500);

    var gclid =
      clean(body.gclid, 500);

    var leadSource =
      clean(body.lead_source, 50);

    var pagePath =
      clean(body.page_path, 300);

    /*
     * Tenta primeiro os valores enviados
     * pelo browser e depois os cookies.
     */
    var fbp =
      clean(body.fbp, 255) ||
      clean(
        getCookie(request, '_fbp'),
        255
      );

    var fbc =
      clean(body.fbc, 500) ||
      clean(
        getCookie(request, '_fbc'),
        500
      );

    /*
     * Se existe fbclid mas não existe _fbc,
     * cria um valor fbc compatível.
     */
    if (!fbc && fbclid) {
      fbc =
        'fb.1.' +
        Date.now() +
        '.' +
        fbclid;
    }

    /*
     * Honeypot preenchido:
     * provavelmente é um bot.
     *
     * Não envia para o GHL nem para a Meta.
     */
    if (website) {
      return json({
        ok: true,
        lead_quality:
          'unqualified',
        redirect_url:
          leadSource === 'homepage'
            ? '/sucesso-2-hp'
            : '/sucesso-2',
        event_id: null,
        meta_server_sent: false
      });
    }

    /*
     * Verificação Cloudflare Turnstile.
     * Rejeita bots e tráfego automatizado.
     */
    var cfToken = clean(
      body['cf-turnstile-response'],
      4096
    );

    if (!cfToken) {
      return json(
        {
          ok: false,
          error:
            'Verificação de segurança em falta.'
        },
        400
      );
    }

    try {
      var turnstileOk = await verifyTurnstile(
        cfToken,
        clientIp
      );

      if (!turnstileOk) {
        return json(
          {
            ok: false,
            error:
              'Verificação de segurança falhou. Tenta novamente.'
          },
          403
        );
      }
    } catch (turnstileError) {
      console.error(
        'Erro ao verificar Turnstile:',
        turnstileError
      );

      return json(
        {
          ok: false,
          error:
            'Erro ao verificar segurança. Tenta novamente.'
        },
        503
      );
    }

    /*
     * Todos os campos são obrigatórios.
     */
    if (
      !nome ||
      !tel ||
      !email ||
      !gasto ||
      !prazo ||
      !morada
    ) {
      return json(
        {
          ok: false,
          error:
            'Preenche todos os campos obrigatórios.'
        },
        422
      );
    }

    /*
     * Validação de e-mail.
     */
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        email
      )
    ) {
      return json(
        {
          ok: false,
          error:
            'E-mail inválido.'
        },
        422
      );
    }

    /*
     * Normalização e validação
     * do telemóvel português.
     */
    var phone =
      normalizePortugalMobile(tel);

    if (!phone) {
      return json(
        {
          ok: false,
          error:
            'Telemóvel inválido. Introduz um número português com 9 dígitos.'
        },
        422
      );
    }

    /*
     * Validação do gasto mensal.
     */
    var gastoOption =
      GASTO_OPTIONS[gasto];

    if (!gastoOption) {
      return json(
        {
          ok: false,
          error:
            'Opção de gasto mensal inválida.'
        },
        422
      );
    }

    /*
     * Validação do prazo.
     */
    var prazoLabel =
      PRAZO_OPTIONS[prazo];

    if (!prazoLabel) {
      return json(
        {
          ok: false,
          error:
            'Opção de prazo inválida.'
        },
        422
      );
    }

    /*
     * Apenas menos de 80€/mês
     * é uma lead não qualificada.
     */
    var leadQuality =
      gastoOption.quality;

    /*
     * Deduplicação: se já processámos este
     * event_id com sucesso, devolver a resposta
     * em cache sem reenviar ao GHL ou Meta.
     */
    var dupCached = checkDuplicate(eventId);
    if (dupCached) {
      console.log(
        'Pedido duplicado suprimido, event_id:',
        eventId
      );
      return json(dupCached);
    }

    /*
     * Dados enviados para o webhook
     * do GoHighLevel.
     */
    var ghlPayload = {
      full_name: nome,

      phone: phone,

      email: email,

      address: morada,

      gasto_mensal:
        gastoOption.label,

      prazo_instalacao:
        prazoLabel,

      lead_quality:
        leadQuality,

      source:
        'Landing Page Sun to Sun',

      /*
       * Útil para confirmar a deduplicação.
       */
      event_id:
        eventId,

      page_url:
        pageUrl,

      referrer:
        referrer,

      utm_source:
        utmSource,

      utm_medium:
        utmMedium,

      utm_campaign:
        utmCampaign,

      utm_content:
        utmContent,

      utm_term:
        utmTerm,

      fbclid:
        fbclid,

      gclid:
        gclid,

      lead_source:
        leadSource || 'meta_landing_page',

      page_path:
        pagePath
    };

    var webhookUrl;

    if (leadSource === 'homepage') {
      webhookUrl = clean(
        process.env.GHL_WEBHOOK_URL_HP,
        2048
      );

      if (!webhookUrl) {
        console.error('GHL_WEBHOOK_URL_HP não está configurado.');
        return json({ ok: false, error: 'Webhook não está configurado.' }, 500);
      }
    } else if (leadSource === 'meta_landing_page') {
      webhookUrl = clean(
        process.env.GHL_WEBHOOK_URL_LP,
        2048
      );

      if (!webhookUrl) {
        console.error('GHL_WEBHOOK_URL_LP não está configurado.');
        return json({ ok: false, error: 'Webhook não está configurado.' }, 500);
      }
    } else {
      return json(
        { ok: false, error: 'Origem da lead inválida.' },
        400
      );
    }

    /*
     * Primeiro envia a lead
     * para o GoHighLevel.
     */
    let ghlResponse;

    try {
      ghlResponse =
        await fetchWithTimeout(
          webhookUrl,
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify(
                ghlPayload
              )
          },
          10000
        );
    } catch (error) {
      console.error(
        'Erro de ligação ao GHL:',
        error
      );

      return json(
        {
          ok: false,
          error:
            'Erro ao contactar o servidor. Tenta novamente.'
        },
        502
      );
    }

    if (!ghlResponse.ok) {
      var ghlErrorText = '';

      try {
        ghlErrorText =
          await ghlResponse.text();
      } catch {
        ghlErrorText = '';
      }

      console.error(
        'Erro devolvido pelo GHL:',
        ghlResponse.status,
        ghlErrorText
      );

      return json(
        {
          ok: false,
          error:
            'Erro ao registar o pedido. Tenta novamente.'
        },
        502
      );
    }

    var metaServerSent = false;

    var metaApiVersion =
      normalizeApiVersion(process.env.META_GRAPH_API_VERSION);

    console.log('META DEBUG:', {
      leadQuality: leadQuality,
      hasPixelId: Boolean(process.env.META_PIXEL_ID),
      hasAccessToken: Boolean(process.env.META_CAPI_ACCESS_TOKEN),
      apiVersion: metaApiVersion,
      testMode: Boolean(process.env.META_TEST_EVENT_CODE)
    });

    /*
     * Só envia Lead para a Meta
     * quando a lead é qualificada.
     */
    if (
      leadQuality === 'qualified'
    ) {
      try {
        var metaResult =
          await sendMetaLead({
            request: request,
            eventId: eventId,
            email: email,
            phone: phone,
            pageUrl: pageUrl,
            fbp: fbp,
            fbc: fbc,
            metaApiVersion: metaApiVersion
          });

        metaServerSent = true;

        console.log(
          'Evento Meta enviado com sucesso:',
          metaResult
        );
      } catch (error) {
        /*
         * A lead já entrou no GHL.
         * Por isso, uma falha na Meta
         * não deve bloquear o utilizador.
         */
        console.error(
          'Erro na Meta Conversions API:',
          error
        );
      }
    }

    /*
     * Homepage → /sucesso-hp ou /sucesso-2-hp
     * LP Facebook → /sucesso ou /sucesso-2
     */
    var redirectUrl =
      leadQuality === 'qualified'
        ? (leadSource === 'homepage' ? '/sucesso-hp' : '/sucesso')
        : (leadSource === 'homepage' ? '/sucesso-2-hp' : '/sucesso-2');

    var finalResponse = {
      ok: true,
      lead_quality: leadQuality,
      redirect_url: redirectUrl,
      event_id:
        leadQuality === 'qualified'
          ? eventId
          : null,
      meta_server_sent: metaServerSent
    };

    markProcessed(eventId, finalResponse);
    return json(finalResponse);
  }
};