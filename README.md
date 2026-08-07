# calvin
Calvin's personal website

Calvin's website is cool.
Calvin's website is fun.

## Hosting

Live at <https://calvinpoland.com> (`www` redirects to the apex), served from the
home server: a Cloudflare Tunnel to Caddy, which serves this directory straight
from disk at `~/sites/calvin`.

**There is no build and no deploy step** — Caddy serves the working tree, so
saving a file here makes it live. Pushing to GitHub is for backup and history.

For that to hold through Cloudflare, the zone has a **cache-bypass rule** and
Browser Cache TTL set to "Respect Existing Headers". Without them the edge caches
CSS and images and pins a 4-hour browser cache, so edits would take hours to show
up. That is also why there is no cache-busting `?v=` on the stylesheet.

- **There is no staging.** Editing a file here changes what the public sees, at
  that instant — the site has no separate "draft" copy anywhere. `git push` is
  backup, not publish, so pushing later does not delay anything going live.
- <http://192.168.0.55:8081/> is the same directory on the LAN, useful for
  viewing without the trip out to Cloudflare and back (and it still works if the
  internet is down). It is *not* a preview of unpublished work.
- The site is plain static files: `index.html` (the Slice-N-Dice 3000 canvas game
  is inline), `truck-game.js` (Trailer Trouble 3000 — a software 3D renderer on
  a 2D canvas, no libraries or CDN, so it works offline on the LAN too),
  `styles.css`, and the background image.
- Trailer Trouble's fenced field is deliberately a fake edge of the world.
  Ramming the big striped crate opens a cut that runs under the fence and comes
  back up outside it, in open country of hills and mountains you can drive up
  and jump off. The fence is solid from both sides, so that tunnel is the only
  way through and the field goes on looking like the whole game until somebody
  finds it.
- Server-side config (routing, the Cloudflare tunnel, the cutover notes) lives
  in the `homeserver` repo, in `NOTES.md`.

It was previously on GitHub Pages; that is disabled now, and the `CNAME` file and
the git-hook build-stamp scripts that went with it have been removed.

# License

All content in this repository, including text, images, and code,
is © 2026 Calvin Poland. All rights reserved.

No permission is granted to copy, modify, distribute, or reuse
any part of this work without explicit written consent.
