## Server Data Diagram (so far)

<img width="800" alt="server-state(2)" src="https://github.com/user-attachments/assets/a7199004-6368-44bd-af75-0020464bc4e0" />

> ⚠ So far, ranking and total scoring are not fully implemented yet, although referenced.

## Server and Clients/Views

The server holds all game state. After every change, it sends each client a
view of that state.

Clients only render the latest view and keep no game state of their own.
This means a refreshed phone, reconnecting player, or host who opens the page
late gets the current screen right away.

Game state is persisted in **MongoDB**, which runs in a Docker container.
During development the game runs normally with hot reload, while only the
database needs to run in Docker.

## Running locally

Requires [Node.js](https://nodejs.org/), [pnpm](https://pnpm.io/), and
[Docker](https://www.docker.com/).

First install the dependencies:

```bash
pnpm install
```

Create your local environment file from the provided example: (or add missing env variables to your existing .env)

```bash
cp .env.example .env
```

Then start the database and development server:

```bash
pnpm db
pnpm dev
```

Then open:

- Player: http://localhost:5173
- Host: http://localhost:5173/host.html 

> To easily connect phones on the same network, scan the QR code printed in the terminal.

### Database commands

```bash
pnpm db        # Start MongoDB
pnpm db:stop   # Stop MongoDB
pnpm db:logs   # View MongoDB logs
```

MongoDB data is stored in a persistent Docker volume, so stopping or rebuilding
the container does not remove game data.

> ⚠ `docker compose down -v` removes Docker volumes and therefore deletes the
> local database.

