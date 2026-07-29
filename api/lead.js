const GASTOS_VALIDOS = new Set([
  'Menos de 80€/mês',
  'Entre 80 e 120€/mês',
  'Entre 120 e 170€/mês',
  'Entre 170 e 220€/mês',
  'Mais de 220€/mês',
]);

const PRAZOS_VALIDOS = new Set([
  'O mais breve possível',
  'Dentro de 1 mês',
  '1 a 2 meses',
  '2 a 3 meses',
  'Ainda estou a considerar',
]);

function limparTexto(valor, limite = 500) {
  if (typeof valor !== 'string') return '';
  return valor.trim().slice(0, limite);
}

function normalizarTelefonePortugal(valor) {
  let digitos = limparTexto(valor, 30).replace(/\D/g, '');

  // Exemplos aceites:
  // 912345678
  // 351912345678
  // +351912345678
  // 00351912345678

  if (digitos.startsWith('00351')) {
    digitos = digitos.slice(5);
  } else if (digitos.startsWith('351')) {
    digitos = digitos.slice(3);
  }

  if (digitos.startsWith('0') && digitos.length === 10) {
    digitos = digitos.slice(1);
  }

  if (!/^\d{9}$/.test(digitos)) {
    return null;
  }

  return `+351${digitos}`;
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return Response.json(
        {
          ok: false,
          error: 'Método não permitido.',
        },
        {
          status: 405,
          headers: {
            Allow: 'POST',
          },
        }
      );
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return Response.json(
        {
          ok: false,
          error: 'Pedido inválido.',
        },
        {
          status: 400,
        }
      );
    }

    const nome = limparTexto(body.nome, 150);
    const tel = limparTexto(body.tel, 30);
    const email = limparTexto(body.email, 254).toLowerCase();
    const gasto = limparTexto(body.gasto, 100);
    const prazo = limparTexto(body.prazo, 100);
    const morada = limparTexto(body.morada, 300);
    const website = limparTexto(body.website, 300);

    // Honeypot preenchido: provavelmente é um bot.
    // Não envia para o GHL e não envia para uma página de conversão.
    if (website) {
      return Response.json({
        ok: true,
        redirect_url: '/',
      });
    }

    if (!nome || !tel || !email || !gasto || !prazo || !morada) {
      return Response.json(
        {
          ok: false,
          error: 'Preenche todos os campos obrigatórios.',
        },
        {
          status: 422,
        }
      );
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return Response.json(
        {
          ok: false,
          error: 'Introduz um endereço de e-mail válido.',
        },
        {
          status: 422,
        }
      );
    }

    const phone = normalizarTelefonePortugal(tel);

    if (!phone) {
      return Response.json(
        {
          ok: false,
          error: 'Introduz um número de telefone português válido com 9 dígitos.',
        },
        {
          status: 422,
        }
      );
    }

    if (!GASTOS_VALIDOS.has(gasto)) {
      return Response.json(
        {
          ok: false,
          error: 'Seleciona uma opção válida para o gasto mensal.',
        },
        {
          status: 422,
        }
      );
    }

    if (!PRAZOS_VALIDOS.has(prazo)) {
      return Response.json(
        {
          ok: false,
          error: 'Seleciona uma opção válida para o prazo de instalação.',
        },
        {
          status: 422,
        }
      );
    }

    const leadQuality =
      gasto === 'Menos de 80€/mês'
        ? 'unqualified'
        : 'qualified';

    const ghlPayload = {
      full_name: nome,
      phone,
      email,
      address: morada,

      // Estes valores chegam exatamente como aparecem no formulário.
      gasto_mensal: gasto,
      prazo_instalacao: prazo,

      lead_quality: leadQuality,
      source: 'Landing Page Sun to Sun',

      page_url: limparTexto(body.page_url, 1000),
      referrer: limparTexto(body.referrer, 1000),
      utm_source: limparTexto(body.utm_source, 300),
      utm_medium: limparTexto(body.utm_medium, 300),
      utm_campaign: limparTexto(body.utm_campaign, 300),
      utm_content: limparTexto(body.utm_content, 300),
      utm_term: limparTexto(body.utm_term, 300),
      fbclid: limparTexto(body.fbclid, 500),
    };

    const webhookUrl = process.env.GHL_WEBHOOK_URL;

    if (!webhookUrl) {
      console.error('GHL_WEBHOOK_URL não está configurado.');

      return Response.json(
        {
          ok: false,
          error: 'Configuração interna em falta.',
        },
        {
          status: 500,
        }
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    let ghlResponse;

    try {
      ghlResponse = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(ghlPayload),
        signal: controller.signal,
      });
    } catch (error) {
      console.error('Erro ao contactar o GHL:', error);

      return Response.json(
        {
          ok: false,
          error: 'Não foi possível registar o pedido. Tenta novamente.',
        },
        {
          status: 502,
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!ghlResponse.ok) {
      const respostaGhl = await ghlResponse.text().catch(() => '');

      console.error(
        'O webhook do GHL respondeu com erro:',
        ghlResponse.status,
        respostaGhl
      );

      return Response.json(
        {
          ok: false,
          error: 'O pedido não foi registado. Tenta novamente.',
        },
        {
          status: 502,
        }
      );
    }

    const redirectUrl =
      leadQuality === 'qualified'
        ? '/sucesso.html'
        : '/sucesso-2.html';

    return Response.json({
      ok: true,
      lead_quality: leadQuality,
      redirect_url: redirectUrl,
    });
  },
};