// author: Samuel Lopes
// date: 04.2025
// version: 0.0.11 (remoção da exibição da coluna "datahora" na tabela TXT, mantendo-a para ordenação)

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
    let response;

    // Roteamento dos endpoints
    switch (url.pathname) {
      case "/recebimento":
        response = await appRecebimento(request, env);
        break;
      case "/consulta-recebimento":
        response = await appConsultaRecebimento(request, env);
        break;
      case "/consulta-database":
        response = await appConsultaDatabase(request, env);
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
 * A atualização na tabela "consultas":
 * - Arredonda o novo valor recebido para no máximo duas casas decimais;
 * - Se o registro já existir, o novo valor é somado ao valor existente (também arredondado);
 * - O campo "datahora" é atualizado.
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
  // Insere uma nova linha se não existir ou atualiza somando o novo valor e atualizando a datahora.
  if (txid && valor !== undefined && valor !== null) {
    const numValor = Number(valor);
    // Arredonda o novo valor para no máximo duas casas decimais
    const roundedValue = Math.round(numValor * 100) / 100;
    
    // Verifica se já existe a linha com o txid
    const selectStmt = env.DATA_D1.prepare("SELECT txid, valor FROM consultas WHERE txid = ?");
    const selectResult = await selectStmt.bind(txid).first();
    if (!selectResult) {
      // Insere uma nova linha com o valor arredondado
      const insertStmt = env.DATA_D1.prepare("INSERT INTO consultas (txid, valor) VALUES (?, ?)");
      await insertStmt.bind(txid, roundedValue).run();
    } else {
      // Atualiza somando o novo valor ao valor existente e atualiza o campo datahora.
      // A soma é arredondada para duas casas decimais usando a função ROUND do SQLite.
      const updateStmt = env.DATA_D1.prepare("UPDATE consultas SET valor = ROUND(valor + ?, 2), datahora = ? WHERE txid = ?");
      await updateStmt.bind(roundedValue, horario, txid).run();
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
 * Novo App responsável por tratar o endpoint /consulta-database
 * 
 * Permite consultar todas as linhas de uma tabela (restrita a "recebimentos" ou "consultas")
 * exibindo apenas as colunas "txid" e "valor". O resultado é formatado como uma tabela
 * de texto com bordas, conforme exemplo anexo.
 * 
 * Os dados serão apresentados ordenados pelo campo "datahora" em ordem decrescente
 * (os registros mais recentes aparecem primeiro).
 *
 * @param {Request} request 
 * @param {*} env 
 * @returns {Promise<Response>}
 */
async function appConsultaDatabase(request, env) {
  if (request.method !== "GET") {
    return new Response("Método não suportado. Use GET para consultar o banco de dados.", { status: 405 });
  }

  const url = new URL(request.url);
  const db = url.searchParams.get("db");

  if (!db) {
    return new Response("Parâmetro 'db' ausente.", { status: 400 });
  }

  // Permite apenas tabelas autorizadas para consulta
  const allowedTables = ["recebimentos", "consultas"];
  if (!allowedTables.includes(db)) {
    return new Response("Tabela não autorizada para consulta.", { status: 403 });
  }

  try {
    // Consulta inclui o campo "datahora" para ordenação, mas ele não será exibido
    const queryStmt = env.DATA_D1.prepare(
      `SELECT txid, valor, datahora FROM ${db} ORDER BY datahora DESC`
    );
    const result = await queryStmt.all();
    let rows = result.results;

    // Mapeia os registros para exibir apenas as colunas "txid" e "valor"
    const outputRows = rows.map(row => ({
      txid: row.txid,
      valor: row.valor
    }));

    // Define os headers fixos para saída: apenas "txid" e "valor"
    const outputHeaders = ["txid", "valor"];

    const formattedTable = formatTable(outputHeaders, outputRows);
    const responseText = `Tabela ${db}:\n\n${formattedTable}`;
    return new Response(responseText, {
      status: 200,
      headers: { "Content-Type": "text/plain" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
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

/**
 * Formata os dados em forma de tabela de texto com bordas, conforme o exemplo anexado.
 * A tabela inclui:
 * - Uma linha de borda no início, após o cabeçalho e no final.
 * - Cabeçalho e linhas de dados com colunas separadas por "|" e espaços para alinhamento.
 *
 * @param {string[]} headers - Array com os nomes das colunas a serem exibidas.
 * @param {object[]} rows - Array de objetos com os registros a serem exibidos.
 * @returns {string} Tabela formatada em texto.
 */
function formatTable(headers, rows) {
  // Calcula o tamanho máximo de cada coluna, considerando os headers e os dados
  const colWidths = headers.map(header => header.length);
  for (const row of rows) {
    headers.forEach((header, idx) => {
      const cell = row[header] !== null && row[header] !== undefined ? String(row[header]) : "";
      colWidths[idx] = Math.max(colWidths[idx], cell.length);
    });
  }

  // Função auxiliar para preencher com espaços
  const pad = (str, width) => str + " ".repeat(width - str.length);

  // Cria a linha de borda (ex: +-----+-------+-----+)
  const borderLine = "+" + colWidths.map(width => "-".repeat(width + 2)).join("+") + "+";

  // Cria a linha de cabeçalho (ex: | header1 | header2 | header3 |)
  const headerRow = "| " + headers.map((header, idx) => pad(header, colWidths[idx])).join(" | ") + " |";

  // Cria as linhas dos registros
  const dataRows = rows.map(row => {
    return "| " + headers.map((header, idx) => {
      const cell = row[header] !== null && row[header] !== undefined ? String(row[header]) : "";
      return pad(cell, colWidths[idx]);
    }).join(" | ") + " |";
  });

  // Junta as partes: borda, cabeçalho, borda, dados e borda final
  return [borderLine, headerRow, borderLine, ...dataRows, borderLine].join("\n");
}

