## Server Data Diagram (so far)

<img width="800" alt="server-state(2)" src="https://github.com/user-attachments/assets/a7199004-6368-44bd-af75-0020464bc4e0" />


## Server and Clients/Views

The server holds all game state. After every change, it sends each client a view of that state.

Clients only render the latest view and keep no game state of their own.
This means a refreshed phone, reconnecting player, or host who opens the page late gets the current screen right away, as long as the server is still running.

Game state is persisted in **MongoDB**, which runs in a Docker container.
During development the game runs normally with hot reload, while only the database needs to run in Docker.

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

Phones on the same Wi-Fi connect through the Vite dev server on port 5173 (`pnpm dev:qr` prints the address).
The game server itself (port 3000) only listens on `127.0.0.1` outside Docker; Vite forwards to it.


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
