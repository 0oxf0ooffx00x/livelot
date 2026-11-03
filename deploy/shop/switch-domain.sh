#!/usr/bin/env bash
# Runs ON the VM: move the store to a new hostname (DNS must already point here, proxy off).
# Usage: sudo bash switch-domain.sh shop.livelot.stream
set -euo pipefail
NEW="$1"
cd /opt/livelot-shop
OLD=$(grep '^SHOP_HOST=' .env | cut -d= -f2-)
[ "$OLD" = "$NEW" ] && { echo "already on $NEW"; exit 0; }
sed -i "s|^SHOP_HOST=.*|SHOP_HOST=${NEW}|" .env
docker-compose up -d caddy
docker-compose run --rm -T cli wp search-replace "https://${OLD}" "https://${NEW}" --all-tables --skip-columns=guid
docker-compose run --rm -T cli wp cache flush || true
docker-compose run --rm -T cli wp option get home
