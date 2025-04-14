# API PIX com Cloudflare Workers

Este documento reúne toda a documentação relacionada à aplicação que utiliza Cloudflare Workers para **receber, processar e persistir dados de pagamentos PIX** de uma instituição financeira, além de **permitir a ativação de aparelhos IoT** embarcados.

---

## Sumário
- [Introdução](#introdução)
- [Arquitetura e Bindings](#arquitetura-e-bindings)
- [Funcionalidades e Endpoints](#funcionalidades-e-endpoints)
  - [Roteamento e Configuração do Worker](#roteamento-e-configuração-do-worker)
  - [Endpoint `/recebimento` (POST)](#endpoint-recebimento-post)
  - [Função Auxiliar: `processPixItem`](#função-auxiliar-processpixitem)
  - [Endpoint `/consulta-recebimento` (GET)](#endpoint-consulta-recebimento-get)
  - [Endpoint `/consulta-database` (GET)](#endpoint-consulta-database-get)
- [Suporte a CORS](#suporte-a-cors)
- [Deploy na Cloudflare](#deploy-na-cloudflare)
- [Conclusão](#conclusão)

---

## Introdução

Esta aplicação é desenvolvida utilizando **Cloudflare Workers** para criar uma solução escalável e de alta performance. Ela tem como objetivo principal:
- **Receber notificações de pagamentos PIX** através de requisições HTTP;
- **Processar os dados** enviados, validando a origem e a autenticidade das requisições;
- **Persistir os registros** tanto em um banco de dados SQL (Cloudflare D1) quanto no armazenamento de arquivos JSON em um bucket R2;
- **Permitir consultas posteriores** dos dados e gerenciar a ativação de dispositivos IoT baseados nas informações de transações.

---

## Arquitetura e Bindings

A aplicação utiliza os seguintes recursos da Cloudflare:

- **Cloudflare Workers:** Responsável por gerenciar as requisições e executar o código de roteamento, processamento e persistência.
- **Cloudflare D1:** Banco de dados SQL utilizado para armazenar registros de pagamentos, sendo utilizado nos endpoints `/recebimento`, `/consulta-recebimento` e `/consulta-database`.
- **Cloudflare R2:** Bucket para armazenamento de arquivos (exemplo: JSON contendo dados resumidos de cada transação).

### Variáveis de Ambiente

Além dos bindings, o sistema utiliza as seguintes variáveis de ambiente para controle de acesso e configuração:
- `HMAC`
- `HIDE_PARAM`
- `EFI_IP`
- `TEST_PASS`

---

## Funcionalidades e Endpoints

A aplicação possui três endpoints principais que são gerenciados pela função `fetch` do Worker.

### Roteamento e Configuração do Worker

A função principal realiza o roteamento das requisições para os endpoints corretos e trata as requisições **OPTIONS** para garantir o suporte a CORS.

```js
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return handleOptions(request);
    }

    const url = new URL(request.url);
    let response;

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
```
Resumo:
Essa função roteia as requisições conforme o pathname da URL e assegura que todas as respostas possuam os cabeçalhos CORS adequados.
***
## Endpoint /recebimento (POST)

Funcionalidade
O endpoint /recebimento realiza as seguintes ações:

**Validação de Acesso:**
- Verifica o IP de origem e valida o HMAC ou utiliza parâmetros de teste se presentes.

**Processamento dos Dados:**
- Espera receber um objeto JSON contendo um array chamado pix com os dados das transações.

**Persistência dos Dados:**

- Armazena informações resumidas de cada transação como um arquivo JSON no bucket R2.

- Insere os detalhes da transação na tabela recebimentos do banco de dados D1.

- Realiza inserção/atualização na tabela consultas para suporte a consultas posteriores.

```js
async function appRecebimento(request, env) {
  // Validação de acesso: se for requisição de teste, usa os parâmetros de teste.
  // Determina o IP de origem e o parâmetro HMAC.
  // ...

  if (request.method !== "POST") {
    return new Response("Método não suportado. Use POST para enviar notificações.", { status: 405 });
  }

  try {
    const data = await request.json();

    if (data.pix && Array.isArray(data.pix)) {
      for (const item of data.pix) {
        await processPixItem(item, env);
      }
    }

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
```
***
## Função Auxiliar: processPixItem
 - Esta função é chamada para cada item recebido no array pix e executa:

**Armazenamento no R2:**
 - Grava um arquivo JSON identificável pelo campo txid.

**Inserção na Tabela recebimentos:**
 - Registra os dados completos da transação, incluindo o identificador, nome do pagador, data/hora, chave PIX, e valor.

**Gerenciamento na Tabela consultas:**
 - Verifica se o registro já existe:
 - Caso não exista, insere um novo registro.
 - Se existir, atualiza o valor acumulando o novo valor e atualiza o campo datahora.

```js
async function processPixItem(item, env) {
  const { horario, gnExtras, endToEndId, txid, chave, valor } = item;

  if (txid && valor) {
    await env.MY_R2.put(`bucket-${txid}.json`, JSON.stringify({ endToEndId, txid, valor }));
  }

  if (endToEndId && txid && chave && valor && horario) {
    const stmtReceb = env.DATA_D1.prepare(
      "INSERT INTO recebimentos (eeid, pagador, datahora, txid, chavepix, valor) VALUES (?, ?, ?, ?, ?, ?)"
    );
    await stmtReceb.bind(endToEndId, gnExtras.pagador.nome, horario, txid, chave, valor).run();
  }

  // Lógica para inserção ou atualização na tabela "consultas"...
}
```
***
## Endpoint /consulta-recebimento (GET)
**Funcionalidade**
  - Este endpoint realiza a consulta de um registro na tabela consultas utilizando o campo txid, fornecido via o parâmetro idmaq. Após a recuperação do valor:

**Reset:**
  - O valor consultado é resetado para 0 na tabela, prevenindo consultas duplicadas.

```js
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
```
***
Endpoint /consulta-database (GET)
Funcionalidade
Este endpoint permite consultas gerais às tabelas recebimentos ou consultas. Ele:

 - **Verifica o Método:**
  Aceita apenas requisições GET.

 - **Valida o Parâmetro:**
  Exige o parâmetro db que especifica qual tabela consultar.

 - **Consulta e Formatação:**
  Recupera as colunas txid, valor e datahora, ordenando os registros pela data/hora em ordem decrescente, e formata o resultado como uma tabela de texto com colunas separadas pelo caractere "|".

```js
async function appConsultaDatabase(request, env) {
  if (request.method !== "GET") {
    return new Response("Método não suportado. Use GET para consultar o banco de dados.", { status: 405 });
  }

  const url = new URL(request.url);
  const db = url.searchParams.get("db");

  if (!db) {
    return new Response("Parâmetro 'db' ausente.", { status: 400 });
  }

  // Permite apenas as tabelas autorizadas: "recebimentos" e "consultas".
  const allowedTables = ["recebimentos", "consultas"];
  if (!allowedTables.includes(db)) {
    return new Response("Tabela não autorizada para consulta.", { status: 403 });
  }

  try {
    const queryStmt = env.DATA_D1.prepare(
      `SELECT txid, valor, datahora FROM ${db} ORDER BY datahora DESC`
    );
    const result = await queryStmt.all();
    // Processamento e formatação dos resultados
    let rows = result.results;
    let headers;

    if (rows && rows.length > 0) {
      headers = Object.keys(rows[0]);
    } else {
      // Se não houver registros, utiliza o esquema da tabela
      const pragmaStmt = env.DATA_D1.prepare(`PRAGMA table_info(${db})`);
      const pragmaResult = await pragmaStmt.all();
      if (pragmaResult.results && pragmaResult.results.length > 0) {
        headers = pragmaResult.results.map(col => col.name)
          .filter(col => ["txid", "valor", "datahora"].includes(col));
      } else {
        return new Response("Não foi possível determinar as colunas da tabela.", { status: 500 });
      }
    }

    const formattedTable = formatTable(headers, rows);
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
```
**Observação:**
A função formatTable é responsável por montar uma tabela de texto organizada para facilitar a visualização dos dados.
***
## Suporte a CORS
  Para suportar requisições de diferentes origens, o código define duas funções que garantem que os cabeçalhos CORS sejam corretamente aplicados:

**1. handleOptions** </br>
  Responde às requisições OPTIONS, retornando os cabeçalhos necessários para CORS.
  ```js
function handleOptions(request) {
  const requestHeaders = request.headers.get("Access-Control-Request-Headers");
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": requestHeaders || "*",
    "Access-Control-Max-Age": "86400"
  };
  return new Response(null, { status: 204, headers });
}
```
---
**2. handleResponse** </br>
  Adiciona os cabeçalhos CORS às respostas enviadas aos clientes.
```js
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
```
***

## Deploy na Cloudflare
Para publicar esta aplicação na Cloudflare, siga os passos abaixo:

**1. Acessar o Cloudflare Dashboard:**
Entre na sua conta em Cloudflare Dashboard.

**2. Criar um Novo Worker:**
Selecione a opção para criar um novo Worker no menu de gerenciamento.

**3. Configurar os Bindings e Variáveis de Ambiente:**

 - DATA_D1: Associe seu banco de dados Cloudflare D1.

 - MY_R2: Configure seu bucket R2.

 - Configure as variáveis de ambiente necessárias: HMAC, HIDE_PARAM, EFI_IP e TEST_PASS.

**4. Realizar o Deploy:**
Copie o código para o editor do Worker e publique a aplicação.

***
## Conclusão
**Esta aplicação integra:**

**1. Recepção e processamento de notificações PIX:** </br>
Permitindo a captura e validação dos dados de transações.

**2. Persistência dos dados:** </br>
Utilizando o Cloudflare D1 para registros detalhados e o Cloudflare R2 para armazenamento de arquivos JSON.

**3. Consultas dinâmicas:** </br>
Oferecendo endpoints para consulta e reset de valores para controle e ativação de dispositivos IoT.

**4. Suporte completo a CORS:** </br>
Garantindo que a aplicação seja acessível de diferentes origens.

**5. Deploy Facilitado:** </br>
Com a infraestrutura escalável e robusta dos Cloudflare Workers.

Esta solução é ideal para ambientes que necessitam de alta disponibilidade e confiabilidade no processamento de transações PIX, além de possibilitar a integração com aparelhos IoT para ações em tempo real.
