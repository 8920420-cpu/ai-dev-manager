ARG ALBIA_BASE_IMAGE=localhost:5000/albia:latest
FROM ${ALBIA_BASE_IMAGE}

COPY entrypoint.sh /opt/albia/bin/entrypoint.sh
COPY register-connection.sh /opt/albia/bin/register-connection.sh
COPY www/ /opt/albia/www/

RUN chmod +x /opt/albia/bin/entrypoint.sh /opt/albia/bin/register-connection.sh /opt/albia/www/cgi-bin/register \
  && mkdir -p /opt/albia/registry

EXPOSE 8090

ENTRYPOINT ["/opt/albia/bin/entrypoint.sh"]
