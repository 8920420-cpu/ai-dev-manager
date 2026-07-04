#!/bin/sh
# Собирает загрузочный носитель iPXE со встроенным скриптом, который сразу
# тянет boot.ipxe по HTTP — DHCP/TFTP-часть PXE не нужна. Это ОСНОВНОЙ способ
# загрузки чистых серверов, когда PXE-хост — Windows (Docker Desktop/WSL2 не
# пропускает DHCP-broadcast из физической LAN до dnsmasq).
#
# Использование (Git Bash, из корня репозитория):
#   PXE_SERVER_IP=192.168.2.200 PXE_HTTP_PORT=8087 OUT_DIR="K:/Роботы/Golang/git/server/boot-media" \
#     sh server/scripts/build-ipxe-media.sh
#
# Результат в OUT_DIR:
#   ipxe.iso  — BIOS/legacy: записать на CD или флешку (Rufus, режим DD)
#   ipxe.efi  — UEFI: положить на FAT32-флешку как EFI/BOOT/BOOTX64.EFI
set -eu

: "${PXE_SERVER_IP:?Set PXE_SERVER_IP}"
: "${PXE_HTTP_PORT:=8088}"
: "${OUT_DIR:?Set OUT_DIR (куда положить ipxe.iso/ipxe.efi)}"

mkdir -p "$OUT_DIR"

docker run --rm -v "$OUT_DIR":/out debian:bookworm-slim sh -c "
  set -eu
  apt-get update -qq
  apt-get install -y -qq git make gcc binutils perl liblzma-dev mtools genisoimage >/dev/null
  git clone -q --depth 1 https://github.com/ipxe/ipxe /ipxe
  cd /ipxe/src
  printf '#!ipxe\ndhcp\nchain http://$PXE_SERVER_IP:$PXE_HTTP_PORT/boot.ipxe\n' > embed.ipxe
  make -j\$(nproc) bin/ipxe.iso bin-x86_64-efi/ipxe.efi EMBED=embed.ipxe >/dev/null
  cp bin/ipxe.iso bin-x86_64-efi/ipxe.efi /out/
  echo 'built: ipxe.iso (BIOS), ipxe.efi (UEFI -> EFI/BOOT/BOOTX64.EFI)'
"
