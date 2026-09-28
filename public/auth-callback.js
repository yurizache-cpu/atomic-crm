// The auth callback page's redirect (public/auth-callback.html), kept out of
// the page so that no inline script is needed: Production Security Gate A's
// Content-Security-Policy admits same-origin script files only. Its behaviour
// is the inline script's, unchanged: the tokens move from this page's fragment
// to the application's #/auth-callback route, and never into a request.

const getUrlParams = () => {
  const urlSearchParams = new URLSearchParams(window.location.hash.substring(1));
  const access_token = urlSearchParams.get("access_token");
  const refresh_token = urlSearchParams.get("refresh_token");
  const type = urlSearchParams.get("type");

  return { access_token, refresh_token, type };
};

function interceptAuthCallback() {
  const { access_token, refresh_token, type } = getUrlParams();
  window.location.href = `./#/auth-callback?access_token=${access_token}&refresh_token=${refresh_token}&type=${type}`;
}

interceptAuthCallback();
