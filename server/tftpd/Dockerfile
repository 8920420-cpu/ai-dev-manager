FROM alpine:3.20

RUN apk add --no-cache tftp-hpa

EXPOSE 69/udp

# --foreground + secure chroot в /srv/tftp (read-only отдача файлов)
ENTRYPOINT ["in.tftpd", "--foreground", "--secure", "--verbose", "/srv/tftp"]
