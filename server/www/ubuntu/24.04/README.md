# Ubuntu 24.04 installer files

Place the Ubuntu Server ISO and extracted casper boot files here:

- `ubuntu-live-server.iso`
- `casper/vmlinuz`
- `casper/initrd`

The iPXE script at `/boot.ipxe` loads `casper/vmlinuz`, `casper/initrd`, and points Subiquity at this ISO plus `/autoinstall/`.
