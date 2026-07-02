# Server PXE Subsystem

The Server subsystem lives in `server/docker-compose.yml` and contains:

- `albia`: existing Albia container.
- `dnsmasq`: DHCP, PXE and TFTP.
- `nginx`: HTTP server for iPXE, Ubuntu ISO files and autoinstall seed.
- `netbootxyz`: optional profile for netboot.xyz.

## Configure

Set these values in `.env` or in the shell before running compose:

```env
PXE_SERVER_IP=192.168.1.10
PXE_ROUTER=192.168.1.1
PXE_DNS=192.168.1.1
PXE_DHCP_RANGE=192.168.1.200,192.168.1.240,12h
PXE_HTTP_PORT=8088
PXE_INTERFACE=
ALBIA_IMAGE=localhost:5000/albia:latest
SERVER_DATA_ROOT=K:\Роботы\Golang\git\server
```

`dnsmasq` uses host networking because DHCP broadcast traffic must reach the physical LAN. Run it only on the intended provisioning network and make sure there is no competing DHCP server on that segment.

## Prepare Assets

Add iPXE binaries to `$SERVER_DATA_ROOT/tftp/`:

- `undionly.kpxe`
- `ipxe.efi`
- `ipxe-arm64.efi` if ARM64 is required

Add Ubuntu installer files to `$SERVER_DATA_ROOT/www/ubuntu/24.04/`:

- `ubuntu-live-server.iso`
- `casper/vmlinuz`
- `casper/initrd`

Edit `server/www/autoinstall/user-data` before production:

- replace the password hash,
- replace `authorized-keys`,
- replace `REPLACE_WITH_PXE_SERVER_IP`,
- review `server/www/scripts/firstboot.sh` if the Albia registration payload needs more fields.

The current Albia wrapper exposes registration on `http://$PXE_SERVER_IP:8090/cgi-bin/register`.
Registered nodes are appended to `$SERVER_DATA_ROOT/albia/registry/nodes.jsonl`.

## Run

```powershell
docker compose --env-file .env -f server/docker-compose.yml up -d nginx dnsmasq albia
```

Optional netboot.xyz:

```powershell
docker compose --env-file .env -f server/docker-compose.yml --profile netbootxyz up -d netbootxyz
```

After that, boot a clean server from PXE. The flow is:

1. DHCP reply from `dnsmasq`.
2. TFTP download of iPXE.
3. HTTP boot from `nginx` using `/boot.ipxe`.
4. Ubuntu autoinstall from `/autoinstall/`.
5. First boot runs `albia-firstboot`, then control can be handed to Albia.
