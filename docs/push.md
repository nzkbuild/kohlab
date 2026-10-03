# Push notifications

Kohlab can tell your phone that an agent finished, even with the browser closed.

## Turn it on (iPhone)

iPhone only delivers web push to a site added to the Home Screen, and only over HTTPS
(your Tailscale or reverse-proxy address is fine).

1. Open Kohlab in Safari, tap **Share**, then **Add to Home Screen**.
2. Open Kohlab from the new icon (not from Safari).
3. **Settings → Notifications → Turn on push**, and allow notifications.
4. Tap **Send a test**. It should arrive within a few seconds.

On Android and desktop Chrome, skip steps 1 and 2.

## What is sent

One notification per finished workspace, titled "ready for review", with the task as the
text. Tapping it opens that workspace. The message is encrypted for your device
(RFC 8291); the push service (Apple or Google) sees that something was sent, not what.

A team member only hears about their own workspaces. Owners hear about all of them.

## Where it lives

`vapid.json` (the server's push key) and `push.json` (subscribed devices) in the state
directory, both `0600` and both in `kohlab backup`. Turn push off on a device from the same
settings page; a device the push service reports as gone is dropped automatically.
