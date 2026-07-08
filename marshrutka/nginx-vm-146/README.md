# Главный nginx предприятия — ВМ 192.168.1.146

Реверс-прокси, на который до 08.07.2026 роутер giga отправлял весь HTTPS-трафик
доменов ПС. Раздавал по путям на docker-контейнеры (192.168.1.211) и сторонние
серверы. **08.07.2026 выводится из цепочки**: домены ПС переезжают на балансировщик
Timeweb → ingress-nginx кластера (см. [[../README.md]] и память `nginx-146-entry-splitter`).

Здесь — **снимок конфигов на момент переезда** (бэкап на самой ВМ:
`/root/nginx-backup-20260708`). Доступ: см. приватную память.

## Карта проксирования (было)

| Домен / listen | conf | upstream | Куда переехало |
|---|---|---|---|
| приоритетстрой.рф | prioritetstroy.conf | 211:1040 (psweb), 211:1033 (iam_admin /register,/assets), 211:8099 (iam /api/v1) | **кластер** ps-prod |
| пс-чат.рф | ps-chat.conf | 211:1034 (chat_frontend), 211:8090 (avito /avito), 211:1033 (iam_admin), 211:8099 (iam), 211:5072 (chat MAX /max/webhook) | **кластер** ps-prod |
| пс-смета.рф | ps-smeta.conf | httpServer = **192.168.1.140:9090** /applications/PSSmeta/ | НЕ переносилось (сервер приложений, не docker) |
| пс-разработчик.рф | ps-razrabotchik.conf | httpServer = **192.168.1.140:9090** /console/ | НЕ переносилось (сервер приложений) |
| :8058 | beeline.conf | **192.168.1.200:8058** (Билайн АТС) | НЕ наше, не трогать |
| :80 (server1c) | server1c.conf | **192.168.1.201:80** (1С) | НЕ наше, не трогать |

`nginx.conf` содержит upstream-определения (site/chat/chatavito/beeline/server1c/httpServer)
и **geo-фильтр `$allow_access`** (geo $allow_ip по офисным/VPN/белым IP + GeoIP2 по стране
RU/BY/KZ). Geo-фильтр в кластер НЕ переносился: L4-балансировщик Timeweb скрывает
клиентский IP (на ingress все запросы = 195.98.86.63) — нужен proxy-protocol.

`GeoLite2-Country.mmdb` обновляется скриптом `UpdateGeoDB.sh` (wget с git.io, без лицензии MaxMind).
