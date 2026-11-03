<?php
/**
 * Plugin Name: LiveLot helper (mu-plugin)
 * Description: Lets live-show buyers pay a pending order without logging in or retyping their email, and pings LiveLot the moment an order is paid.
 * Install: copy to wp-content/mu-plugins/livelot-helper.php and add to wp-config.php:
 *   define('LIVELOT_URL', 'https://your-livelot-tunnel.example');
 *   define('LIVELOT_SECRET', 'same value as LIVELOT_PING_SECRET in LiveLot .env');
 */

if (!defined('ABSPATH')) exit;

/** Is this a LiveLot order? (created through the REST API by LiveLot) */
function livelot_is_order($order) {
    return $order && ($order->get_created_via() === 'livelot' || $order->get_meta('_livelot_show'));
}

/**
 * Guest order-pay: WooCommerce 8+/9+ asks guests to confirm their billing email before paying an
 * order they didn't create in this browser. LiveLot orders have no email yet (the buyer adds it at
 * checkout), so skip that check for LiveLot orders only. The order key in the URL is still required.
 */
add_filter('woocommerce_order_email_verification_required', function ($required, $order) {
    return livelot_is_order($order) ? false : $required;
}, 10, 2);

/** Let a guest pay a LiveLot order even if the order has a customer id attached. */
add_filter('user_has_cap', function ($allcaps, $caps, $args) {
    if (isset($caps[0]) && $caps[0] === 'pay_for_order' && !empty($args[2])) {
        $order = wc_get_order((int) $args[2]);
        if (livelot_is_order($order) && isset($_GET['key']) && hash_equals($order->get_order_key(), wc_clean(wp_unslash($_GET['key'])))) {
            $allcaps['pay_for_order'] = true;
        }
    }
    return $allcaps;
}, 10, 3);

/** Tell LiveLot as soon as an order is paid, so the dashboard and overlay update instantly. */
function livelot_ping_paid($order_id) {
    if (!defined('LIVELOT_URL') || !defined('LIVELOT_SECRET')) return;
    $order = wc_get_order($order_id);
    if (!livelot_is_order($order)) return;
    wp_remote_post(rtrim(LIVELOT_URL, '/') . '/api/woo/paid', [
        // Blocking with a short timeout: non-blocking requests can be dropped before they're sent.
        // Runs inside the payment request/webhook, so a slow LiveLot adds at most 5 s; the 15 s poll is the backstop.
        'timeout'  => 5,
        'blocking' => true,
        'headers'  => ['Content-Type' => 'application/json', 'X-LiveLot-Secret' => LIVELOT_SECRET],
        'body'     => wp_json_encode(['order_id' => $order_id, 'status' => $order->get_status()]),
    ]);
}
add_action('woocommerce_order_status_processing', 'livelot_ping_paid');
add_action('woocommerce_order_status_completed', 'livelot_ping_paid');
add_action('woocommerce_payment_complete', 'livelot_ping_paid');

/** Show the lot number on order lines in the admin and emails. */
add_filter('woocommerce_order_item_display_meta_key', function ($key) {
    return $key === '_livelot_claim' ? 'LiveLot claim' : $key;
});
