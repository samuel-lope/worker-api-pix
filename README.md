
## Efi API PIX usando Cloudflare Worker
#### Versão v0.0.14-alpha (estável)
Removida a referência ao Bucket R2 da Cloudflare, que guardava o JSON recebido pela instituição via webhook.

O webhook foi criando usando, unicamente, as ferramentas online disponíveis na página da Cloudflare, **com a vantagem extrema de não precisar lidar com dependências ou atualizações aplicações externas**.

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




