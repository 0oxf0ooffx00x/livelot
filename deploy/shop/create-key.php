<?php
// Creates a WooCommerce REST API key (read/write) for LiveLot, owned by user 1, and prints it.
// Run: wp eval-file /tmp/create-key.php
global $wpdb;
$ck = 'ck_' . wc_rand_hash();
$cs = 'cs_' . wc_rand_hash();
$wpdb->delete($wpdb->prefix . 'woocommerce_api_keys', ['description' => 'LiveLot']);
$wpdb->insert($wpdb->prefix . 'woocommerce_api_keys', [
    'user_id'         => 1,
    'description'     => 'LiveLot',
    'permissions'     => 'read_write',
    'consumer_key'    => wc_api_hash($ck),
    'consumer_secret' => $cs,
    'truncated_key'   => substr($ck, -7),
]);
echo "WOO_CONSUMER_KEY={$ck}\nWOO_CONSUMER_SECRET={$cs}\n";
