## Server Data Diagram (so far)

<img width="800" alt="server-state(2)" src="https://github.com/user-attachments/assets/a7199004-6368-44bd-af75-0020464bc4e0" />


## Server and Clients/Views

The server holds all game state. After every change, it sends each client a view of that state.

Clients only render the latest view and keep no game state of their own.
This means a refreshed phone, reconnecting player, or host who opens the page late gets the current screen right away, as long as the server is still running.

Game state is persisted in **MongoDB**, which runs in a Docker container.
During development the game runs normally with hot reload, while only the database needs to run in Docker.

### Ranking controls

Tap an available answer to add it to the ranking. Placed answers leave the stash;
removing them from the ranking returns them to the available answers.
Available answers have grey
selection circles and no drag grips. Once placed, answers gain filled colored
number circles and three-line drag grips. Drag anywhere on a ranked card to
insert it at another position (hold briefly first on touch screens). You can also
drag available answers into any ranking position, or return ranked answers by
dropping them in Answers. That area stays visible even when all answers are placed;
drops elsewhere leave the draft unchanged. Tap a ranked answer to
return it to the available answers, replacing Undo and tap-to-swap. All answers
must be placed before submitting.

Quick swipes scroll the page; holding a ranked card for 220 ms lifts it for dragging.
Long rankings auto-scroll near the screen edges. Outside drops and cancelled
gestures leave the order unchanged, and dropping does not play a swap animation.
Keyboard users can press Enter/Space on answers to add/remove them, and use
Up/Down or Home/End on a placed grip to reorder. Escape cancels a drag.


### Game persistence / DB

The active game stays in memory and is saved to MongoDB after important state changes:

- Starting a round
- Submitting an answer or ranking
- Calculating scores and transitioning to results
- Starting the next round

Database logic is in `server/database/`:

- `db.ts`: MongoDB connection and shutdown
- `gameRepository.ts`: `saveGame(game)` and `getGame(id)`

Games are stored in `wordgame.games`, using the game ID as MongoDB's `_id`.

`saveGame(game)` creates or updates a game. `getGame(id)` restores a `Game` instance, including its `Map` objects.

Stored collections use objects with named fields; the game uses Maps in memory.

| Stored field | Entry shape / meaning |
| --- | --- |
| `state.players` | `{ playerId, name, joinedAt }` |
| `state.rounds` | `{ roundNumber, ...roundData }` |
| Round `wordsAvailable` | `{ playerId, words }`: assigned words |
| Round `answers` | `{ answerId, playerId, words, receivedAt }`: submitted answer |
| Round `rankings` | `{ playerId, answerIds, receivedAt }`: voter and answers ordered best first |
| Round `scores` | `{ answerId, score }`: points for an answer |
| `state.totals` | `{ playerId, score }`: accumulated points for a player |

`playerId` links to `state.players[].playerId`; `answerId` and `answerIds` link to that round's `answers[].answerId`.
Ranking `answerIds` are ordered best first, worst last: index 0 is rank 1.
With N ranked answers, the first receives N points, the second N−1, and the last 1 from that voter.
Player IDs remain stable across rooms and games while the browser keeps its session token in localStorage. They are not permanent accounts.

Each round stores `wordsAvailable` separately from submitted answers.
These are the words offered to each participating player (25 by default), generated once at round start,
even if they never submit. Players receive independent random subsets; overlap is allowed.
`answers[].words` contains the words actually submitted, in sentence order, linked by `answers[].playerId`.

**Current limitations:**
- Connections and ready status are not persisted in the database.
- Automatic game restoration on server startup is not implemented (function to use at gameRepository.ts -> getGame(id)).
- Reconnection after a server restart is not supported yet.

## Word list and dealing

`server/words.txt` is the vocabulary source, with one word per line.
Edit the text file and restart the server to reload it.
Each player gets `wordsPerPlayer` randomly selected words per round (25 by default), sampled without replacement
from the list. There are no word-category quotas; players receive independent hands.

## Game settings

Edit `settings.json` in the project root and restart the server to apply changes.
The server validates settings on startup and sends the values needed by the player UI.

| Setting | Default | Meaning |
| --- | --- | --- |
| `wordsPerPlayer` | 25 | Words dealt to each player per round; cannot exceed the word list length. |
| `minPlayersToStart` | 3 | Connected players required to start a round. |
| `maxPlayersPerRoom` | 20 | Room capacity, including disconnected players until they are removed. |
| `roomCount` | 20 | Number of rooms, from AAAA onwards; maximum 26. |
| `visibleEmptyRoomCount` | 2 | Empty rooms offered in room selection; occupied rooms stay visible. |
| `disconnectGraceMs` | 15000 | Milliseconds to retain the host role and wait for a disconnected player's round actions. |
| `disconnectPurgeMs` | 300000 | Milliseconds before removing a disconnected player. |

All values must be positive integers. The minimum player count cannot exceed room capacity,
the visible empty room count cannot exceed the room count, and the purge delay must be at
least the grace delay. Timer delays cannot exceed 2147483647 milliseconds.
Unknown settings are rejected to catch typos.

For Docker, rebuild and recreate the game container after editing `settings.json`
(`pnpm docker:dev` locally, or the production deployment command below).
Credentials and deployment environment variables stay in `.env`.

## Bots

Bots are server-side virtual players (`isBot: true`, no socket) in `server/bots/`. They act through the
same handlers as sockets, so answer validation, ranking validation, timers and scoring are unchanged.
Players see a BOT badge next to every bot (lobby, room settings, results), and the host can
turn bots off for their room in Room settings. Bots then leave between rounds and stay away
until the room empties; an empty room starts with bots allowed again.

- **Background rooms:** at startup, 3–4 random rooms are filled with bots. While no human is in them,
  bots mostly sit in the lobby, occasionally start and play a round, and their number drifts slowly.
- **Assisting humans:** when one or two humans wait in a room, bots join one at a time after a random
  delay until the room is playable (3–4 participants). As more humans arrive, bots leave one at a time;
  with `minPlayersToStart` humans present, all of them leave. Bots only join or leave in the lobby,
  never during a round.
- **Host:** a bot hosts only while no human is connected; a joining or reconnecting human takes over
  immediately. Hosts cannot hand the role to a bot, and locking a room needs 3 connected humans.
- **Answers:** at round start each bot plans its answer and is dealt a hand containing those words.
  Sources: collected human answers from earlier rounds (preferred, least-used first, never by anyone in
  the room, not reused within the cooldown, never twice in one round), the preset pool in
  `server/bots/pregeneratedAnswers.json` (words must exist in `words.txt`; the tests check this),
  or random words from the hand. Rankings are random permutations.

### Bot settings

`bot_settings.json` in the project root; validated at startup like `settings.json`. Ranges are `{ "min", "max" }`
and a random value in that range is picked each time.

| Setting | Meaning |
| --- | --- |
| `enabled` | Turns bots off entirely. |
| `backgroundRooms`, `backgroundBotsPerRoom` | How many rooms bots keep alive, and how many bots each. |
| `backgroundRoundIntervalMs`, `backgroundRetargetIntervalMs` | Pause between autonomous rounds; how often a background room re-rolls its bot count. |
| `maxBotOnlyRoundsPerSession` | A bot-only session starts a fresh game after this many rounds. |
| `assistTargetPlayers` | Total participants bots fill a room up to while humans are short. |
| `assistDelayMs`, `joinGapMs`, `leaveGapMs` | Wait before the first assisting bot; gaps between later joins and between leaves. |
| `answerDelayMs`, `rankingDelayMs`, `readyDelayMs` | How long a bot takes for each step. |
| `catchUpDelayMs` | Used instead once every human has finished the step, so they are not kept waiting. |
| `deadlineSafetyMs` | Bots always act at least this long before the phase timer ends. |
| `randomAnswerWords` | Length of random-word answers. |
| `reusedAnswerChance` | Chance a round uses collected human answers when there are any. |
| `pregeneratedAnswerChance` | Otherwise, chance of a preset answer instead of random words. |
| `reuseCooldownMs` | A collected answer is not reused again within this time. |
| `minReusableAnswerWords` | Shorter human answers are not collected. |
| `emoteChance` | Chance of a bot emote when it joins or after results (only with humans present). |
| `greetingReplyChance`, `greetingReplyDecay` | Chance one bot greets back when a human greets; multiplied by the decay for each further greeting from that human. |
| `waitingEmoteChance` | Chance a bot that has answered sends "Hurry up" or "Ready" while others are still answering. |
| `emoteReplyDelayMs`, `waitingEmoteDelayMs` | How long before those emotes are sent. |

### Bots and the research data

Every answer has an internal provenance: `human_original`, `bot_pregenerated`, `bot_random` or `bot_reused_human`.

| Round | `wordgame.games` | Elsewhere |
| --- | --- | --- |
| Humans only | Stored exactly as before (no new fields). | – |
| Bots presented only reused human answers | Stored, with `research: { botAssisted: true, eligible: true }`, every answer's `provenance` (plus `reusedFrom`: reusable answer id, original author id, original round id) and every ranking's `isBot`. | – |
| Any pre-generated or random bot answer | Left out; listed in the game's `excludedRounds`. | `wordgame.synthetic_rounds`, marked `eligible: false`, with the same provenance fields. |
| No humans | Left out; listed in `excludedRounds`. | Not stored. |

When rounds are left out, the stored `state.totals` only count the stored rounds. Bots appear in
`state.players` with `isBot: true`. Round ids are `<gameId>:<roundNumber>`.

Human answers from any bot-assisted round go to `wordgame.reusable_answers` once the round completes:
`prompt`, `words` (in order), `authorId`, `sourceGameId`, `sourceRoundNumber`, `sourceRoundId`,
`sourceAnswerId`, `collectedAt`, `usageCount` and `lastUsedAt`. The `_id` is a hash of author, prompt
and words, so the same answer is stored once. The pool is loaded at startup and survives restarts;
answers whose words were since removed from `words.txt` are skipped. If an author joins a room after
bots have already picked their answer, the server hides that answer from them.

## Admin mode

Admins are listed only on the server, in `ADMIN_IDS` in `.env` (comma-separated), and the server
must be restarted after a change. Each entry is either:

- the **participant ID**: the full 64-character ID. Preferred, because it cannot be used to log in.
  The bar at the top of the page shows its first 12 characters; the full ID is the matching `_id`
  in `wordgame.participants`.
- the **session token**: the UUID in the browser's `localStorage` under `sessionToken`
  (developer tools → Application → Local Storage). Treat it like a password.

Admin status belongs to the browser session: clearing site data creates a new identity.
A session is recognised only after its token passes the normal consent check, and the server
checks every admin request again. Regular players receive no admin data or events, and the page
contains no admin markup. The admin script is a separate file that the browser only downloads
once the server has recognised an admin.

The 🛡 Admin button (bottom left) opens the panel:

- **Site totals:** participants online (in a room or not), in rooms, choosing a room, bots,
  open connections including the consent screen, and admins online.
- **Rooms:** every room with its phase, humans and bots, lock, watchers and paused bots.
  The selected room shows its prompt, timer, players (human or bot, participant ID, host,
  connection and round progress, score) and the answers submitted this round with their provenance.
- **Watch invisibly:** shows the room's game screen without joining it. The admin is not in the
  player list or player counts, and cannot act or emote. **Exit** or **Stop watching** ends it.
- **Moderation:** make any connected player host, kick, or kick and block from that room for an
  hour (kept in memory only); lock or unlock any room regardless of player count (an admin lock
  is not lifted automatically when players leave); start a round; end the current phase early
  (as if its timer ran out); abandon a round; pause bots in one room or everywhere.
- **Announcements:** a banner message to one room or to everyone online.
- **Locked rooms:** admins can join them from the room list.
- **Badges:** while admin tools are shown, humans get a HUMAN badge, and bot answers in the
  results show where they came from (preset, random words or reused human answer).
- **Hide admin tools** removes the panel, badges and lock bypass from the screen, for demos.
  Bring them back with the faint dot in the bottom-left corner or **Ctrl+Shift+A**.
  The server remembers the choice until it restarts.

Every admin action is logged to the console and to `wordgame.admin_actions`
(`adminId`, `action`, `roomId`, `targetPlayerId`, `details`, `at`), separate from the research data.
If an admin plays as a regular participant, their rounds are recorded like everyone else's.

## Running locally

requires [Node.js](https://nodejs.org/), [pnpm](https://pnpm.io/), and [Docker](https://www.docker.com/).

First install the dependencies:

```bash
pnpm install
```

create your local environment file from the provided example (or add missing environment variables to your existing `.env`):

```bash
cp .env.example .env
```

Then start the database and development server:

```bash
pnpm db
pnpm dev
```

Then open:

- Player: [http://localhost:5173](http://localhost:5173)

`pnpm dev` prints a QR code and LAN address automatically. Connect your phone to
the same Wi-Fi and scan the code to open the game over HTTP on port 5173.
You can print it again with `pnpm dev:qr`. Session tokens also work over LAN HTTP,
using cryptographically random UUIDs when the browser's `randomUUID` API is unavailable.
Vite keeps port 5173 fixed so the QR code always matches the development server.
The game server itself (port 3000) only listens on `127.0.0.1` outside Docker; Vite forwards to it.


### Checks

```bash
pnpm typecheck   # TypeScript, client and server
pnpm test        # server tests (node:test), no database needed
```

### Database commands

```bash
pnpm db          # Start MongoDB (reachable at 127.0.0.1:27017 for pnpm dev)
pnpm db:stop     # Stop MongoDB
pnpm db:logs     # View MongoDB logs
pnpm docker:dev  # Build and run the production container locally at http://localhost:3000
```

These commands apply `compose.dev.yaml`, which is the only place ports are published, and only on `127.0.0.1`.
Running plain `docker compose up` on a development machine recreates MongoDB without its port; run `pnpm db` again to get it back.

## Deployment

On the server, with production values in `.env` (see `.env.example`):

```bash
docker compose --profile production up -d --build
```

Use only `compose.yaml` here, never `compose.dev.yaml`. No port is published: the Cloudflare tunnel is the only way in.
In the Cloudflare dashboard, the tunnel's public hostname must point to the service `http://game:3000`.
MongoDB is only reachable inside Docker, e.g. `docker compose exec mongo mongodump ...` for backups.

`.dockerignore` keeps `.env` and other local files out of the image; settings reach the containers through compose at runtime.

MongoDB data is stored in a persistent Docker volume, so stopping or rebuilding the container does not remove game data.

> ⚠ `docker compose down -v` removes Docker volumes and therefore deletes the local database.
