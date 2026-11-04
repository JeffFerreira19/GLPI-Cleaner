# zabbix-glpi-cleaner

API + painel web que identificam chamados do **grupo técnico Nível 1** gerados pelo Zabbix cujo
evento **recuperou sem reconhecimento/observação de operador** e os enviam à **lixeira**
(nunca exclusão definitiva), conforme a matriz de decisão C01–C17 / B01–B24.

## Escopo: grupo técnico Nível 1
- A busca no GLPI só retorna chamados cujo **grupo técnico** é `GLPI_TECH_GROUP_IDS`.
- Na avaliação e na **revalidação antes da lixeira**, o grupo é conferido de novo:
  - `GLPI_GROUP_NOT_ALLOWED` (B23): chamado saiu do Nível 1 (ex.: escalado para o N2).
  - `GLPI_OTHER_GROUP_ASSIGNED` (B24): Nível 1 + outro grupo técnico (se `GLPI_TECH_GROUP_EXCLUSIVE=true`).
- Descobrir o ID: `scripts\descobrir-grupo.ps1 -Nome "Nivel 1"` ou `GET /api/diagnostics/groups?name=Nível`.

## Vínculo evento × chamado
1. **Event ID** no texto do chamado (se existir).
2. **Nome + horário**: título e nome do evento sem o prefixo `[Incidente] ` e evento iniciado
   até `CORRELATION_MAX_DELAY_SECONDS` antes da abertura. Mais de um evento compatível → Revisão manual.

## Instalação / atualização
```powershell
copy .env.example .env      # na 1ª instalação
npm install
npm run build
.\scripts\install-service.ps1
```

## Endpoints
| Método | Rota | Descrição |
|---|---|---|
| GET | /health | Estado, modo e grupo técnico |
| GET | /api/connections | Testa Zabbix e GLPI |
| GET | /api/candidates?result=ELIGIBLE | Avalia candidatos (somente leitura) |
| GET | /api/candidates/:ticketId | Diagnóstico de um chamado |
| GET | /api/diagnostics/ticket/:ticketId | Grupos, vínculo e quem reconheceu o evento |
| GET | /api/diagnostics/groups?name=Nível | Descobre o ID do grupo |
| POST | /api/cleanup/preview | Simulação + auditoria |
| POST | /api/cleanup/execute | Execução real (X-API-Key) |
| POST | /api/candidates/:ticketId/trash | Lixeira individual (X-API-Key) |
| GET | /api/audit?action=TRASHED&limit=100 | Auditoria |
