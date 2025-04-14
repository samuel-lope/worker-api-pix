// author: Samuel Lopes
// date: 04.2025
// version: 0.0.5 (adicionado lógica para trabalhar com D1 database no lugar de KV)

/**
 * Este Worker utiliza os seguintes bindings:
 * - DATA_D1: Banco de dados D1 (Cloudflare D1) para operações SQL.
 * - MY_R2: Bucket R2 para armazenamento de arquivos.
 *
 * Variáveis de ambiente (env.vars) incluem:
 * HMAC, HIDE_PARAM, EFI_IP, TEST_PASS.
 */

export default {
  /**
   * Função principal que roteia a requisição para o endpoint correto.
   *
   * @param {Request} request
   * @param {{
   *          HMAC: string;
   *          HIDE_PARAM: string;
   *          EFI_IP: string;
   *          TEST_PASS: string;
   *          MY_R2: { put: (arg0: string, arg1: string) => Promise<any>; get: (arg0: string) => Promise<any>; };
   *          DATA_D1: { prepare: (query: string) => any; };
   *         }} env
   */
  async fetch(request, env) {
    // Responde imediatamente às requisições OPTIONS com os headers CORS.
    if (request.method === "OPTIONS") {
      return handleOptions(request);
    }

    const url = new URL(request.url);
    let response;

//-----------------------------------
// Roteamento dos endpoints
//-----------------------------------
    switch (url.pathname) {
      case "/recebimento":
        response = await appRecebimento(request, env);
        break;
      case "/consulta-recebimento":
        response = await appConsultaRecebimento(request, env);
        break;
      default:
        response = new Response("Endpoint não encontrado.", { status: 404 });
    }

    return handleResponse(response);
  }
};

/**
 * App responsável por tratar o endpoint /recebimento
 * 
 * Executa:
 * - Validação do IP e HMAC (ou teste por parâmetro)
 * - Processamento dos dados enviados (campo "pix")
 * - Persistência em R2 e inserções/atualizações nas tabelas "recebimentos" e "consultas"
 *
 * @param {Request} request 
 * @param {*} env 
 * @returns {Promise<Response>}
 */
async function appRecebimento(request, env) {
  const url = new URL(request.url);
  let clientIp, hmacParam;

  // Validação de acesso: se for requisição de teste, usa os parâmetros de teste.
  const hideParam = url.searchParams.get(env.HIDE_PARAM);
  if (hideParam === env.TEST_PASS) {
    clientIp = env.EFI_IP;
    hmacParam = env.HMAC;
  } else {
    clientIp = request.headers.get("CF-Connecting-IP");
    hmacParam = url.searchParams.get("hmac");
  }

  // Validação do IP de origem
  if (clientIp !== env.EFI_IP) {
    return new Response("Endereço IP não autorizado", { status: 403 });
  }

  // Validação do HMAC
  if (!hmacParam || hmacParam !== env.HMAC) {
    return new Response("HMAC inválido ou ausente", { status: 401 });
  }

  // Verifica se o método HTTP é POST
  if (request.method !== "POST") {
    return new Response("Método não suportado. Use POST para enviar notificações.", { status: 405 });
  }

  try {
    const data = await request.json();

    // Processa os dados recebidos se o campo "pix" for um array
    if (data.pix && Array.isArray(data.pix)) {
      for (const item of data.pix) {
        await processPixItem(item, env);
      }
    }

    console.log("Dados recebidos e persistidos:", data);
    return new Response(
      JSON.stringify({ success: true, message: "Sucesso, Ok!" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * Função auxiliar que processa cada item do array "pix", realizando:
 * - Persistência em R2 (armazenamento do JSON)
 * - Inserção na tabela "recebimentos"
 * - Inserção/atualização na tabela "consultas"
 * 
 * @param {object} item - Objeto contendo os dados do PIX.
 * @param {*} env - Ambiente com bindings para R2 e D1.
 */
async function processPixItem(item, env) {
  const { horario, gnExtras, endToEndId, txid, chave, valor } = item;

  // Persistência no R2: grava um arquivo identificando-o com "txid"
  if (txid && valor) {
    await env.MY_R2.put(`bucket-${txid}.json`, JSON.stringify({ endToEndId, txid, valor }));
  }

  // Inserção na tabela "recebimentos" (registro dos detalhes)
  if (endToEndId && txid && chave && valor && horario) {
    const stmtReceb = env.DATA_D1.prepare(
      "INSERT INTO recebimentos (eeid, pagador, datahora, txid, chavepix, valor) VALUES (?, ?, ?, ?, ?, ?)"
    );
    await stmtReceb.bind(endToEndId, gnExtras.pagador.nome, horario, txid, chave, valor).run();
  }

  // Lógica para a tabela "consultas":
  // Insere uma nova linha se não existir ou faz um UPDATE somando o novo valor.
  if (txid && valor !== undefined && valor !== null) {
    const numValor = Number(valor);
    // Verifica se já existe a linha com o txid
    const selectStmt = env.DATA_D1.prepare("SELECT txid, valor FROM consultas WHERE txid = ?");
    const selectResult = await selectStmt.bind(txid).first();
    if (!selectResult) {
      // Insere uma nova linha
      const insertStmt = env.DATA_D1.prepare("INSERT INTO consultas (txid, valor) VALUES (?, ?)");
      await insertStmt.bind(txid, numValor).run();
    } else {
      // Atualiza somando o novo valor ao valor existente
      const updateStmt = env.DATA_D1.prepare("UPDATE consultas SET valor = valor + ? WHERE txid = ?");
      await updateStmt.bind(numValor, txid).run();
    }
  }
}

/**
 * App responsável por tratar o endpoint /consulta-recebimento
 * 
 * Executa:
 * - Consulta de valor na tabela "consultas" pelo txid (enviado no parâmetro "idmaq")
 * - Após consulta, o valor é resetado para 0
 *
 * @param {Request} request 
 * @param {*} env 
 * @returns {Promise<Response>}
 */
async function appConsultaRecebimento(request, env) {
  const url = new URL(request.url);
  const txidParam = url.searchParams.get("idmaq");

  try {
    const selectStmt = env.DATA_D1.prepare("SELECT valor FROM consultas WHERE txid = ?");
    const result = await selectStmt.bind(txidParam).first();
    if (!result) {
      return new Response("ID Not Found.", { status: 404 });
    }

    const valorConsultado = result.valor;

    // Após consulta, atualiza o valor para 0
    const updateStmt = env.DATA_D1.prepare("UPDATE consultas SET valor = ? WHERE txid = ?");
    await updateStmt.bind(0, txidParam).run();

    return new Response(
      JSON.stringify(valorConsultado),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * Retorna uma resposta OPTIONS com os headers CORS apropriados.
 *
 * @param {Request} request 
 * @returns {Response}
 */
function handleOptions(request) {
  const requestHeaders = request.headers.get("Access-Control-Request-Headers");
  const headers = {
    "Access-Control-Allow-Origin": "*", // ou especifique o domínio desejado
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": requestHeaders || "*",
    "Access-Control-Max-Age": "86400"
  };
  return new Response(null, { status: 204, headers });
}

/**
 * Adiciona ou sobrescreve os headers de CORS na resposta final.
 *
 * @param {Response} response 
 * @returns {Response}
 */
function handleResponse(response) {
  let newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");
  newHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  newHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}

