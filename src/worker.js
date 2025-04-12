// author: Samuel Lopes
// date: 04.2025
// version: 0.0.3 (com CORS adaptado)

// Exporta o Worker usando o formato de módulo (ES Modules)
export default {
  /**
   * @param {Request} request
   * @param {{ HMAC: string; HIDE_PARAM: string; EFI_IP: string; TEST_PASS: string;
   *           MY_R2: { put: (arg0: string, arg1: string) => any; get: (arg0: string) => any; };
   *           MY_KV: { put: (arg0: string, arg1: string) => any; get: (arg0: string, arg1?: string) => any; };
   *           DATA_D1: { prepare: (query: string) => any; }; }} env
   */
  async fetch(request, env) {
    // Se for uma requisição de preflight OPTIONS, responda imediatamente.
    if (request.method === "OPTIONS") {
      return handleOptions(request);
    }

    // Obtenha a URL da requisição para uso na lógica de roteamento.
    const url = new URL(request.url);
    let response; // variável para conter a resposta que será processada

    // ------------------------------
    // Endpoint para /recebimento
    // ------------------------------
    if (url.pathname === "/recebimento") {
      let clientIp = null;
      let hmacParam = null;

      // Caso se trate de um recebimento de teste
      const hideParam = url.searchParams.get(env.HIDE_PARAM);
      if (hideParam === env.TEST_PASS) {
        // Força os valores para teste
        clientIp = env.EFI_IP;
        hmacParam = env.HMAC;
      } else {
        // Modo normal: usa os valores enviados
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

      // Apenas processa requisições POST
      if (request.method === "POST") {
        try {
          // Tente ler o corpo como JSON
          const data = await request.json();

          // Processa os dados do campo "pix" (supondo que seja um array de objetos)
          if (data.pix && Array.isArray(data.pix)) {
            for (const item of data.pix) {
              // Extrai as chaves necessárias
              const { horario, gnExtras, endToEndId, txid, chave, valor } = item;

              // Persistência no R2: grava um arquivo com o txid no nome
              if (txid && valor) {
                await env.MY_R2.put(`bucket-${txid}.json`, JSON.stringify({ endToEndId, txid, valor }));
              }

              // Persistência no KV: armazena um objeto JSON com a chave "valor" usando txid como chave
              if (txid && valor) {
                await env.MY_KV.put(txid, JSON.stringify({ valor }));
              }

              // Inserção no banco D1: insere os dados na tabela "recebimentos" se todos os valores estiverem presentes
              if (endToEndId && txid && chave && valor && horario) {
                const stmt = env.DATA_D1.prepare(
                  "INSERT INTO recebimentos (eeid, pagador, datahora, txid, chavepix, valor) VALUES (?, ?, ?, ?, ?, ?)"
                );
                await stmt.bind(endToEndId, gnExtras.pagador.nome, horario, txid, chave, valor).run();
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
    // -----------------------------------------
    // Endpoint para /consulta-recebimento
    // -----------------------------------------
    else if (url.pathname === "/consulta-recebimento") {
      const idmaqParam = url.searchParams.get("idmaq");
      try {
        // Recupera o valor do objeto KV como JSON
        let jsonData = await env.MY_KV.get(idmaqParam, "json");

        // Se não encontrado, retorne 404
        if (jsonData === null || jsonData === undefined) {
          response = new Response("ID Not Found.", { status: 404 });
          return handleResponse(response);
        }

        // Se o dado não for objeto (por exemplo, um número), transforma-o em objeto.
        if (typeof jsonData !== "object") {
          jsonData = { valor: jsonData };
        }

        // Prepara a resposta com o valor lido originalmente
        const responseData = JSON.stringify(jsonData);

        // Atualiza o valor para 0 e grava novamente no KV.
        jsonData.valor = 0.00;
        await env.MY_KV.put(idmaqParam, JSON.stringify(jsonData));

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
    // -----------------------------------------
    // Se nenhum endpoint corresponder
    // -----------------------------------------
    else {
      response = new Response("Endpoint não encontrado.", { status: 404 });
    }

    // Por fim, sempre retorne a resposta com os headers de CORS
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
  // Adiciona ou atualiza os headers CORS
  newHeaders.set("Access-Control-Allow-Origin", "*");  // ajuste para um domínio específico se necessário
  newHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  newHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}
