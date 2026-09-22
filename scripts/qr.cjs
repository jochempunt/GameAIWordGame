const os = require("node:os");
const qrcode = require("qrcode-terminal");

const interfaces = os.networkInterfaces();

let address;

for (const networkInterface of Object.values(interfaces)) {
    if (!networkInterface) continue;

    for (const info of networkInterface) {
        if (info.family === "IPv4" && !info.internal) {
            address = info.address;
            break;
        }
    }

    if (address) break;
}

if (!address) {
    console.error("Could not find LAN IP");
    process.exit(1);
}

const url = `http://${address}:5173`;

console.log(`\nPlayer URL: ${url}\n`);

qrcode.generate(url, { small: true });