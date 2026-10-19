## Server Data Diagram (so far)

<img width="800" alt="server-state(2)" src="https://github.com/user-attachments/assets/a7199004-6368-44bd-af75-0020464bc4e0" />

> ⚠  game lifecycle (finishing a game etc.) and session recovery are not fully implemented yet... 

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
| `state.players` | `{ playerId, joinedAt, consent? }` (display names are not saved) |
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
These are the 25 words offered to each participating player, generated once at round start,
even if they never submit. Players receive independent random subsets; overlap is allowed.
`answers[].words` contains the words actually submitted, in sentence order, linked by `answers[].playerId`.

**Current limitations:**
- Connections and ready status are not persisted in the database.
- Automatic game restoration on server startup is not implemented (function to use at gameRepository.ts -> getGame(id)).
- Reconnection after a server restart is not supported yet.

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


### Database commands

```bash
pnpm db        # Start MongoDB
pnpm db:stop   # Stop MongoDB
pnpm db:logs   # View MongoDB logs
```

MongoDB data is stored in a persistent Docker volume, so stopping or rebuilding the container does not remove game data.

> ⚠ `docker compose down -v` removes Docker volumes and therefore deletes the local database.
