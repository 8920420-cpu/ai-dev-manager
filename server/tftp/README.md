# TFTP boot files

Place iPXE binaries here before starting `dnsmasq`:

- `undionly.kpxe` for legacy BIOS clients.
- `ipxe.efi` for UEFI x86/x86_64 clients.
- `ipxe-arm64.efi` for ARM64 UEFI clients, if needed.

These binaries are intentionally not committed. Build or download them from the iPXE project, then keep them in this directory on the deployment host.
