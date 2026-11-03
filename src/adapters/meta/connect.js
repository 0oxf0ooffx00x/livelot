// "Connect" in Settings: turn the short-lived user token from Graph API Explorer into what LiveLot
// needs. The user token is exchanged for a long-lived one, and a Page token fetched with a long-lived
// user token doesn't expire. The user token itself is never stored.

export const PAGE_PERMISSIONS = ['pages_show_list', 'pages_read_engagement', 'pages_read_user_content', 'pages_manage_posts', 'pages_manage_engagement', 'pages_manage_metadata', 'pages_messaging'];
export const IG_PERMISSIONS = ['instagram_basic', 'instagram_manage_comments', 'instagram_manage_messages', 'instagram_content_publish'];

export async function connectWithUserToken({ appId, appSecret, userToken, pageId = null, version = 'v24.0', fetchImpl = fetch }) {
  const base = `https://graph.facebook.com/${version}`;
  const get = async (p, params) => {
    const u = new URL(base + p);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const res = await fetchImpl(u);
    const j = await res.json().catch(() => ({}));
    if (j.error) throw new Error(plainGraphError(j.error));
    if (!res.ok) throw new Error(`Facebook answered ${res.status}`);
    return j;
  };
  const { access_token: longUser } = await get('/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: userToken });
  const perms = await get('/me/permissions', { access_token: longUser });
  const granted = new Set((perms.data || []).filter((p) => p.status === 'granted').map((p) => p.permission));
  const accounts = await get('/me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '100', access_token: longUser });
  const pages = accounts.data || [];
  const missing = PAGE_PERMISSIONS.filter((p) => !granted.has(p));
  if (!pages.length) {
    throw new Error('No Facebook Page came with this token. In Graph API Explorer press Generate Access Token again and tick your Page in the Facebook window. If the Page belongs to a business portfolio, add the business_management permission too.');
  }
  const page = pageId ? pages.find((p) => p.id === String(pageId)) : pages.length === 1 ? pages[0] : null;
  if (!page) {
    return { choose: pages.map((p) => ({ id: p.id, name: p.name, instagram: p.instagram_business_account?.username || null })), missing };
  }
  const ig = page.instagram_business_account || null;
  return {
    page: { id: page.id, name: page.name },
    pageToken: page.access_token,
    instagram: ig ? { id: ig.id, username: ig.username || null } : null,
    missing,
    igMissing: ig ? IG_PERMISSIONS.filter((p) => !granted.has(p)) : [],
    canGoLive: granted.has('publish_video'),
  };
}

function plainGraphError(e) {
  const m = `${e.message || ''}`;
  if (/validating application|app_id|client_id|Invalid Client|client secret/i.test(m) || e.code === 101) {
    return 'The App ID or App secret is wrong, or the token was made for a different app. In Graph API Explorer, pick your LiveLot app in the Meta App box at the top right, then make a new token.';
  }
  if (e.code === 190 || /expired|Session has expired|Invalid OAuth/i.test(m)) return 'This token has expired or isn’t valid. Make a new one in Graph API Explorer and paste it straight away.';
  return `Facebook said: ${m}${e.code ? ` (#${e.code})` : ''}`;
}
