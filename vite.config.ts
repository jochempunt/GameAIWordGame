import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
    root: "client",
    build: {
        rollupOptions: {
            input: {
                player: fileURLToPath(new URL("./client/index.html", import.meta.url)),
                host: fileURLToPath(new URL("./client/host.html", import.meta.url)),
            },
        },
    },

    server: {
        host: "0.0.0.0",

        proxy: {
            "/socket.io": {
                // the game server only listens on IPv4 loopback in development
                target: "http://127.0.0.1:3000",
                ws: true,
            },
        },
    },
});
