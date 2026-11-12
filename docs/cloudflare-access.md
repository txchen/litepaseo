# Protecting LitePaseo with Cloudflare Access

A signed-in LitePaseo session can start agents, approve their permissions and add hosts: it
effectively runs commands on your machines. LitePaseo's own sign-in (access token plus
optional authenticator code) is the last line of defence. When the console is reachable from
the internet through Cloudflare Tunnel, put **Cloudflare Access** in front of it as well, so
anonymous visitors never reach LitePaseo at all.

This guide assumes the tunnel from [HTTPS & remote access](../README.md#https--remote-access)
already serves `https://agents.example.com` from `http://127.0.0.1:8787`.

## What keeps working

| Feature | Behind Access |
| --- | --- |
| Push notifications | Work. The server sends them straight to the browser's push service (Apple, Google, Mozilla); they never pass through your hostname. |
| Live updates (SSE), API, voice input WebSocket | Work. They are same-origin requests and carry the Access cookie. |
| Tapping a notification | Works. If the Access session expired, you sign in to Access first and then land in the conversation. |
| PWA install, icons, service worker updates | Need the bypass rule below. Browsers fetch the manifest without cookies, so Access would block it. |

When the Access session expires while a page is open, API calls fail (they are redirected to
Cloudflare's login page, which a script cannot follow) and the console shows as disconnected.
Reload the page to sign in again. A long session duration keeps this rare.

## 1. Protect the hostname

In the [Cloudflare One dashboard](https://one.dash.cloudflare.com/):

1. Go to **Access → Applications → Add an application → Self-hosted**.
2. **Application name:** `LitePaseo`. **Session duration:** `1 month` (or what you accept).
3. **Public hostname:** `agents.example.com`, path left empty (the whole site).
4. Add a policy:
   - **Action:** Allow
   - **Include:** Emails → your own address (or a login method such as GitHub restricted to
     your account).
5. Identity: the built-in **One-time PIN** (email code) works with no setup. If you enable a
   single identity provider, turn on **Instant Auth** to skip the provider chooser.
6. Save. Leave the cookie settings at their defaults.

## 2. Bypass the public static files

These files contain no data and must load without the Access cookie. Add a **second**
self-hosted application for the same hostname; Access applies the more specific path first.

1. **Access → Applications → Add an application → Self-hosted**, name `LitePaseo static`.
2. Public hostnames, all on `agents.example.com`:
   - path `manifest.webmanifest`
   - path `sw.js`
   - path `icons/*`
3. Policy: **Action: Bypass**, **Include: Everyone**.

Do **not** bypass `/`, `/assets/*` or anything under `/api/`.

## 3. Force HTTPS

In the regular Cloudflare dashboard for your domain, under **SSL/TLS → Edge Certificates**:

- Turn on **Always Use HTTPS**.
- Enable **HSTS** (a max-age of 6 months is a reasonable start).

LitePaseo marks its session cookie `Secure` when Cloudflare reports the visitor used HTTPS,
so a plain `http://` visit can never carry or receive it.

## 4. Check the result

From a machine that is not signed in to Access:

```sh
# The console itself is behind Access: expect 302 to *.cloudflareaccess.com
curl -sI https://agents.example.com/ | grep -iE '^(HTTP|location)'
curl -sI https://agents.example.com/api/health | grep -iE '^(HTTP|location)'

# Static files are reachable: expect 200
curl -s -o /dev/null -w '%{http_code}\n' https://agents.example.com/manifest.webmanifest
curl -s -o /dev/null -w '%{http_code}\n' https://agents.example.com/sw.js
curl -s -o /dev/null -w '%{http_code}\n' https://agents.example.com/icons/icon-192.png
```

Then, in a browser:

1. Open the hostname in a private window: Access asks you to sign in, then LitePaseo asks for
   its token and authenticator code.
2. In developer tools, confirm the `lp_session` cookie is `Secure`, `HttpOnly`,
   `SameSite=Strict`.
3. Install the app, enable notifications in **Settings → Notifications**, and send a test
   notification with the phone locked.

Also check the tunnel's ingress rules: only this hostname should point to
`http://127.0.0.1:8787`, and the final catch-all rule should be `http_status:404`, so no other
local service (such as a Paseo daemon) is published by accident.

## iPhone and iPad home-screen app

An app added to the iOS home screen keeps its cookies apart from Safari, and the Access sign-in
leaves the app's domain. If the installed app keeps returning to the Access login page:

- Install the **Cloudflare One (WARP)** client on the device, enroll it in your Zero Trust
  organization, and change the Access policy to allow your enrolled devices (for example
  **Include: Gateway**, or a device posture check). The app is then admitted without a
  browser sign-in.
- Otherwise, keep using LitePaseo in Safari itself; notifications on iOS require the
  home-screen app, though.

## If something leaks

- Lost or stolen device: revoke it in **Settings → Signed-in devices**, or sign everyone out
  with `litepaseo signout-all`. Also revoke its Access session under
  **My Team → Users** in Cloudflare One.
- Access token exposed: `litepaseo token rotate` (or `litepaseo token set` to choose one).
  The old token stops working at once and every browser is signed out.
- Lost authenticator: `litepaseo totp-reset` on the server, then enrol again.
