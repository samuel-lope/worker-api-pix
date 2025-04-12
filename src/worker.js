// author: Samuel Lopes
// date: 04.2025
// version: 0.0.3
// - Sobre a versão 0.0.2: a rota "consulta-recebimento"
// agora recupera o valor de um Cloudflare Data Base KV.
// - Sobre a versão 0.0.3: adicionado a opcao de teste com criterios bem especificos.

export default {
  /**
   * @param {{ url: string | URL; headers: { get: (arg0: string) => any; }; method: string; json: () => any; }} request
   * @param {{ HMAC: string; HIDE_PARAM: string; EFI_IP: string; TEST_PASS: string;
   *           MY_R2: { put: (arg0: string, arg1: string) => any; get: (arg0: string) => any; };
   *           MY_KV: { put: (arg0: string, arg1: string) => any; get: (arg0: string, arg1?: string) => any; };
   *           DATA_D1: { prepare: (query: string) => any; }; }} env
   */

  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Endpoint para receber notificações
    if (url.pathname === "/recebimento") {

      let clientIp = null;
      let hmacParam = null;

      // Autorizacao totalmente restrita de Recebimento-TESTE.
      // Necessario: url-webhook/recebimento?hidePARAM-0000000=TEST_PASS
      const hideParam = url.searchParams.get(env.HIDE_PARAM);
      if (hideParam == env.TEST_PASS) {
        clientIp = env.EFI_IP;
        hmacParam = env.HMAC;
      // SE NAO for recebimento de teste, recebe dados da instituicao financeira.
      } else if (!hideParam || hideParam !== env.HIDE_PARAM) {
        clientIp = request.headers.get("CF-Connecting-IP");
        hmacParam = url.searchParams.get("hmac");
      }

      // Validação do IP de origem
      if (clientIp !== env.EFI_IP) {
        return new Response("Endereço IP não autorizado", { status: 403 });
      }
      
      // Validação do HMAC usando a variável de ambiente env.HMAC
      if (!hmacParam || hmacParam !== env.HMAC) {
        return new Response("HMAC inválido ou ausente", { status: 401 });
      }
      
      // Recebimento e tratamento de dados do Webhook.
      if (request.method === "POST") {
        try {
          // Ler o corpo da requisição como JSON
          const data = await request.json();

          // Processar os dados do campo "pix"
          // Supondo que "pix" seja um array de objetos
          if (data.pix && Array.isArray(data.pix)) {
            for (const item of data.pix) {
              // Extrai as chaves "endToEndId", "txid", "chave" e "valor"
              const { horario, gnExtras, endToEndId, txid, chave, valor } = item;
              
              // Exemplo de persistência no R2 utilizando o txid para formar o nome do arquivo
              if (txid && valor) {
                await env.MY_R2.put(`bucket-${txid}.json`, JSON.stringify({ endToEndId, txid, valor }));
              }

              // Exemplo de persistência no KV, utilizando txid como chave
              // Aqui, armazenamos um objeto JSON com a chave "valor"
              if (txid && valor) {
                await env.MY_KV.put(txid, JSON.stringify({ valor }));
              }
              
              // Inserção dos dados na base D1:
              // Verifica se todas as colunas estão presentes antes de inserir
              if (endToEndId && txid && chave && valor && horario) {
                const stmt = env.DATA_D1.prepare(
                  "INSERT INTO recebimentos (eeid, pagador, datahora, txid, chavepix, valor) VALUES (?, ?, ?, ?, ?, ?)"
                );
                await stmt.bind(endToEndId, gnExtras.pagador.nome, horario, txid, chave, valor).run();
              }
            }
          }
  
          console.log("Dados recebidos e persistidos:", data);
  
          return new Response(
            JSON.stringify({ success: true, message: "Sucesso, Ok!" }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        } catch (err) {
          return new Response(
            JSON.stringify({ success: false, error: err.message }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
      } else {
        // Se o método não for POST, retorna erro 405
        return new Response(
          "Método não suportado. Use POST para enviar notificações.",
          { status: 405 }
        );
      }
    }

// Endpoint para consulta dos dados persistidos e atualização do valor
else if (url.pathname === "/consulta-recebimento") {
  const idmaqParam = url.searchParams.get("idmaq");

  try {
    // Obter o valor do objeto KV como JSON
    let jsonData = await env.MY_KV.get(idmaqParam, "json");

    // Se o objeto não for encontrado, retorna 404
    if (jsonData === null || jsonData === undefined) {
      return new Response("ID Not Found.", { status: 404 });
    }

    // Se o dado não for um objeto (por exemplo, é um número), então o transformamos em objeto.
    if (typeof jsonData !== "object") {
      jsonData = { valor: jsonData };
    }

    // Prepara a resposta com o valor lido originalmente
    const responseData = JSON.stringify(jsonData);

    // Atualiza a chave "valor" para 0 (número) e grava novamente no KV.
    jsonData.valor = 0;
    await env.MY_KV.put(idmaqParam, JSON.stringify(jsonData));

    return new Response(responseData, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
} else {
      return new Response("Endpoint não encontrado.", { status: 404 });
    }
  }
};
