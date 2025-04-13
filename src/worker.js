// author: Samuel Lopes
// date: 04.2025
// version: 0.0.4 (sem MY_KV e usando a tabela "consultas" no D1 para persistência do valor)

/**
 * O Worker utiliza as seguintes bindings:
 * - DATA_D1: Banco de dados D1 (Cloudflare D1)
 * - MY_R2: Bucket R2 para armazenamento de arquivos
 *
 * As variáveis de ambiente (via env.vars) incluem:
 * HMAC, HIDE_PARAM, EFI_IP, TEST_PASS.
 */

export default {
  /**
   * @param {Request} request
   * @param {{
   *    HMAC: string;
   *    HIDE_PARAM: string;
   *    EFI_IP: string;
   *    TEST_PASS: string;
   *    MY_R2: { put: (arg0: string, arg1: string) => Promise<any>; get: (arg0: string) => Promise<any>; };
   *    DATA_D1: { prepare: (query: string) => any; };
   * }} env
   */
  async fetch(request, env) {
    // Responde imediatamente às requisições OPTIONS com os headers CORS.
    if (request.method === "OPTIONS") {
      return handleOptions(request);
    }

    const url = new URL(request.url);
    let response; // Será definida conforme o endpoint

    // ------------------------------------
    // Endpoint: /recebimento
    // ------------------------------------
    if (url.pathname === "/recebimento") {
      let clientIp = null;
      let hmacParam = null;

      // Verifica se se trata de uma requisição de teste usando o parâmetro configurado.
      const hideParam = url.searchParams.get(env.HIDE_PARAM);
      if (hideParam === env.TEST_PASS) {
        // Modo teste: força valores de IP e HMAC
        clientIp = env.EFI_IP;
        hmacParam = env.HMAC;
      } else {
        // Modo normal: utiliza valores enviados na requisição
        clientIp = request.headers.get("CF-Connecting-IP");
        hmacParam = url.searchParams.get("hmac");
      }

      // Validação do IP
      if (clientIp !== env.EFI_IP) {
        response = new Response("Endereço IP não autorizado", { status: 403 });
        return handleResponse(response);
      }

      // Validação do HMAC
      if (!hmacParam || hmacParam !== env.HMAC) {
        response = new Response("HMAC inválido ou ausente", { status: 401 });
        return handleResponse(response);
      }

      if (request.method === "POST") {
        try {
          const data = await request.json();

          // Processamento dos dados no campo "pix"
          if (data.pix && Array.isArray(data.pix)) {
            for (const item of data.pix) {
              const { horario, gnExtras, endToEndId, txid, chave, valor } = item;

              // Persistência no R2: grava o arquivo identificando-o com "txid"
              if (txid && valor) {
                await env.MY_R2.put(`bucket-${txid}.json`, JSON.stringify({ endToEndId, txid, valor }));
              }

              // Inserção em "recebimentos" na base D1 (mantemos a inserção original, se necessária)
              if (endToEndId && txid && chave && valor && horario) {
                const stmtReceb = env.DATA_D1.prepare(
                  "INSERT INTO recebimentos (eeid, pagador, datahora, txid, chavepix, valor) VALUES (?, ?, ?, ?, ?, ?)"
                );
                await stmtReceb.bind(endToEndId, gnExtras.pagador.nome, horario, txid, chave, valor).run();
              }

              // NOVO: Verifica se o txid já existe na tabela "consultas". Se não existir, insere-o.
              if (txid && valor !== undefined && valor !== null) {
                const selectStmt = env.DATA_D1.prepare("SELECT txid FROM consultas WHERE txid = ?");
                const selectResult = await selectStmt.bind(txid).all();
                if (!selectResult.results || selectResult.results.length === 0) {
                  // Converte o valor para número
                  const numValor = Number(valor);
                  const insertStmt = env.DATA_D1.prepare("INSERT INTO consultas (txid, valor) VALUES (?, ?)");
                  await insertStmt.bind(txid, numValor).run();
                }
              }
            }
          }

          console.log("Dados recebidos e persistidos:", data);
          response = new Response(JSON.stringify({ success: true, message: "Sucesso, Ok!" }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        } catch (err) {
          response = new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }
      } else {
        response = new Response("Método não suportado. Use POST para enviar notificações.", { status: 405 });
      }
    }
    // ------------------------------------
    // Endpoint: /consulta-recebimento
    // ------------------------------------
    else if (url.pathname === "/consulta-recebimento") {
      // Assume que o parâmetro "idmaq" é o txid para consulta
      const txidParam = url.searchParams.get("idmaq");
      try {
        // Consulta o valor na tabela "consultas" para o txid
        const selectStmt = env.DATA_D1.prepare("SELECT valor FROM consultas WHERE txid = ?");
        const result = await selectStmt.bind(txidParam).first();
        if (!result) {
          response = new Response("ID Not Found.", { status: 404 });
          return handleResponse(response);
        }
        // Armazena o valor (espera-se um número, ex.: 0.03)
        const valorConsultado = result.valor;
        // Prepara a resposta; aqui, retornamos apenas o valor (por exemplo, 0.03)
        const responseData = JSON.stringify(valorConsultado);
        // Realiza o UPDATE definindo o valor para 0 na tabela "consultas"
        const updateStmt = env.DATA_D1.prepare("UPDATE consultas SET valor = ? WHERE txid = ?");
        await updateStmt.bind(0, txidParam).run();
        response = new Response(responseData, {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        response = new Response(JSON.stringify({ success: false, error: error.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    // ------------------------------------
    // Endpoint não encontrado
    // ------------------------------------
    else {
      response = new Response("Endpoint não encontrado.", { status: 404 });
    }

    return handleResponse(response);
  }
};

/**
 * Retorna uma resposta OPTIONS com os headers CORS apropriados.
 * @param {Request} request
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
 * Adiciona os headers CORS à resposta final.
 * @param {Response} response
 */
function handleResponse(response) {
  let newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");  // ajuste para um domínio específico se necessário
  newHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  newHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}
