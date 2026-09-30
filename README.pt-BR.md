> **Idioma:** [English](README.md) · Português (Brasil)

# Nexo

### Interface web local para Codex

O **Nexo** é um workspace local para conversas, controles de modelo, níveis de raciocínio, aprovações, anexos e fluxos de desenvolvimento usando a instalação local autenticada do Codex.

## Como funciona

O navegador se comunica apenas com um bridge Python em `127.0.0.1`. Esse bridge inicia `codex app-server --stdio` e troca mensagens estruturadas com o serviço local.

As credenciais do Codex não são copiadas para o navegador.

## Destaques

- Histórico de conversas;
- busca, favoritos e arquivo local;
- retomar e renomear threads;
- exportação Markdown;
- respostas progressivas;
- visualização de comandos e atividades;
- solicitações de aprovação na interface;
- modo de autonomia opcional;
- interrupção da execução atual;
- anexos e imagens;
- modos **Conversa** e **Work**;
- catálogo dinâmico de modelos;
- opções de nível de raciocínio;
- roteamento automático local;
- painel de conta/uso quando disponível;
- tema claro/escuro e layout responsivo.

## Segurança local

- bind somente em `127.0.0.1`;
- validação de Host e Origin;
- token local imprevisível por processo;
- limite de tamanho de requisições;
- bloqueio de anexos executáveis;
- escrita restrita a pastas pessoais autorizadas;
- Content Security Policy restritiva;
- fluxo normal de sandbox e aprovações do Codex.

## Portfolio Edition

Histórico local, logs, autenticação, schemas gerados, caminhos pessoais e anexos foram excluídos da versão pública.

---

Desenvolvido por **Eduardo Lima**.
