## Server Data Diagram (so far)
<img width="800"  alt="server-state(2)" src="https://github.com/user-attachments/assets/a7199004-6368-44bd-af75-0020464bc4e0" />

> ⚠ so far the ranking and total scoring is not fully implemented yet, although referenced

## Server and Clients/Views
The server holds all game state. After every change it sends each client a
view of that state

Clients only render the latest view and
keep no game state of their own, so a refreshed phone, a reconnecting player,
or a host who opens the page late all get the current screen right away.


## Running locally

Requires [Node.js](https://nodejs.org/) and [pnpm](https://pnpm.io/).


then in a terminal run
```bash
pnpm install
pnpm dev
```

Then open:

Player: http://localhost:5173
Host: http://localhost:5173/host.html


> To easily connect phones on the same network, scan the QR code printed in the terminal.
