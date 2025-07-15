// author: Samuel Lopes
// date: 04.2025
// version: 0.0.14 (removida as refências ao serviço R2 de Buckets)

 /**
  * Este código é apenas um BackUp do original para que possamos fazer novas alterações e poder retornar em caso de erros.
  */

// Mapeamento de rotas por método HTTP
const routes = {
  POST: {
    "/webhook": appWebhook,
  },
  GET: {
    "/consulta-recebimento": appConsultaRecebimento,
    "/consulta-database": appConsultaDatabase
  }
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return handleOptions(request);
    }

    const url = new URL(request.url);
    const handler = (routes[request.method] || {})[url.pathname];

    if (!handler) {
      return handleResponse(new Response("Endpoint não encontrado.", { status: 404 }));
    }

    try {
      const response = await handler(request, env);
      return handleResponse(response);
    } catch (err) {
      return handleResponse(new Response(
        JSON.stringify({ success: false, error: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      ));
    }
  }
};

/*************************************************
 * POST /webhook
 *************************************************/
async function appWebhook(request, env) {
  const url = new URL(request.url);
  let clientIp, hmacParam;

  // teste via parâmetro
  const hideParam = url.searchParams.get(env.HIDE_PARAM);
  if (hideParam === env.TEST_PASS) {
    clientIp = env.EFI_IP;
    hmacParam = env.HMAC;
  } else {
    clientIp = request.headers.get("CF-Connecting-IP");
    hmacParam = url.searchParams.get("hmac");
  }

  if (clientIp !== env.EFI_IP) {
    return new Response("IP Denied", { status: 403 });
  }
  if (!hmacParam || hmacParam !== env.HMAC) {
    return new Response("Invalid HMAC", { status: 401 });
  }

  const data = await request.json();
  if (data.pix && Array.isArray(data.pix)) {
    for (const item of data.pix) {
      await processPixItem(item, env);
    }
    // Log de recebimento PIX
    console.log(data);
  }

  return new Response(
    JSON.stringify({ success: true, message: "Sucesso, Ok!" }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/*****************************
 *  GET /consulta-recebimento
 *  Este Handle zera o valor na tabela.
 *****************************/
async function appConsultaRecebimento(request, env) {
  const url = new URL(request.url);
  const txid = url.searchParams.get("idmaq");
  const ficha = 50; // Valor da ficha em centavos

  if (!txid) {
    return new Response("Parâmetro 'idmaq' ausente.", { status: 400 });
  }

  // 1. Verificar se o TXID existe na tabela
  const checkTxidStmt = env.DATA_D1.prepare("SELECT 1 FROM recebimentos WHERE txid = ? LIMIT 1");
  const txidExists = await checkTxidStmt.bind(txid).first();

  if (!txidExists) {
    return new Response("TXID Não encontrado.", { status: 404 });
  }

  // 2. Se o TXID existe, calcular a soma dos valores não utilizados
  const selectStmt = env.DATA_D1.prepare(
    "SELECT SUM(valor) as total FROM recebimentos WHERE txid = ? AND used = 0"
  );
  const result = await selectStmt.bind(txid).first();

  // Se não houver créditos novos (total é null ou 0), retorna 0
  if (!result || result.total === null || result.total === 0) {
    return new Response(JSON.stringify(0), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const totalValue = result.total;
  const pulsos = Math.floor(totalValue / ficha);

  if (pulsos > 0) {
    // 3. Atualizar os registros para marcar como utilizados
    const updateStmt = env.DATA_D1.prepare(
      "UPDATE recebimentos SET used = 1 WHERE txid = ? AND used = 0"
    );
    await updateStmt.bind(txid).run();
  }

  return new Response(
    JSON.stringify(pulsos),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/**************************************
 * GET /consulta-database
 **************************************/
async function appConsultaDatabase(request, env) {
  const url = new URL(request.url);
  const txid = url.searchParams.get("txid");

  let query;
  if (txid) {
    query = env.DATA_D1.prepare(
      `SELECT
        txid as codigoTxid,
        SUM(CASE WHEN used = 1 THEN valor ELSE 0 END) as valorUsado,
        SUM(CASE WHEN used = 0 THEN valor ELSE 0 END) as valorAberto,
        SUM(valor) as valorTotal
      FROM recebimentos
      WHERE txid = ?
      GROUP BY txid`
    ).bind(txid);
  } else {
    query = env.DATA_D1.prepare(
      `SELECT
        txid as codigoTxid,
        SUM(CASE WHEN used = 1 THEN valor ELSE 0 END) as valorUsado,
        SUM(CASE WHEN used = 0 THEN valor ELSE 0 END) as valorAberto,
        SUM(valor) as valorTotal
      FROM recebimentos
      GROUP BY txid`
    );
  }

  try {
    const { results } = await query.all();
    return new Response(JSON.stringify(results, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/*************************************
 * Processa cada item PIX
 *************************************/
async function processPixItem(item, env) {
  const { horario, gnExtras, endToEndId, txid, chave, valor } = item;

  // Converte o valor para centavos (inteiro)
  const valorEmCentavos = Math.round(Number(valor) * 100);

  // Formata a data para DD-MM-AAAA HH:MM
  const data = new Date(horario);
  const pad = (num) => String(num).padStart(2, '0');
  const dataFormatada = `${pad(data.getDate())}-${pad(data.getMonth() + 1)}-${data.getFullYear()} ${pad(data.getHours())}:${pad(data.getMinutes())}`;

  if (endToEndId && txid && chave && valor && horario) {
    await env.DATA_D1
      .prepare(
        "INSERT INTO recebimentos (eeid, pagador, datahora, txid, chavepix, valor) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(endToEndId, gnExtras.pagador.nome, dataFormatada, txid, chave, valorEmCentavos)
      .run();
  }

  if (txid && valor != null) {
    const exists = await env.DATA_D1
      .prepare("SELECT 1 FROM consultas WHERE txid = ?")
      .bind(txid)
      .first();

    if (!exists) {
      await env.DATA_D1
        .prepare("INSERT INTO consultas (txid, valor) VALUES (?, ?)")
        .bind(txid, valorEmCentavos)
        .run();
    } else {
      await env.DATA_D1
        .prepare("UPDATE consultas SET valor = valor + ?, datahora = ? WHERE txid = ?")
        .bind(valorEmCentavos, dataFormatada, txid)
        .run();
    }
  }
}

/************************************
 * OPTIONS CORS
 ************************************/
function handleOptions(request) {
  const reqH = request.headers.get("Access-Control-Request-Headers") || "*";
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": reqH,
      "Access-Control-Max-Age": "86400"
    }
  });
}

// Adiciona headers CORS na resposta
function handleResponse(response) {
  const h = new Headers(response.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: h
  });
}