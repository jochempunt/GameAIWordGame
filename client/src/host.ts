import { io } from "socket.io-client";
import QRCode from "qrcode";
import { HostView } from "../../server/types.js";

const socket = io();
socket.onAny((event, ...args) => console.log("host got:", event, args));

const statusText = document.querySelector<HTMLParagraphElement>("#status")!;

const playerList =document.querySelector<HTMLUListElement>("#players")!;
const hostStandings = document.querySelector<HTMLElement>("#host-standings")!;
const lobbyPlayers = document.querySelector<HTMLUListElement>("#lobby-players")!;

const startRoundButton =document.querySelector<HTMLButtonElement>("#start-round")!;

const hostLobby = document.querySelector<HTMLElement>("#host-lobby")!;

const hostPlaying =document.querySelector<HTMLElement>("#host-playing")!;


const promptText =document.querySelector<HTMLElement>("#host-prompt")!;

const hostResults = document.querySelector<HTMLElement>("#host-results")!;

const hostVoting =document.querySelector<HTMLElement>("#host-voting")!;


socket.on("connect", () => {
    statusText.textContent = "Connected as host";
    socket.emit("registerHost");
    socket.emit("getJoinAddress", async ({ address }: { address: string | null }) => {
        const canvas = document.querySelector<HTMLCanvasElement>("#join-qr")!;
        const link = document.querySelector<HTMLAnchorElement>("#join-url")!;
        const status = document.querySelector<HTMLElement>("#join-qr-status")!;
        canvas.hidden = true;
        link.hidden = true;
        const url = new URL("/", window.location.href);
        if (["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname)) {
            if (!address) {
                status.textContent = "No local network address found. Connect to Wi-Fi and reload.";
                return;
            }
            url.hostname = address;
        }
        link.href = url.href;
        link.textContent = url.href;
        link.hidden = false;
        try {
            await QRCode.toCanvas(canvas, url.href, { width: 180, margin: 4, errorCorrectionLevel: "M" });
            canvas.hidden = false;
            status.textContent = "Or open the address above on your phone.";
        } catch {
            status.textContent = "Couldn’t draw the QR code. Use the address above to join.";
        }
    });
});


socket.on("state", render);

function render(view: HostView): void {
    hostStandings.hidden = view.phase === "lobby";
    hostLobby.hidden = view.phase !== "lobby";
    hostPlaying.hidden = view.phase !== "answering";
    hostVoting.hidden = view.phase !== "ranking";
    hostResults.hidden = view.phase !== "results";
    
    promptText.textContent = view.prompt ? `RQ${view.round}: ${view.prompt}` : "";
    
    renderPlayers(view.players, view.phase);
    if (view.phase === "lobby") {
        lobbyPlayers.replaceChildren();
        for (const { playerInfo } of view.players) {
            const item = document.createElement("li");
            item.textContent = playerInfo.connected ? "👤 "+ playerInfo.name : `${playerInfo.name} — disconnected`;
            item.classList.toggle("disconnected", !playerInfo.connected);
            lobbyPlayers.appendChild(item);
        }
        if (view.players.length === 0) {
            const empty = document.createElement("li");
            empty.textContent = "Waiting for players to join…";
            lobbyPlayers.appendChild(empty);
        }
    }
}


function renderPlayers(players: HostView["players"], phase: HostView["phase"]): void {
    playerList.replaceChildren();
    const standings = [...players].sort((a, b) => b.score - a.score);
    if (standings.length === 0) {
        const empty = document.createElement("li");
        empty.classList.add("standings-empty");
        empty.textContent = "Waiting for our first researchers…";
        playerList.appendChild(empty);
        return;
    }
    let rank = 1;
    for (const [index, player] of standings.entries()) {
        if (index > 0 && player.score !== standings[index - 1].score) rank = index + 1;
        const item = document.createElement("li");
        const position = document.createElement("span");
        position.classList.add("leaderboard-rank");
        position.textContent = `${rank}.`;
        const identity = document.createElement("div");
        identity.classList.add("researcher-identity");
        const name = document.createElement("span");
        name.classList.add("leaderboard-name");
        name.textContent = player.playerInfo.name;
        identity.appendChild(name);
        const progress = !player.playerInfo.connected ? "Disconnected"
            : phase === "answering" ? (player.answered ? "Answer submitted" : "Thinking…")
            : phase === "ranking" ? (player.ranked ? "Review submitted" : "Reviewing…") : "";
        if (progress) {
            const status = document.createElement("span");
            status.classList.add("researcher-status");
            status.textContent = progress;
            identity.appendChild(status);
        }
        const score = document.createElement("span");
        score.classList.add("result-score");
        score.textContent = `${player.score} pts`;
        item.append(position, identity, score);
        item.classList.toggle("disconnected", !player.playerInfo.connected);
 
        playerList.appendChild(item);
    }
}

startRoundButton.addEventListener(
    "click",
    () => {
        console.log("Start button clicked");
        socket.emit("startRound");
    }
);
