ARG ALBIA_BASE_IMAGE=localhost:5000/albia:latest
FROM ${ALBIA_BASE_IMAGE}

RUN apk add --no-cache openssh-client curl jq

COPY entrypoint.sh /opt/albia/bin/entrypoint.sh
COPY register-connection.sh /opt/albia/bin/register-connection.sh
COPY provision-k3s.sh /opt/albia/bin/provision-k3s.sh
COPY www/ /opt/albia/www/

RUN chmod +x /opt/albia/bin/entrypoint.sh /opt/albia/bin/register-connection.sh /opt/albia/bin/provision-k3s.sh /opt/albia/www/cgi-bin/register /opt/albia/www/cgi-bin/boot-guard \
  && mkdir -p /opt/albia/registry

EXPOSE 8090

ENTRYPOINT ["/opt/albia/bin/entrypoint.sh"]
