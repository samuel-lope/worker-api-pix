// author: Samuel Lopes
// date: 04.2025
// version: 0.0.14 (removida as refências ao serviço R2 de Buckets)

 /**
  * Este Worker utiliza os seguintes bindings:
  * - DATA_D1: Banco de dados D1 (Cloudflare D1) para operações SQL.
  * - MY_R2: Bucket R2 para armazenamento de arquivos.
  *
  * Variáveis de ambiente (env.vars) incluem:
  * HMAC, HIDE_PARAM, EFI_IP, TEST_PASS.
  */

// Mapeamento de rotas por método HTTP
const routes = {
  POST: {
    "/webhook": appWebhook,
  },
  GET: {
    "/consulta-recebimento": appConsultaRecebimento,
    "/consulta-database": appConsultaDatabase,
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

/**
 * POST /webhook
 */
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
    console.log(data);
  }

  return new Response(
    JSON.stringify({ success: true, message: "Sucesso, Ok!" }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * GET /consulta-recebimento
 */
async function appConsultaRecebimento(request, env) {
  const url = new URL(request.url);
  const txid = url.searchParams.get("idmaq");
  const select = env.DATA_D1.prepare("SELECT pulsos FROM consultas WHERE txid = ?");
  const row = await select.bind(txid).first();
  if (!row) {
    return new Response("ID Not Found.", { status: 404 });
  }

  // reset valor
  await env.DATA_D1
    .prepare("UPDATE consultas SET valor = ? WHERE txid = ?")
    .bind(0, txid)
    .run();

  return new Response(
    JSON.stringify(row.pulsos),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * GET /consulta-database
 */
async function appConsultaDatabase(request, env) {
  const url = new URL(request.url);
  const db = url.searchParams.get("db");
  if (!["recebimentos", "consultas"].includes(db)) {
    return new Response("Tabela não autorizada para consulta.", { status: 403 });
  }

  // monta SQL
  const cols = db === "consultas"
    ? "txid, valor, datahora, valorficha"
    : "txid, valor, datahora";
  const rows = (await env.DATA_D1
    .prepare(`SELECT ${cols} FROM ${db} ORDER BY datahora DESC`)
    .all()
  ).results;

  // mapeia apenas colunas de saída
  let headers, output;
  if (db === "consultas") {
    headers = ["txid", "valor", "valorficha"];
    output = rows.map(r => ({
      txid: r.txid,
      valor: r.valor,
      valorficha: r.valorficha
    }));
  } else {
    headers = ["txid", "valor"];
    output = rows.map(r => ({
      txid: r.txid,
      valor: r.valor
    }));
  }

  const table = formatTable(headers, output);
  return new Response(`Tabela ${db}:\n\n${table}`, {
    status: 200,
    headers: { "Content-Type": "text/plain" }
  });
}

/*************************************
 * Processa cada item PIX
 *************************************/
async function processPixItem(item, env) {
  const { horario, gnExtras, endToEndId, txid, chave, valor } = item;

  if (endToEndId && txid && chave && valor && horario) {
    await env.DATA_D1
      .prepare(
        "INSERT INTO recebimentos (eeid, pagador, datahora, txid, chavepix, valor) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(endToEndId, gnExtras.pagador.nome, horario, txid, chave, valor)
      .run();
  }

  if (txid && valor != null) {
    const rounded = Math.round(Number(valor) * 100) /* antes dividia por 100 ( /100 ) */;
    const exists = await env.DATA_D1
      .prepare("SELECT 1 FROM consultas WHERE txid = ?")
      .bind(txid)
      .first();

    if (!exists) {
      await env.DATA_D1
        .prepare("INSERT INTO consultas (txid, valor) VALUES (?, ?)")
        .bind(txid, rounded)
        .run();
    } else {
      await env.DATA_D1
        .prepare("UPDATE consultas SET valor = ROUND(valor + ?, 2), datahora = ? WHERE txid = ?")
        .bind(rounded, horario, txid)
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

/***************************************
 * Formata tabela de texto com bordas
 ***************************************/
function formatTable(headers, rows) {
  const widths = headers.map(h => h.length);
  rows.forEach(r =>
    headers.forEach((h, i) => {
      widths[i] = Math.max(widths[i], String(r[h] ?? "").length);
    })
  );
  const pad = (s, w) => s + " ".repeat(w - s.length);
  const border = "+" + widths.map(w => "-".repeat(w + 2)).join("+") + "+";
  const head = "| " + headers.map((h, i) => pad(h, widths[i])).join(" | ") + " |";
  const data = rows.map(r =>
    "| " +
    headers.map((h, i) => pad(String(r[h] ?? ""), widths[i])).join(" | ") +
    " |"
  );
  return [border, head, border, ...data, border].join("\n");
}

