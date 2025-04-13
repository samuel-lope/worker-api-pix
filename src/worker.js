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
    let response; // variável para conter a resposta

    // ------------------------------------
    // Endpoint: /recebimento
    // ------------------------------------
    if (url.pathname === "/recebimento") {
      let clientIp = null;
      let hmacParam = null;

      // Verifica se é uma requisição de teste
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

          // Processa os dados do campo "pix" (supondo que seja um array de objetos)
          if (data.pix && Array.isArray(data.pix)) {
            for (const item of data.pix) {
              const { horario, gnExtras, endToEndId, txid, chave, valor } = item;

              // Persistência no R2: grava um arquivo identificando-o com "txid"
              if (txid && valor) {
                await env.MY_R2.put(`bucket-${txid}.json`, JSON.stringify({ endToEndId, txid, valor }));
              }

              // Inserção em "recebimentos" (tabela existente para registro de detalhes)
              if (endToEndId && txid && chave && valor && horario) {
                const stmtReceb = env.DATA_D1.prepare(
                  "INSERT INTO recebimentos (eeid, pagador, datahora, txid, chavepix, valor) VALUES (?, ?, ?, ?, ?, ?)"
                );
                await stmtReceb.bind(endToEndId, gnExtras.pagador.nome, horario, txid, chave, valor).run();
              }

              // Nova lógica para a tabela "consultas":
              // Se o txid não existe na tabela "consultas", insere uma nova linha;
              // Caso já exista, faz um UPDATE adicionando o novo valor ao valor existente.
              if (txid && valor !== undefined && valor !== null) {
                const numValor = Number(valor);
                // Verifica se já existe a linha com o txid
                const selectStmt = env.DATA_D1.prepare("SELECT txid, valor FROM consultas WHERE txid = ?");
                const selectResult = await selectStmt.bind(txid).first();
                if (!selectResult) {
                  // Não existe: insere a nova linha
                  const insertStmt = env.DATA_D1.prepare("INSERT INTO consultas (txid, valor) VALUES (?, ?)");
                  await insertStmt.bind(txid, numValor).run();
                } else {
                  // Já existe: faz UPDATE somando o novo valor ao valor já armazenado
                  const updateStmt = env.DATA_D1.prepare("UPDATE consultas SET valor = valor + ? WHERE txid = ?");
                  await updateStmt.bind(numValor, txid).run();
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
      const txidParam = url.searchParams.get("idmaq"); // aqui, "idmaq" é o txid a consultar
      try {
        const selectStmt = env.DATA_D1.prepare("SELECT valor FROM consultas WHERE txid = ?");
        const result = await selectStmt.bind(txidParam).first();
        if (!result) {
          response = new Response("ID Not Found.", { status: 404 });
          return handleResponse(response);
        }
        // Recupera o valor (espera-se que seja um número, exemplo: 0.03)
        const valorConsultado = result.valor;
        const responseData = JSON.stringify(valorConsultado);
        // Após consulta, atualiza o valor para 0
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
 * Adiciona ou sobrescreve os headers de CORS na resposta final.
 * @param {Response} response
 */
function handleResponse(response) {
  let newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*"); // ajuste conforme necessário
  newHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  newHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}
