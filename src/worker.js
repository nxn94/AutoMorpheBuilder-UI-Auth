// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare Worker: GitHub App OAuth callback handler.
//
// Flow is authorization-code-with-PKCE for SPAs:
//   1. UI generates a random `state` and `code_verifier`/`code_challenge`.
//   2. UI opens https://github.com/login/oauth/authorize in a popup window.
//   3. User authorizes, GitHub redirects to this worker's /callback with `code`.
//   4. Worker exchanges code + code_verifier for an access token (using the
//      App's client secret — never exposed to the browser).
//   5. Worker redirects to /done which posts the token back to the opener
//      window via `window.opener.postMessage(...)` and closes the popup.
// ─────────────────────────────────────────────────────────────────────────────

// Configured via `wrangler secret put` and `wrangler.jsonc` vars.
// GITHUB_APP_CLIENT_ID: GitHub App's Client ID (public, used in the redirect URL).
// GITHUB_APP_CLIENT_SECRET: GitHub App's client secret (secret, used in token exchange).
// ALLOWED_ORIGIN: origin allowed to receive the postMessage (the UI Pages URL).
// APP_SLUG: GitHub App slug — used to construct the App install URL in /install.

const TEXT_HTML = { 'content-type': 'text/html; charset=utf-8' };
const TEXT_PLAIN = { 'content-type': 'text/plain; charset=utf-8' };
const JSON_HDR  = { 'content-type': 'application/json; charset=utf-8' };

function html(body) {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>AutoMorpheBuilder UI</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:480px;margin:3rem auto;padding:1rem;color:#1f2328;background:#fafbfc;border:1px solid #d0d7de;border-radius:6px}h1{margin-top:0;font-size:1.2rem}p{color:#57606a}code{background:#eff1f3;padding:0.1em 0.3em;border-radius:3px;font-size:0.9em}a{color:#0969da}</style>
</head><body>${body}<script>setTimeout(function(){window.close()},2500);</script></body></html>`, { headers: TEXT_HTML });
}

function errorPage(msg) {
  return html(`<h1>Sign-in failed</h1><p>${msg}</p><p>This window will close in a few seconds. <a href="javascript" onclick="window.close()">Close now</a>.</p>`);
}

function okPage() {
  return html(`<h1>Signed in</h1><p>You can close this window and return to the app.</p>`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ─── CORS preflight for any same-origin POSTs we may add later ─────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    // ─── /callback — GitHub redirects here after user authorizes ───────
    if (path === '/callback') {
      const code  = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const err   = url.searchParams.get('error');
      const errDesc = url.searchParams.get('error_description');

      if (err) {
        return errorPage(`GitHub returned an error: <code>${escapeHtml(err)}</code>${errDesc ? ' &mdash; ' + escapeHtml(errDesc) : ''}`);
      }
      if (!code) {
        return errorPage('No authorization code in the redirect.');
      }

      // The state (and code_verifier) was passed through to GitHub via the
      // `state` parameter, which is echoed back unchanged. UI uses this to
      // verify the callback belongs to the same flow. We forward it through
      // to /done so the opener can verify it.
      const redirectTo = new URL('/done', url.origin);
      redirectTo.searchParams.set('code',  code);
      redirectTo.searchParams.set('state', state || '');
      return Response.redirect(redirectTo.toString(), 302);
    }

    // ─── /token — exchange the code for an access token ────────────────
    // Called by the popup's /done page; needs CORS so the opener can also
    // call it directly if needed. In practice /done does the exchange and
    // posts the token back; this endpoint exists as a fallback for SPAs
    // that want to skip the /done page (not used by the current UI).
    if (path === '/token' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body || !body.code || !body.code_verifier) {
        return json({ error: 'invalid_request' }, 400, env);
      }
      const result = await exchangeCode(env, body.code, body.code_verifier);
      return new Response(stringifyJson(result.body), { status: result.status, headers: jsonHeaders(env) });
    }

    // ─── /done — popup page that does the token exchange and posts back ─
    if (path === '/done') {
      const code  = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const errParam = url.searchParams.get('error');

      // We render an HTML page that the opener's window listens to via
      // postMessage. The page immediately fetches /token with the code
      // and code_verifier it pulls from sessionStorage (set by the opener
      // before opening the popup), then posts the token back.
      return new Response(DONE_PAGE, { headers: { ...TEXT_HTML, ...corsHeaders(env) } });
    }

    // ─── /install — convenience: redirect to the GitHub App install URL
    if (path === '/install') {
      const slug = env.APP_SLUG;
      if (!slug) return new Response('APP_SLUG not configured', { status: 503, headers: TEXT_PLAIN });
      return Response.redirect(`https://github.com/apps/${slug}/installations/new`, 302);
    }

    // ─── /client-id — the UI fetches this to build the authorize URL ───
    if (path === '/client-id') {
      const cid = env.GITHUB_APP_CLIENT_ID;
      if (!cid) return new Response('GITHUB_APP_CLIENT_ID not configured', { status: 503, headers: TEXT_PLAIN });
      return new Response(stringifyJson({ client_id: cid }), { status: 200, headers: jsonHeaders(env) });
    }

    // ─── /healthz ──────────────────────────────────────────────────────
    if (path === '/healthz') return new Response('ok', { headers: TEXT_PLAIN });

    return new Response('not found', { status: 404, headers: TEXT_PLAIN });
  },
};

async function exchangeCode(env, code, codeVerifier) {
  const r = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({
      client_id:     env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      code,
      code_verifier: codeVerifier,
    }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

function corsHeaders(env) {
  return {
    'access-control-allow-origin':  env.ALLOWED_ORIGIN || '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age':       '86400',
  };
}

function jsonHeaders(env) {
  return { ...JSON_HDR, ...corsHeaders(env) };
}

function stringifyJson(obj) {
  return JSON.stringify(obj);
}

function json(obj, status, env) {
  return new Response(stringifyJson(obj), { status, headers: jsonHeaders(env) });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// The popup landing page that exchanges the code and posts the token back.
// We can't access localStorage/sessionStorage from this origin (different
// origin from the UI Pages site). The opener sets the code_verifier on
// window.name before opening the popup — so we read it from there.
const DONE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Signing in…</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:480px;margin:3rem auto;padding:1rem;color:#1f2328;background:#fafbfc;border:1px solid #d0d7de;border-radius:6px}h1{margin-top:0;font-size:1.2rem}p{color:#57606a}code{background:#eff1f3;padding:0.1em 0.3em;border-radius:3px;font-size:0.9em}</style>
</head><body>
<h1 id="status">Signing you in…</h1>
<p id="detail">Exchanging the authorization code for an access token.</p>
<script>
(async function () {
  var status = document.getElementById('status');
  var detail = document.getElementById('detail');
  function setStatus(s, d) { if (status) status.textContent = s; if (detail) detail.innerHTML = d; }

  try {
    var params = new URLSearchParams(location.search);
    var code   = params.get('code');
    var state  = params.get('state') || '';
    if (!code) { setStatus('Sign-in failed', 'No authorization code.'); return; }

    // code_verifier was passed via window.name by the opener. window.name
    // survives the cross-origin redirect because it's not subject to the
    // same-origin policy on read.
    var codeVerifier = '';
    try { codeVerifier = window.name || ''; } catch (e) {}

    var resp = await fetch('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code, code_verifier: codeVerifier }),
    });
    var data = await resp.json().catch(function () { return {}; });
    if (!resp.ok || data.error) {
      setStatus('Sign-in failed', '<code>' + (data.error || ('HTTP ' + resp.status)) + '</code> &mdash; ' + (data.error_description || 'see the GitHub OAuth docs.'));
      return;
    }

    // Post the token back to the opener window and close.
    if (window.opener) {
      try {
        window.opener.postMessage({ type: 'amb-ui-oauth', state: state, token: data.access_token, scope: data.scope }, '*');
      } catch (e) { /* opener may be gone */ }
    }
    setStatus('Signed in', 'You can close this window.');
    setTimeout(function () { window.close(); }, 800);
  } catch (e) {
    setStatus('Sign-in failed', '<code>' + String(e && e.message || e) + '</code>');
  }
})();
</script>
</body></html>`;