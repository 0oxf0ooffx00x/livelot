#!/usr/bin/env bash
# Runs ON the VM (as root) from /opt/livelot-shop. Idempotent: safe to run again.
set -euo pipefail
cd /opt/livelot-shop
# Read KEY=value lines literally (values may contain spaces; docker-compose reads the same file)
while IFS='=' read -r k v; do [[ -z "$k" || "$k" == \#* ]] && continue; export "$k=$v"; done < .env

if ! command -v docker-compose >/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose >/dev/null
  systemctl enable --now docker
fi

docker-compose up -d db wordpress caddy
wp() { docker-compose run --rm -T cli wp "$@"; }

echo "Waiting for WordPress files and database..."
for i in $(seq 1 60); do
  if wp db check >/dev/null 2>&1; then break; fi
  sleep 5
done

if ! wp core is-installed >/dev/null 2>&1; then
  wp core install --url="https://${SHOP_HOST}" --title="${SHOP_NAME}" \
    --admin_user="${WP_ADMIN_USER}" --admin_password="${WP_ADMIN_PASSWORD}" \
    --admin_email="${WP_ADMIN_EMAIL}" --skip-email
fi
wp option update blog_public 0
wp rewrite structure '/%postname%/' --hard

wp plugin is-installed woocommerce || wp plugin install woocommerce
wp plugin activate woocommerce
wp plugin is-installed woocommerce-gateway-stripe || wp plugin install woocommerce-gateway-stripe

# Store settings LiveLot relies on
wp option update woocommerce_currency GBP
wp option update woocommerce_default_country 'GB'
wp option update woocommerce_enable_guest_checkout yes
wp option update woocommerce_enable_checkout_login_reminder no
wp option update woocommerce_coming_soon no
wp option update woocommerce_store_pages_only no
wp option update woocommerce_manage_stock yes
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
# Test payment method until Stripe test keys are added (orders go on-hold, which LiveLot counts as paid)
wp option update woocommerce_cheque_settings '{"enabled":"yes","title":"Test payment","description":"Demo store: places the order without taking money.","instructions":"Test order, nothing to pay."}' --format=json

if [ ! -f .woo-keys ]; then
  wp eval-file /tmp/create-key.php > .woo-keys
  chmod 600 .woo-keys
fi
echo "--- done"
wp option get siteurl
