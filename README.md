# Infinity Price

## Executar localmente

O projeto usa apenas a biblioteca padrão do Python e o SQLite incluído no Python.

1. Abra um terminal nesta pasta.
2. Execute `python server.py`.
3. Acesse <http://localhost:5173>.

O banco `data/infinity_price.db` é criado automaticamente na primeira execução. Ele guarda contas e perfis, rascunho atual da calculadora, histórico de cálculos, catálogo, vendas, equipe e movimentações. O rascunho da calculadora é salvo automaticamente; as senhas são armazenadas como hashes e o navegador mantém apenas a sessão local. O histórico de cálculos criado anteriormente no navegador é importado para o SQLite no próximo acesso e só é removido do armazenamento local após a confirmação da importação.

## Recursos

- Calculadora com validação de margem e impostos, composição do preço, histórico editável no SQLite e opção de salvar o detalhamento como PDF pela impressão do navegador.
- Catálogo de produtos e serviços com preços e controle opcional de estoque.
- Registro e acompanhamento de vendas do catálogo ou avulsas, com preço unitário próprio, atualização de pagamento e histórico automático no extrato.
- Cadastro local de integrantes da equipe, sem criação de contas ou permissões de acesso.
- Visão geral com saldo, vendas recentes e gráfico dos últimos seis meses.
- Links demonstrativos para compartilhar o resumo de uma venda pendente. Eles não processam pagamentos e, como o servidor usa localhost, só podem ser abertos neste computador.

Contas criadas antes desta atualização são transferidas do navegador para o SQLite quando o usuário entrar novamente; outros dados locais antigos são mantidos até sua migração. O valor da hora informado na calculadora é apenas informativo e não altera o preço. Para gerar o PDF, escolha “Salvar como PDF” na janela de impressão. O servidor foi projetado para uso local; não o publique na internet sem implementar controles de autenticação e autorização apropriados.
