
## Efi API PIX usando Cloudflare Worker
### Versão v0.0.3 alpha (estável)

O webhook foi criando usando, unicamente, as ferramentas online disponíveis na página da Cloudflare.

Variáveis de ambiente que são essenciais para o funcionamento do webhook:

| Nome    | Exemplo                          |
| ---     |   ---                            |
| EFI_IP  | 34.193.116.226                   |
| HMAC    | accc9f4a253879ed648fc053330b6bf0 |

Adicionei variáveis de ambiente para ocultar chaves que permitem adicionar dados de pagamento em JSON manualmente, tudo isso utilizando o mesmo webhook de produção:

| Nome      | Exemplo                          | Descrição |
| ---       |   ---                            | ---       |
| HIDE_PARAM  | teste-e4f2aff                    | Parametro oculto para impedir adição indevida de créditos utilizando o ambiente de teste |
| TEST_PASS | ffe822014ca58eae6349f561a5f2876c | Chave hexadecimal para validada. Chamada pelo parametro "teste-e4f2aff" (HIDE_GET)       |

Abaixo, o trecho inicial do código do webhook (POST) com endpoint "/recebimento".

```js
// Endpoint para receber notificações
    if (url.pathname === "/recebimento") {

      let clientIp = null;
      let hmacParam = null;

      // Autorizacao totalmente restrita de Recebimento-TESTE.
      // Necessario: url-webhook/recebimento?hidePARAM-0000000=TEST_PASS
      const hideGetParam = url.searchParams.get(env.HIDE_PARAM);
      if (hideGetParam == env.TEST_PASS) {
        clientIp = env.EFI_IP;
        hmacParam = env.HMAC;
      // SE NAO for recebimento de teste, recebe dados da instituicao financeira.
      } else if (!hideParam || hideParam !== env.HIDE_PARAM) {
        clientIp = request.headers.get("CF-Connecting-IP");
        hmacParam = url.searchParams.get("hmac");
      }
// o código continua...
```
As versões ainda estão sendo implementadas.


