import { defineConfig } from "vite";

export default defineConfig({
    root: "client",

    server: {
        host: "0.0.0.0",

        proxy: {
            "/socket.io": {
                target: "http://localhost:3000",
                ws: true,
            },
        },
    },
});