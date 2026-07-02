#!/bin/sh
set -eu

: "${PXE_DHCP_RANGE:=192.168.1.200,192.168.1.240,12h}"
: "${PXE_DNS:=1.1.1.1}"
: "${PXE_HTTP_PORT:=8088}"
: "${PXE_INTERFACE:=}"
: "${PXE_ROUTER:=192.168.1.1}"
: "${PXE_SERVER_IP:?Set PXE_SERVER_IP to the LAN IP of this Docker host}"

envsubst < /etc/dnsmasq.d/pxe.conf.template > /etc/dnsmasq.d/pxe.conf

if [ -n "$PXE_INTERFACE" ]; then
  {
    echo "interface=$PXE_INTERFACE"
    echo "bind-dynamic"
  } >> /etc/dnsmasq.d/pxe.conf
fi

exec dnsmasq --no-daemon --conf-file=/etc/dnsmasq.d/pxe.conf --log-facility=-
