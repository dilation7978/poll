# Live Poll

A small self-hosted alternative to Poll Everywhere. You put a question on a slide, the audience scans a QR code, answers on their phones, and the results update live on screen.

- **Multiple-choice** questions show live bar charts. Each phone gets one vote and can change it.
- **Open-text** questions show a word cloud, where repeated answers get bigger. Each phone can send up to 3 answers.
- No accounts or apps for the audience. Answering only needs a phone browser.

## Contents

1. [The three pages](#the-three-pages)
2. [Running a poll](#running-a-poll)
3. [How results are displayed](#how-results-are-displayed)
4. [Display link options (dark mode, colours, hiding the QR code)](#display-link-options)
5. [Using it in PowerPoint](#using-it-in-powerpoint)
6. [Using it in LibreOffice Impress](#using-it-in-libreoffice-impress)
7. [Install on a Synology NAS](#install-on-a-synology-nas)
8. [Making it reachable from audience phones](#making-it-reachable-from-audience-phones)
9. [Managing it over SSH](#managing-it-over-ssh)
10. [Troubleshooting](#troubleshooting)
11. [Capacity and limits](#capacity-and-limits)

---

## The three pages

| Page | URL | Who uses it |
|---|---|---|
| Vote | `/` | The audience, through the QR code |
| Admin | `/admin` | You: create questions, go live, reset, and copy slide links |
| Display | `/display/<id>` | The screen or slide: question, live results and QR code |

There is **one live question at a time**. Phones always open `/` and see whichever question is live. When a new question goes live, everyone's phone switches to it on its own, without rescanning.

## Running a poll

1. Open `https://poll.example.com/admin` and sign in with the admin key (the `ADMIN_KEY` in `docker-compose.yml`).
2. Add a question. Choose **Multiple choice** (2 to 10 options, one per line) or **Open text**.
3. Each question card has these buttons:
   - **Make live / Stop voting:** opens or closes voting for this question.
   - **Present:** opens the display in a new tab and makes the question live.
   - **Copy slide link:** a display link that **makes the question live when it's shown**. Use this on your slides.
   - **Copy view-only link:** a display link that only shows results and never changes which question is live.
   - **Edit**, **Reset results** and **Delete.** Changing a question's type clears its responses.
4. **Stop all voting** closes every question. Phones then show "Waiting for the next question…".

**Before a talk:** do a test run with your own phone, then press **Reset results** on each question so the test votes don't show.

**Backup plan:** keep `/admin` open on your phone. From there you can make questions live, stop voting or reset results during the talk.

## How results are displayed

The display page scales to fit any window or slide area.

- **Left side:** the question in large text, with the live results below it.
- **Right side:** the QR code, "Scan to answer", the short address, a response count, and a "Voting closed" label when the question isn't live.

**Multiple choice**
- Each option has a horizontal bar labelled with the count and percentage, for example `12 · 40%`.
- The leading option is in full colour, and the others are lighter.
- When someone changes their vote, the bars adjust. Each phone counts once.
- With more than 5 options, the bars get thinner so everything fits.

**Open text**
- Answers form a word cloud in mixed colours.
- Identical answers are grouped (ignoring capitals and spacing), and the more people send one, the bigger it gets.
- Words keep their positions as new ones arrive, so the cloud doesn't jump around.
- Before the first answer arrives, it shows "Responses will appear here".

**On the audience's phones**, the live question has large tap targets. After voting, they see "Vote received" and can tap again to change their answer. For open text, they can send up to 3 answers of up to 100 characters each.

Results reach the screen within about 0.2 seconds of a vote.

## Display link options

Add these to the end of a slide link or view-only link:

| Option | Effect |
|---|---|
| `theme=dark` | Dark background, to match dark slide designs |
| `accent=e11d48` | Colour of the bars (a hex value without the `#`) |
| `qr=0` | Hides the QR panel, for example on a later "here's what you said" slide |

A **slide link** already contains `?key=...`, so join options with `&`:

```
https://poll.example.com/display/<id>?key=...&theme=dark&accent=e11d48
```

A **view-only link** has no `?` yet, so start with `?`:

```
https://poll.example.com/display/<id>?theme=dark&qr=0
```

**Tip:** use a view-only link with `qr=0` on a slide that shows results again later, so revisiting it doesn't reopen voting.

## Using it in PowerPoint

**Option 1: live inside the slide (Microsoft 365 PowerPoint, Windows or Mac)**

1. Go to **Insert → Get Add-ins**, search for **"Web Viewer"** (free, by Microsoft) and add it.
2. Paste the **slide link** for your question. It must start with `https://`.
3. Resize the Web Viewer box to fill the slide.
4. In Slide Show, the poll runs live. Arriving on the slide makes that question live on everyone's phones.

Make one slide per question. Test the deck once before the talk, because add-ins can take a second or two to load.

**Option 2: a browser window (works with any presentation software)**

Open the slide link in a browser, press F11 for full screen, and switch to it with Alt+Tab when you reach the poll.

## Using it in LibreOffice Impress

Impress can't show a live web page inside a slide. Use a browser window alongside it instead.

**Hyperlink on the slide (smoothest)**

1. On the poll slide, select some text or a shape, such as "Show live results".
2. Choose **Insert → Hyperlink** (Ctrl+K), pick **Internet**, and paste the question's **slide link**.
3. During the slideshow, click the link. The browser opens the live results and the question goes live. Press F11 for full screen, and use Alt+Tab to get back to Impress.

**Or keep browser tabs ready:** before the talk, open each question's slide link in its own tab. When you reach a poll slide, Alt+Tab to the browser and select that tab.

**Put the QR code on your slides.** The QR code is the same for every question, because phones always open `poll.example.com` and see whichever question is live. Save `https://poll.example.com/api/qr.svg` from your browser, then use **Insert → Image**. SVG stays sharp at any size. The same image works in PowerPoint or on printed handouts. If a slide shows only the QR image, make the question live from `/admin`.

## Install on a Synology NAS

These steps use DSM 7.2+ with Container Manager.

1. Install **Container Manager** from Package Center.
2. In File Station, create a folder such as `docker/poll`. Upload `server.js`, `package.json`, `Dockerfile`, `docker-compose.yml` and the `public` folder into it. `.dockerignore` and `README.md` are optional.
3. Inside that folder, create an empty folder called **`data`**. Synology's Docker won't create it automatically, and the container won't start without it.
4. Edit `docker-compose.yml`:
   - `ADMIN_KEY`: your admin password.
   - `PUBLIC_URL`: the address phones should open, for example `https://poll.example.com`. This is the address the QR code uses.
   - `ports`: the format is `"NAS port:container port"`. **Only change the first number.** The app always listens on 3000 inside the container. The default `"3300:3000"` avoids port 3000, which is often taken on a NAS.
5. Start it over SSH (see [Managing it over SSH](#managing-it-over-ssh)), or in Container Manager go to **Project → Create**, choose the folder, and use the existing `docker-compose.yml`.
6. Open `http://<nas-ip>:3300/admin` and sign in.

Polls and responses are saved in `data/polls.json` inside the project folder. They survive restarts and rebuilds.

## Making it reachable from audience phones

Phones have to be able to reach the NAS.

**A. Same Wi-Fi only (quick test).** Set `PUBLIC_URL=http://<nas-ip>:3300`. This only works for phones on the same network as the NAS. It won't work at outside venues or on mobile data, and PowerPoint's Web Viewer won't load plain `http` pages.

**B. Public HTTPS address (recommended).**

1. Point the domain (`poll.example.com`) at your public IP in your DNS settings. A Synology DDNS name such as `yourname.synology.me` also works.
2. **Control Panel → Security → Certificate:** add a Let's Encrypt certificate for the domain.
3. **Control Panel → Login Portal → Advanced → Reverse Proxy:** create a rule with
   - Source: HTTPS, hostname `poll.example.com`, port 443
   - Destination: HTTP, `localhost`, port **3300** (the NAS port, not 3000)
4. On your router, forward port 443 to the NAS. Also forward port 80, which Let's Encrypt needs to renew the certificate.
5. Set `PUBLIC_URL=https://poll.example.com` in `docker-compose.yml`, then run `sudo docker compose up -d`.
6. Always use `https://poll.example.com/admin`, so the links you copy are HTTPS links.

## Managing it over SSH

Run these from the project folder:

```sh
cd /volume2/docker/poll
```

| Task | Command |
|---|---|
| Start, or rebuild after changing `server.js` or `public/` | `sudo docker compose up -d --build` |
| Apply changes to `docker-compose.yml` | `sudo docker compose up -d` |
| Stop (keeps your polls) | `sudo docker compose down` |
| Status, with ports | `sudo docker ps -a --filter name=live-poll` |
| View logs | `sudo docker logs live-poll` |
| Check that the app answers | `curl http://localhost:3300/healthz` (should print `{"ok":true}`) |

On older DSM versions, use `docker-compose` (with a hyphen) instead of `docker compose`. The container is named `live-poll` (set by `container_name`). It restarts on its own after a NAS reboot.

A project started over SSH appears under **Container** in Container Manager, but not under **Project**.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Status is `Created`, not `Up` | It failed to start. Run `sudo docker start live-poll` to see the error. |
| `Bind mount failed: '.../data' does not exist` | Create the folder with `mkdir -p /volume2/docker/poll/data`, then run `sudo docker start live-poll`. |
| `port is already allocated` | Another program is using the NAS port. Change the first number in `ports`, and update the reverse proxy to match. |
| The domain says "not found" | Check that the reverse proxy destination is `localhost:3300`. If it's `3000`, it reaches another program. |
| A page showing only `{"error":"Not found"}` | The app is answering, but the path is wrong. Use `/admin`, `/`, or a `/display/...` link. |
| A Synology-styled "page not found" page | The reverse proxy rule isn't matching. Check the hostname spelling, and that you're using `https://`. |
| `docker compose logs` prints nothing | The container wasn't started from this folder. Use `sudo docker logs live-poll`. |
| The QR code shows the wrong address | Set `PUBLIC_URL`, then run `sudo docker compose up -d`. |

## Capacity and limits

- **Audience size:** 200 to 300 simultaneous voters is easy. Each phone keeps one small connection open, and the screen redraws at most 5 times a second however fast votes arrive.
- **Word cloud:** it shows at most the **60 most common** distinct answers. When there are many one-off answers, the earliest fill the cloud. Every response is still saved in `data/polls.json`.
- **Venue Wi-Fi** is usually the weak point, not the server. Because the poll is public, tell people "use mobile data if the Wi-Fi is slow".
- **One vote per phone** is enforced per browser. A private browser tab counts as a new voter. That's fine for audience polling, but don't use it for anything that needs to be fraud-proof.
- **Security:** slide links contain the admin key. Don't share decks containing them publicly. If you do, change `ADMIN_KEY` and run `sudo docker compose up -d`.

## Running without Docker

You need Node.js 18 or newer:

```
npm install
ADMIN_KEY=secret PUBLIC_URL=http://192.168.1.50:3000 PORT=3000 node server.js
```
